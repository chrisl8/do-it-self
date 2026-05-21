#!/usr/bin/env python3
"""Compute what each borg exclude pattern actually matches under the
configured BORG_BACKUP_PATHS, so the coverage audit can surface excludes
that are doing more (or less) than the operator expects.

Closes the visibility gap that previously hid two real bugs:
  - the `*/container-mounts/jellyfin/` rule silently dropped 92 GiB of
    home_videos/ + random/ (precious family video history).
  - the `*/Documents/` rule silently dropped 42 GiB of Nextcloud user
    Documents folders for five family members.

Called from scripts/backup-coverage-audit.sh as:
    check-exclude-matches.py PATH:PATH:... /path/to/exclude-patterns.txt

Outputs a single JSON object on stdout:
  {
    "exclude_patterns": [
      {"pattern": "...", "match_count": N, "samples": [paths...],
       "status": "active"|"idle"},
      ...
    ]
  }

Pattern semantics match borg's default `fm:` style: Python fnmatch,
where `/` is not special and `*` matches across path separators.
"""
import fnmatch
import json
import os
import re
import sys

MAX_SAMPLES_PER_PATTERN = 20


def load_patterns(exclude_file_path):
    patterns = []
    with open(exclude_file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)
    return patterns


_COMPILED = {}


def _compile(pattern):
    """Cache fnmatch→regex compilation. fnmatch.fnmatch has an LRU cache
    but it's keyed on (pattern, name) — for our walk-every-path workload
    we want the compile to happen once per pattern, not once per name."""
    r = _COMPILED.get(pattern)
    if r is None:
        r = re.compile(fnmatch.translate(pattern))
        _COMPILED[pattern] = r
    return r


def pattern_matches(path, pattern, is_dir):
    """Test a path against a borg fm-style pattern.

    Borg's default style treats `/` as ordinary in fnmatch and accepts
    patterns with or without trailing `/`. We test both forms so a
    pattern like `*/jellyfin/shows/` still matches a directory path
    that doesn't have a trailing slash (which is how os.walk emits them).
    """
    r = _compile(pattern)
    if r.match(path):
        return True
    if is_dir:
        if r.match(path + "/"):
            return True
        if pattern.endswith("/") and _compile(pattern[:-1]).match(path):
            return True
    return False


def walk_and_match(backup_paths, patterns):
    """Walk each backup path, record which patterns match what.

    When a directory matches any pattern, record the match and prune
    descent into it (borg wouldn't archive its contents, so we don't
    need to inspect them further).
    """
    matches = {p: [] for p in patterns}

    for backup_path in backup_paths:
        backup_path = backup_path.rstrip("/") or "/"
        if not os.path.isdir(backup_path):
            continue

        # topdown=True so we can mutate dirnames to prune the descent
        try:
            walker = os.walk(backup_path, topdown=True, followlinks=False)
        except OSError:
            continue

        for dirpath, dirnames, filenames in walker:
            # Test child directories. We test BEFORE descending, and
            # remove matched children from dirnames so os.walk skips
            # them — saves walking node_modules etc.
            kept_dirnames = []
            for d in dirnames:
                child = os.path.join(dirpath, d)
                matched_any = False
                for p in patterns:
                    if pattern_matches(child, p, is_dir=True):
                        if len(matches[p]) < MAX_SAMPLES_PER_PATTERN * 100:
                            matches[p].append(child)
                        matched_any = True
                        break  # one pattern matching is enough
                if not matched_any:
                    kept_dirnames.append(d)
            # Mutate in place — this controls os.walk's recursion
            dirnames[:] = kept_dirnames

            # Test files at this level
            for f in filenames:
                fp = os.path.join(dirpath, f)
                for p in patterns:
                    if pattern_matches(fp, p, is_dir=False):
                        if len(matches[p]) < MAX_SAMPLES_PER_PATTERN * 100:
                            matches[p].append(fp)
                        break

    return matches


def build_report(patterns, matches):
    out = []
    for p in patterns:
        m = matches.get(p, [])
        out.append({
            "pattern": p,
            "match_count": len(m),
            "samples": m[:MAX_SAMPLES_PER_PATTERN],
            "status": "active" if m else "idle",
        })
    return {"exclude_patterns": out}


def main():
    if len(sys.argv) < 3:
        print(
            "usage: check-exclude-matches.py <path1:path2:...> <exclude-file>",
            file=sys.stderr,
        )
        sys.exit(2)
    backup_paths = [p for p in sys.argv[1].split(":") if p]
    exclude_file = sys.argv[2]

    patterns = load_patterns(exclude_file)
    matches = walk_and_match(backup_paths, patterns)
    report = build_report(patterns, matches)
    json.dump(report, sys.stdout)


if __name__ == "__main__":
    main()
