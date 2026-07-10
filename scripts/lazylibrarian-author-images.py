#!/usr/bin/env python3
"""
LazyLibrarian author-portrait fetcher — set real author photos from Wikidata /
OpenLibrary, bypassing LazyLibrarian's junk image crawl.

Background: LazyLibrarian's only in-app source for author images is the
GoodReads author XML API (author/show/{id}.xml), which has returned HTTP 401
"Invalid API key" ever since GoodReads retired its API in 2020. With no real
source, LazyLibrarian falls back to a blind Baidu/Bing/Google *image search*
that caches whatever it finds first — book covers, ads, stock art, random
people — as the author "portrait". That crawl is disabled in the container
(recon/config-defaults/lazylibrarian-cont-init.d/30-disable-image-search.sh), so
authors default to the nophoto placeholder. This script is how they get a real
photo instead.

For each author still on the placeholder it:
  1. looks the name up on OpenLibrary (authors API -> photos[]), and if that has
     nothing, on Wikidata (must be an instance-of human with a P18 image);
  2. downloads the portrait into <config>/cache/author/<random>.jpg|png;
  3. points that author's AuthorImg at the cached file.
Authors with no photo on either source are left on the placeholder — never a
junk fallback. Existing author photos are not touched unless --all is given.

Runs on the host as the owner of the DB + cache (chrisl8); LazyLibrarian can
stay running (a handful of single-row UPDATEs under WAL). Safe to run
repeatedly; a no-op once every author that has a findable photo has one.

Usage:
  scripts/lazylibrarian-author-images.py               # fill missing photos
  scripts/lazylibrarian-author-images.py --report-only # show what it would do
  scripts/lazylibrarian-author-images.py --all         # also re-fetch existing
"""
import os
import random
import sqlite3
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Stable host mounts (same DB the reconciler uses).
DB_PATH = "/mnt/ssd-4tb/container-mounts/recon/lazylibrarian/config/lazylibrarian.db"
CACHE_AUTHOR = "/mnt/ssd-4tb/container-mounts/recon/lazylibrarian/config/cache/author"
PLACEHOLDER = "images/nophoto.png"
UA = "lazylibrarian-author-portrait-fetch/1.0 (personal self-host)"
WD_DELAY = 1.5  # seconds between Wikidata API calls (be polite; avoid HTTP 429)
MIN_BYTES = 1500  # reject 1x1 / empty placeholder images

# Wikidata occupation QIDs that indicate an author (writer/novelist/poet/etc.).
WRITER_OCC = {
    "Q36180", "Q482980", "Q6625963", "Q49757", "Q214917", "Q28389",
    "Q4853732", "Q18844224", "Q1930187", "Q11774202", "Q12144794", "Q3579035",
}


def http_get(url, throttle=False, tries=4):
    """GET bytes with a UA, optional pre-throttle, and 429 backoff."""
    for attempt in range(tries):
        if throttle:
            time.sleep(WD_DELAY)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code == 429 and attempt < tries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise
    return b""


def get_json(url, throttle=False):
    import json
    return json.loads(http_get(url, throttle=throttle).decode("utf-8", "replace"))


def openlibrary_photo(name):
    """Return an OpenLibrary portrait URL for an exact name match, or None."""
    url = "https://openlibrary.org/search/authors.json?q=" + urllib.parse.quote(name)
    for doc in get_json(url).get("docs", [])[:5]:
        if doc.get("name", "").lower() != name.lower():
            continue
        key = doc.get("key")
        if not key:
            continue
        rec = get_json("https://openlibrary.org/authors/%s.json" % key)
        photos = [p for p in (rec.get("photos") or []) if p and p != -1]
        if photos:
            return "https://covers.openlibrary.org/a/id/%s-M.jpg" % photos[0]
    return None


def _wd_claim_ids(claims, prop):
    ids = []
    for c in claims.get(prop, []):
        try:
            ids.append(c["mainsnak"]["datavalue"]["value"]["id"])
        except (KeyError, TypeError):
            pass
    return ids


def wikidata_photo(name):
    """Return a Wikimedia Commons portrait URL for a human author, or None."""
    search = ("https://www.wikidata.org/w/api.php?action=wbsearchentities"
              "&search=%s&language=en&type=item&limit=5&format=json"
              % urllib.parse.quote(name))
    best = None
    for cand in get_json(search, throttle=True).get("search", [])[:3]:
        claims = get_json(
            "https://www.wikidata.org/w/api.php?action=wbgetclaims"
            "&entity=%s&property=P18|P31|P106&format=json" % cand["id"],
            throttle=True,
        ).get("claims", {})
        if "Q5" not in _wd_claim_ids(claims, "P31"):  # must be a human
            continue
        filename = None
        for c in claims.get("P18", []):
            try:
                filename = c["mainsnak"]["datavalue"]["value"]
                break
            except (KeyError, TypeError):
                pass
        if not filename:
            continue
        fn = urllib.parse.quote(filename.replace(" ", "_"))
        url = "https://commons.wikimedia.org/wiki/Special:FilePath/%s?width=400" % fn
        if set(_wd_claim_ids(claims, "P106")) & WRITER_OCC:
            return url  # prefer a confirmed writer
        best = best or url
    return best


def save_image(data):
    """Write image bytes to the author cache, return the LL-relative coverlink."""
    os.makedirs(CACHE_AUTHOR, exist_ok=True)
    ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
    stem = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(10))
    with open(os.path.join(CACHE_AUTHOR, stem + ext), "wb") as f:
        f.write(data)
    return "cache/author/%s%s" % (stem, ext)


def main():
    report_only = "--report-only" in sys.argv
    do_all = "--all" in sys.argv

    db = sqlite3.connect(DB_PATH)
    if do_all:
        rows = db.execute("SELECT AuthorID, AuthorName FROM authors ORDER BY AuthorName").fetchall()
    else:
        rows = db.execute(
            "SELECT AuthorID, AuthorName FROM authors "
            "WHERE AuthorImg IS NULL OR instr(AuthorImg, 'nophoto') > 0 "
            "ORDER BY AuthorName"
        ).fetchall()

    if not rows:
        print("No authors need a photo. Nothing to do.")
        return 0

    set_count = 0
    for aid, name in rows:
        source, url = None, None
        try:
            url = openlibrary_photo(name)
            source = "openlibrary" if url else None
            if not url:
                url = wikidata_photo(name)
                source = "wikidata" if url else None
        except Exception as err:  # network/API hiccup -> skip, stay on placeholder
            print("%-28s | ERROR %s: %s" % (name, type(err).__name__, err))
            continue

        if not url:
            print("%-28s | no photo found (stays on placeholder)" % name)
            continue

        try:
            data = http_get(url)
        except Exception as err:
            print("%-28s | download ERROR %s (stays on placeholder)" % (name, type(err).__name__))
            continue
        if len(data) < MIN_BYTES:
            print("%-28s | image too small, skipped" % name)
            continue

        if report_only:
            print("%-28s | would set from %s" % (name, source))
            continue

        coverlink = save_image(data)
        db.execute("UPDATE authors SET AuthorImg=? WHERE AuthorID=?", (coverlink, aid))
        db.commit()
        set_count += 1
        print("%-28s | set from %-11s -> %s" % (name, source, coverlink))

    if not report_only:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        print("\nSet %d author %s." % (set_count, "photo" if set_count == 1 else "photos"))
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
