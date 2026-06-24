#!/usr/bin/env python3
"""
LazyLibrarian reconciler — file IRC/direct downloads that LazyLibrarian's
post-processor failed to import.

Background: LazyLibrarian's IRC (#ebooks / DCC) and direct downloads land
reliably in its download_dir, but the post-processor only auto-imports about
half (a snatch-tracking race in LazyLibrarian itself). The rest are orphaned in
the download dir and the books quietly revert to Skipped, so a requested book
silently never shows up. There is no way to notice this without polling the
folder, which nobody does.

This runs on a cron. For every ebook left sitting in the download dir it:
  1. matches it to a book — deterministically via the `wanted` table
     (NZBtitle -> BookID), or by a strict title-in-filename fallback;
  2. copies it into the library as <ebook_dir>/<Author>/<Title>/<Title> - <Author>.<ext>;
  3. marks the book Open with that BookFile;
  4. removes the download copy.
Anything it can't confidently match is left in place and reported to
healthchecks.io (/fail) so the rare odd case surfaces instead of vanishing.

Runs as the owner of the files + DB (chrisl8). Only touches files that have sat
for a few minutes, so LazyLibrarian's own post-processor gets first crack and we
only clean up its misses. Safe to run repeatedly; a no-op when the dir is empty.
"""
import os
import re
import shutil
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

# Container path /media/arr -> host; /config -> host. These are stable mounts.
DB_PATH = "/mnt/ssd-4tb/container-mounts/recon/lazylibrarian/config/lazylibrarian.db"
DOWNLOAD_HOST = "/mnt/22TB/container-mounts/recon/data/media/lazylibrarian-downloads"
EBOOKS_HOST = "/mnt/22TB/container-mounts/recon/data/media/ebooks"
EBOOKS_CONTAINER = "/media/arr/ebooks"  # what LazyLibrarian stores in BookFile
CONF_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "healthcheck.conf")
LOG_PATH = os.path.expanduser("~/logs/lazylibrarian-reconcile.log")
EBOOK_EXTS = (".epub", ".mobi", ".azw3", ".pdf")
MIN_AGE_SECONDS = 300  # leave fresh files alone (mid-transfer / LL's own pass)


def log(msg):
    line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {msg}"
    print(line)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def hc_url():
    try:
        with open(CONF_PATH, encoding="utf-8") as fh:
            for raw in fh:
                if raw.startswith("RECONCILE_HEALTHCHECK_URL="):
                    return raw.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def hc_ping(suffix="", body=""):
    base = hc_url()
    if not base:
        return
    try:
        data = body.encode("utf-8")[:10000] if body else None
        urllib.request.urlopen(urllib.request.Request(base + suffix, data=data), timeout=10)
    except (urllib.error.URLError, OSError):
        pass


def norm(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def find_entries(root):
    """Return (entry_path, ebook_file_path) for each download. An entry may be a
    bare ebook file or a 'name.ext/' dir containing the ebook."""
    found = []
    for name in sorted(os.listdir(root)):
        entry = os.path.join(root, name)
        if os.path.isfile(entry) and entry.lower().endswith(EBOOK_EXTS):
            found.append((entry, entry))
        elif os.path.isdir(entry):
            inner = None
            for dirpath, _dirs, files in os.walk(entry):
                cands = sorted(f for f in files if f.lower().endswith(EBOOK_EXTS))
                if cands:
                    inner = os.path.join(dirpath, cands[0])
                    break
            if inner:
                found.append((entry, inner))
    return found


def recent(path):
    try:
        return (datetime.now().timestamp() - os.path.getmtime(path)) < MIN_AGE_SECONDS
    except OSError:
        return False


def match_bookid(cur, entry_name, base):
    # 1) deterministic: a wanted/snatch record whose download title is this file
    for cand in (entry_name, base):
        row = cur.execute(
            "SELECT BookID FROM wanted WHERE NZBtitle = ? ORDER BY rowid DESC LIMIT 1",
            (cand,),
        ).fetchone()
        if row and row["BookID"]:
            return row["BookID"]
    # 2) fallback: a not-yet-filed book whose title appears in the filename
    nf = norm(base)
    best = None
    for book in cur.execute(
        "SELECT BookID, BookName FROM books WHERE Status NOT IN ('Open','Have','Ignored')"
    ):
        nt = norm(book["BookName"])
        if len(nt) >= 6 and nt in nf and (best is None or len(nt) > best[1]):
            best = (book["BookID"], len(nt))
    return best[0] if best else None


def main():
    if not os.path.isdir(DOWNLOAD_HOST):
        log(f"download dir missing: {DOWNLOAD_HOST}")
        hc_ping("/fail", f"download dir missing: {DOWNLOAD_HOST}")
        return 1

    entries = [(e, f) for (e, f) in find_entries(DOWNLOAD_HOST) if not recent(f)]
    if not entries:
        hc_ping(body="ok: nothing to reconcile")
        return 0

    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    filed, dupes, unmatched = [], [], []
    for entry_path, epub_path in entries:
        base = os.path.basename(epub_path)
        entry_name = os.path.basename(entry_path)
        bookid = match_bookid(cur, entry_name, base)
        if not bookid:
            unmatched.append(base)
            log(f"UNMATCHED: {base}")
            continue
        book = cur.execute(
            "SELECT b.BookName, b.Status, b.BookFile, a.AuthorName "
            "FROM books b JOIN authors a ON b.AuthorID = a.AuthorID WHERE b.BookID = ?",
            (bookid,),
        ).fetchone()
        if not book:
            unmatched.append(base)
            log(f"UNMATCHED (no book row): {base}")
            continue
        # already filed elsewhere -> this download is a redundant copy
        if book["Status"] in ("Open", "Have") and book["BookFile"]:
            _remove(entry_path)
            dupes.append(book["BookName"])
            log(f"DUPLICATE (already filed), removed download: {base}")
            continue

        author = re.sub(r"[/\\]", "_", book["AuthorName"])
        title = re.sub(r"[/\\]", "_", book["BookName"])
        ext = os.path.splitext(epub_path)[1].lower()
        destdir = os.path.join(EBOOKS_HOST, author, title)
        destfile = os.path.join(destdir, f"{title} - {author}{ext}")
        try:
            os.makedirs(destdir, exist_ok=True)
            shutil.copy2(epub_path, destfile)
        except OSError as exc:
            unmatched.append(base)
            log(f"ERROR copying {base}: {exc}")
            continue
        bookfile = f"{EBOOKS_CONTAINER}/{author}/{title}/{title} - {author}{ext}"
        cur.execute("UPDATE books SET Status='Open', BookFile=? WHERE BookID=?", (bookfile, bookid))
        con.commit()
        _remove(entry_path)
        filed.append(f"{book['BookName']} ({book['AuthorName']})")
        log(f"FILED: {book['BookName']} <- {base}")

    con.close()
    summary = f"filed {len(filed)}, duplicates {len(dupes)}, unmatched {len(unmatched)}"
    log(f"run complete: {summary}")
    if unmatched:
        body = "Downloads the reconciler could not match to a book:\n" + "\n".join(unmatched)
        if filed:
            body += f"\n\nFiled OK this run: {len(filed)}"
        hc_ping("/fail", body)
    else:
        hc_ping(body=f"ok: {summary}\n" + "\n".join(filed))
    return 0


def _remove(path):
    try:
        shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    except OSError as exc:
        log(f"warn: could not remove {os.path.basename(path)}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
