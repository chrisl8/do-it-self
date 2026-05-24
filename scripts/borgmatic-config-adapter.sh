#!/bin/bash
# borgmatic-config-adapter.sh — translate a borgmatic YAML config into the
# bash variables backup-coverage-audit.sh expects (BORG_BACKUP_PATHS
# array + BORG_EXCLUDE_FILE string). This lets the same audit script run
# on a borg-host (neuromancer) and a borgmatic-host (wintermute) with
# only a one-line difference in backup-coverage-audit.conf:
#
#     BORG_CONFIG_SOURCE="$HOME/containers/scripts/borgmatic-config-adapter.sh"
#
# This script is intended to be *sourced*, not executed. It reads
# borgmatic's config (path overridable via BORGMATIC_CONFIG env var,
# default ~/.config/borgmatic/config.yaml), synthesizes an effective
# exclude-patterns file, and sets the two variables the audit needs.
#
# Requires: python3 + PyYAML. On Arch/CachyOS:
#     sudo pacman -S python-yaml

BORGMATIC_CONFIG="${BORGMATIC_CONFIG:-$HOME/.config/borgmatic/config.yaml}"
if [ ! -r "$BORGMATIC_CONFIG" ]; then
    echo "[borgmatic-adapter] config not readable: $BORGMATIC_CONFIG" >&2
    return 1 2>/dev/null || exit 1
fi

# Stable per-host tempdir so cron runs reuse the same paths (we rewrite
# the contents every run anyway). $$ would churn paths and leave stale
# files behind.
__adapter_dir="${TMPDIR:-/tmp}/borgmatic-coverage-adapter"
mkdir -p "$__adapter_dir"
__paths_out="$__adapter_dir/source-directories.txt"
__excludes_out="$__adapter_dir/effective-exclude-patterns.txt"

python3 - "$BORGMATIC_CONFIG" "$__paths_out" "$__excludes_out" <<'PYEOF'
"""Parse borgmatic config; emit source dirs (one per line) + effective
exclude patterns (synthesized from inline patterns and exclude_from files)."""
import os
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "[borgmatic-adapter] PyYAML not installed. On Arch: sudo pacman -S python-yaml\n"
    )
    sys.exit(2)

cfg_path, paths_out, excludes_out = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cfg_path) as f:
    cfg = yaml.safe_load(f) or {}


def cfg_get(key, default=None):
    """Borgmatic 1.7+ uses a flat top-level config; earlier versions nest
    everything under `location:` / `storage:` / etc. Try both."""
    if key in cfg:
        return cfg[key]
    for section in ("location", "storage", "retention", "consistency", "hooks"):
        sub = cfg.get(section)
        if isinstance(sub, dict) and key in sub:
            return sub[key]
    return default


sources = cfg_get("source_directories") or []
with open(paths_out, "w") as f:
    for s in sources:
        f.write(str(s) + "\n")

# Borgmatic supports both inline `exclude_patterns:` and external
# `exclude_from:` files (a list of file paths whose contents are added
# verbatim to borg's --exclude-from). We concatenate both into one
# synthesized file so the audit's pattern checker sees the same patterns
# borg would.
exclude_lines = []
for ef_path in cfg_get("exclude_from") or []:
    if os.path.isfile(ef_path):
        with open(ef_path) as ef:
            exclude_lines.extend(ef.readlines())
for p in cfg_get("exclude_patterns") or []:
    exclude_lines.append(str(p) + "\n")
with open(excludes_out, "w") as f:
    f.writelines(exclude_lines)

print(
    f"[borgmatic-adapter] parsed {len(sources)} source dir(s), "
    f"{len(exclude_lines)} exclude pattern(s)",
    file=sys.stderr,
)
PYEOF
if [ $? -ne 0 ]; then
    echo "[borgmatic-adapter] python helper failed" >&2
    return 1 2>/dev/null || exit 1
fi

# Populate the audit-expected variables.
BORG_BACKUP_PATHS=()
while IFS= read -r line; do
    [ -n "$line" ] && BORG_BACKUP_PATHS+=("$line")
done <"$__paths_out"

BORG_EXCLUDE_FILE="$__excludes_out"
