#!/usr/bin/env node
// Alerts when media people asked for is never going to arrive on its own.
//
// The failure mode this exists for is silent by construction. A series whose
// quality profile cannot match any release that exists searches, finds
// hundreds of candidates, rejects every one on "<quality> is not wanted in
// profile", and writes NOTHING to history -- no error, no Activity entry. The
// Good Place sat at 0/59 this way one day after being requested; 585 releases
// found, 0 usable. Nobody would have noticed until the requester complained,
// which historically takes weeks.
//
// Detection is deliberately based on OBSERVED behaviour, not a guess about what
// releases ought to exist. The older scripts/sonarr-stuck-series.js asks "could
// a 4K master plausibly exist for a show from this year?" and answers yes for
// anything after 2013 -- which is why it missed The Good Place (2016) and
// Infinity Train (2019) completely. Most post-2013 TV (network sitcoms,
// cartoons, BBC drama) never gets a 4K master either. So instead of predicting
// availability, this asks the question that needs no prediction:
//
//     has this had a fair chance to grab something, and grabbed nothing?
//
// That is free, needs no indexer traffic, and fires within hours of a bad
// request rather than after days of waiting.
//
//   ./media-stall-check.js              # report; exit 1 if anything is stalled
//   ./media-stall-check.js --all        # ignore the throttle, show everything
//   ./media-stall-check.js --no-confirm # skip indexer confirmation entirely
//   ./media-stall-check.js --quiet      # exit code only, for scripting
//   ./media-stall-check.js --no-purge   # skip the deleted-title cleanup
//   ./media-stall-check.js --purge-dry-run  # show what cleanup would remove
//
// It also cleans up after titles deliberately deleted in Jellyfin -- see
// purgeDeleted() below.
//
// Run from cron every few hours. It is silent (exit 0, no output) when nothing
// is stalled, so cron only mails you when there is something to do -- the same
// pattern as scripts/container-update-reminder.sh.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------- thresholds

// A brand-new request needs time for its automatic on-add search to run. Below
// this age we say nothing -- above it, zero files means zero excuses.
const GRACE_HOURS = Number(process.env.STALL_GRACE_HOURS ?? 12);

// Something that HAS files but is still missing aired episodes is a slower,
// murkier problem (usenet retention, missing articles, back catalog nobody has
// kicked). Give it a fortnight before nagging.
const STALE_DAYS = Number(process.env.STALL_STALE_DAYS ?? 14);

// Re-mention an already-reported item at most this often, so a genuinely
// unfixable title (1950s BBC live broadcast that no longer exists) does not
// email every single run forever.
const RENAG_DAYS = Number(process.env.STALL_RENAG_DAYS ?? 7);

// Confirming a suspect costs one real indexer search. That is the only way to
// tell "profile rejects everything" (a five-second fix) apart from "no releases
// exist at all" (nothing you can do) -- a distinction worth having in the
// email. But sweeping every suspect would hammer every indexer in Prowlarr and
// risk a ban, so it is capped per run and cached per title.
const MAX_CONFIRM = Number(process.env.STALL_MAX_CONFIRM ?? 2);
const CONFIRM_CACHE_DAYS = 7;

const STATE_DIR = `${process.env.HOME}/.local/state/containers`;
const STATE_FILE = `${STATE_DIR}/media-stall-check.json`;

// Every alert here expects a human decision, and some of those decisions are
// "nothing can be done" -- 1950s BBC live broadcasts that were never recorded,
// films with no 4K release that will never get one. Those must be silenceable
// permanently, or the real alerts drown in them. One entry per line in
// scripts/media-stall-check.conf, matched against either the internal key
// (tv:31, movie:21) or a case-insensitive substring of the title:
//
//     tv:31       # 1953 Quatermass -- only unparseable releases exist
//     movie:22    # 2005 BBC live remake, no 4K will ever exist
//     Woodsman
//
// Excluded items are still counted in the report footer, because an exclude
// list you cannot see is just a way to forget things.
const EXCLUDE_FILE = new URL("media-stall-check.conf", import.meta.url)
  .pathname;

const MOUNT = process.env.STALL_MOUNT ?? "/mnt/ssd-4tb";
const SONARR_CONFIG = `${MOUNT}/container-mounts/recon/sonarr/config/config.xml`;
const RADARR_CONFIG = `${MOUNT}/container-mounts/recon/radarr/config/config.xml`;
const SEERR_SETTINGS = `${MOUNT}/container-mounts/seerr/config/settings.json`;

const SONARR = "http://recon.jamnapari-goblin.ts.net:8989/api/v3";
const RADARR = "http://recon.jamnapari-goblin.ts.net:7878/api/v3";
const SEERR = "https://seerr.jamnapari-goblin.ts.net/api/v1";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const confirmEnabled = !args.includes("--no-confirm");
const quiet = args.includes("--quiet");
const purgeEnabled = !args.includes("--no-purge");
const purgeDryRun = args.includes("--purge-dry-run");

// Deleted-title cleanup. A delete must be this old before we act on it, so an
// accidental delete can still be undone by re-monitoring and re-searching.
const PURGE_GRACE_HOURS = Number(process.env.PURGE_GRACE_HOURS ?? 24);
// More candidates than this in one run looks like a mount outage or a mass
// accident, not a person tidying up -- refuse and shout instead.
const PURGE_MAX = Number(process.env.PURGE_MAX ?? 5);

// ---------------------------------------------------------------- primitives

function apiKeyFrom(path) {
  if (!existsSync(path)) return null;
  return (
    readFileSync(path, "utf8").match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1] ?? null
  );
}

function makeClient(base, key) {
  if (!key) return null;
  return async (path, options) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${base}/${path}${sep}apikey=${key}`, {
      signal: AbortSignal.timeout(120000),
      ...options,
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    // DELETE answers 200 with an empty body, which res.json() chokes on.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

const HOUR = 3600000;
const DAY = 86400000;
const now = Date.now();
const ageHours = (iso) => (iso ? (now - new Date(iso)) / HOUR : Infinity);
const ageDays = (iso) => (iso ? (now - new Date(iso)) / DAY : Infinity);
const days = (n) => (n === Infinity ? "never" : `${Math.round(n)}d`);

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { alerted: {}, confirmed: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadExcludes() {
  if (!existsSync(EXCLUDE_FILE)) return [];
  return readFileSync(EXCLUDE_FILE, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

function isExcluded(stall, excludes) {
  return excludes.some(
    (e) =>
      e.toLowerCase() === stall.key.toLowerCase() ||
      stall.title.toLowerCase().includes(e.toLowerCase()),
  );
}

// Ids that currently have something in the download queue. Sonarr and Radarr
// both paginate the same way and differ only in the id field name.
function queueIds(queue, field) {
  return new Set((queue?.records ?? []).map((r) => r[field]).filter(Boolean));
}

// Lowest quality a profile will accept, as a rough resolution number. A floor
// of 2160 is the shape that causes almost every stall we have seen: it means
// "4K or nothing", and most titles have no 4K master at any age.
function profileFloor(profile) {
  const allowed = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.quality && item.allowed) allowed.push(item.quality.name);
      if (item.items) walk(item.items);
    }
  };
  walk(profile.items ?? []);
  const res = (name) => {
    if (/2160/.test(name)) return 2160;
    if (/1080/.test(name)) return 1080;
    if (/720/.test(name)) return 720;
    if (/576|480|DVD|SDTV/i.test(name)) return 480;
    return 0;
  };
  const nums = allowed.map(res).filter(Boolean);
  return nums.length ? Math.min(...nums) : 0;
}

// --------------------------------------------------------------------- sonarr

async function collectSonarr(api) {
  const [series, profiles, missing, queue] = await Promise.all([
    api("series"),
    api("qualityprofile"),
    api("wanted/missing?pageSize=2000&monitored=true"),
    api("queue?pageSize=500"),
  ]);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const downloading = queueIds(queue, "seriesId");

  // wanted/missing is exactly "aired AND monitored AND has no file", which is
  // the only gap worth acting on. Raw statistics are misleading: Doctor Who
  // reads 15/749 but only 38 of those are actually wanted -- the rest are
  // unmonitored lost episodes that no amount of searching will produce.
  //
  // Season 0 is excluded, and that exclusion is doing a lot of work. Season 0 is
  // where TVDB files DVD extras and oddities -- "Mission Directive: Sanctuary",
  // "Set Tour with Martin Wood", "Diary of Rainbow Sun Francks" -- which were
  // never released as standalone files and never will be. Counting them made
  // Stargate Atlantis look like 100/155 with 53 wanted when it is actually
  // 100/100 and finished, and made 91 of a 105-episode "backlog" phantom. At 9
  // enabled indexers that is ~820 wasted queries per search pass, forever.
  const wanted = new Map();
  for (const ep of missing.records ?? []) {
    if (ep.seasonNumber === 0) continue;
    wanted.set(ep.seriesId, (wanted.get(ep.seriesId) ?? 0) + 1);
  }

  const stalls = [];
  for (const s of series) {
    if (!s.monitored) continue;
    const want = wanted.get(s.id) ?? 0;
    if (want === 0) continue;
    // Something in the download queue is not stalled, it is in progress -- and
    // it can legitimately stay there far longer than the grace period. The
    // Quatermass II pack was a 2.09 GB torrent on a single seed with a 19-hour
    // ETA; without this it would have paged the next morning while working
    // perfectly. A download that dies in the queue gets caught anyway, because
    // the queue entry disappears and the series falls back to having no files.
    if (downloading.has(s.id)) continue;

    const profile = byId.get(s.qualityProfileId);
    // Count regular seasons only, for the same reason Season 0 is dropped from
    // the wanted map: series-level statistics fold DVD extras into the totals,
    // so a finished show reads as incomplete forever.
    const regular = (s.seasons ?? []).filter((x) => x.seasonNumber > 0);
    const files = regular.reduce(
      (n, x) => n + (x.statistics?.episodeFileCount ?? 0),
      0,
    );
    const totalEps = regular.reduce(
      (n, x) => n + (x.statistics?.totalEpisodeCount ?? 0),
      0,
    );
    // Measure IMPORTS, not grabs. Grabbing is not progress -- a series stuck in
    // a grab -> fail -> blocklist loop grabs constantly and imports nothing, so
    // a grab-based freshness test sees it as healthy the entire time it is
    // drowning. Star Trek: Voyager grabbed ~2000 releases and imported 125 over
    // two days (2014 blocklist entries, 73% of the whole instance's blocklist)
    // and never once looked stale. eventType 3 is downloadFolderImported;
    // eventType 1 is grabbed, kept only to show the ratio in the report.
    const [grabs, imports] = await Promise.all([
      api(`history/series?seriesId=${s.id}&eventType=1`),
      api(`history/series?seriesId=${s.id}&eventType=3`),
    ]);
    const newest = (rows) =>
      rows.length
        ? rows
            .map((g) => g.date)
            .sort()
            .at(-1)
        : null;
    const lastGrab = newest(grabs);
    const lastImport = newest(imports);

    // A series that keeps grabbing but rarely imports is failing, however busy
    // it looks. Flag that on its own, before the staleness clock runs out --
    // otherwise the loop has to go quiet for a fortnight before anyone hears.
    const churn =
      grabs.length >= 20 && imports.length * 5 < grabs.length
        ? { grabs: grabs.length, imports: imports.length }
        : null;

    let tier = null;
    if (files === 0 && ageHours(s.added) > GRACE_HOURS) {
      tier = "NEVER";
    } else if (
      ageDays(lastImport) > STALE_DAYS &&
      ageHours(s.added) > GRACE_HOURS
    ) {
      tier = "STALLED";
    } else if (churn) {
      tier = "CHURNING";
    }
    if (!tier) continue;

    stalls.push({
      kind: "tv",
      key: `tv:${s.id}`,
      id: s.id,
      title: `${s.title} (${s.year})`,
      have: files,
      total: totalEps,
      want,
      profile: profile?.name ?? `#${s.qualityProfileId}`,
      floor: profile ? profileFloor(profile) : 0,
      added: s.added,
      lastGrab,
      lastImport,
      churn,
      tier,
      status: s.status,
    });
  }
  return { stalls, profiles };
}

// --------------------------------------------------------------------- radarr

async function collectRadarr(api) {
  const [movies, profiles, queue] = await Promise.all([
    api("movie"),
    api("qualityprofile"),
    api("queue?pageSize=500"),
  ]);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const downloading = queueIds(queue, "movieId");

  const stalls = [];
  for (const m of movies) {
    if (!m.monitored || m.hasFile) continue;
    if (downloading.has(m.id)) continue;
    // A movie with no digital or physical release yet is not stalled, it is
    // just early -- searching for it is guaranteed to find nothing.
    if (!m.isAvailable) continue;
    if (ageHours(m.added) <= GRACE_HOURS) continue;

    const profile = byId.get(m.qualityProfileId);
    // Same reasoning as the Sonarr side: imports are progress, grabs are not.
    const [grabs, imports] = await Promise.all([
      api(`history/movie?movieId=${m.id}&eventType=1`),
      api(`history/movie?movieId=${m.id}&eventType=3`),
    ]);
    const newest = (rows) =>
      rows.length
        ? rows
            .map((g) => g.date)
            .sort()
            .at(-1)
        : null;
    const lastGrab = newest(grabs);
    const lastImport = newest(imports);
    const churn =
      grabs.length >= 20 && imports.length * 5 < grabs.length
        ? { grabs: grabs.length, imports: imports.length }
        : null;

    stalls.push({
      kind: "movie",
      key: `movie:${m.id}`,
      id: m.id,
      title: `${m.title} (${m.year})`,
      have: 0,
      total: 1,
      want: 1,
      profile: profile?.name ?? `#${m.qualityProfileId}`,
      floor: profile ? profileFloor(profile) : 0,
      added: m.added,
      lastGrab,
      lastImport,
      churn,
      tier: churn ? "CHURNING" : lastGrab ? "STALLED" : "NEVER",
      status: m.status,
    });
  }
  return { stalls, profiles };
}

// ---------------------------------------------------------------------- seerr

// Seerr is the reason to care: these are things a real person asked for and is
// quietly waiting on. It is not host-reachable on :5055 (internal docker net)
// but its Tailscale sidecar serves the same API over HTTPS.
async function collectSeerr() {
  let key;
  try {
    key = JSON.parse(readFileSync(SEERR_SETTINGS, "utf8")).main.apiKey;
  } catch {
    return null;
  }
  const get = async (path) => {
    const res = await fetch(`${SEERR}${path}`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`seerr ${path} -> HTTP ${res.status}`);
    return res.json();
  };
  try {
    const all = await get("/request?take=500&filter=all&sort=added");
    const MEDIA = {
      1: "unknown",
      2: "pending",
      3: "processing",
      4: "partial",
      5: "available",
    };
    return (all.results ?? [])
      .filter((r) => r.media?.status !== 5)
      .map((r) => ({
        req: r.id,
        who: r.requestedBy?.displayName ?? r.requestedBy?.email ?? "?",
        when: r.createdAt,
        type: r.type,
        state: MEDIA[r.media?.status] ?? String(r.media?.status),
        tvdbId: r.media?.tvdbId ?? null,
        tmdbId: r.media?.tmdbId ?? null,
      }));
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- confirm

// Rejections that mean "the profile refuses this quality" -- either the quality
// is outside the allowed range, or a custom format score puts it under the
// profile's minimum. These are the fixable ones.
const PROFILE_REJECTION =
  /not wanted in profile|below (?:Series|Movie) profile minimum|does not contain one of the required/i;

// "Unknown is not wanted in profile" reads like a profile rejection but is not
// one: Unknown means the *arr could not determine a quality from the release
// title at all. The 2005 Quatermass TV movie is nothing but these -- bare titles
// like "The Quatermass Experiment 2005" with no source, resolution or group. No
// widening of the quality range fixes that, and allowing Unknown would mean
// accepting literally any file, so these count as unparseable rather than
// blocked.
const UNKNOWN_QUALITY = /^Unknown is not wanted in profile/i;

// The definitive check, and the only one that costs anything: ask the indexers
// what exists, then see how much of it the profile will accept.
//   nothing found                    ->  no releases exist. Not fixable here.
//   all rejected on profile grounds  ->  profile trap. Repoint it, done.
//   all rejected for other reasons   ->  unparseable/mislabelled junk, not the
//                                        profile -- repointing would do nothing.
// Conflating the last two is how you get told to "fix" a profile the title is
// already on, so the distinction is drawn explicitly rather than assumed.
async function confirm(stall, sonarr, radarr) {
  try {
    let releases;
    if (stall.kind === "tv") {
      const series = await sonarr(`series/${stall.id}`);
      const season = series.seasons?.find(
        (s) =>
          s.seasonNumber > 0 &&
          s.statistics?.episodeFileCount < s.statistics?.totalEpisodeCount,
      );
      releases = await sonarr(
        `release?seriesId=${stall.id}&seasonNumber=${season?.seasonNumber ?? 1}`,
      );
    } else {
      releases = await radarr(`release?movieId=${stall.id}`);
    }
    const accepted = releases.filter((r) => !r.rejections?.length);
    const reasons = new Map();
    let profileBlocked = 0;
    for (const r of releases) {
      for (const rej of r.rejections ?? []) {
        reasons.set(rej, (reasons.get(rej) ?? 0) + 1);
      }
      if (
        r.rejections?.some(
          (rej) => PROFILE_REJECTION.test(rej) && !UNKNOWN_QUALITY.test(rej),
        )
      ) {
        profileBlocked += 1;
      }
    }
    let verdict;
    if (releases.length === 0) verdict = "NO_RELEASES";
    else if (accepted.length > 0) verdict = "CAN_GRAB";
    else if (profileBlocked > 0) verdict = "PROFILE_TRAP";
    else verdict = "UNUSABLE";
    return {
      found: releases.length,
      accepted: accepted.length,
      profileBlocked,
      verdict,
      top: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// --------------------------------------------------------------------- purge

// Deleting a title in Jellyfin only removes the file. Radarr/Sonarr keep the
// entry and Seerr keeps the request marked Available, and anything left
// monitored gets re-grabbed within minutes by decluttarr's SEARCH_MISSING --
// Clue and Europa Report came back that way on 2026-09-24.
//
// Both *arrs have "Unmonitor Deleted Movies/Episodes" on, so a file that goes
// missing from disk gets unmonitored. That is the signal used here: a title
// whose files were REMOVED (history reason MissingFromDisk or Manual, never
// Upgrade) and which the *arr then unmonitored. Requiring the unmonitor keeps
// out "deleted a bad file in Radarr to force a re-grab", which stays
// monitored. Things that never had a file (the Quatermass serials) have no
// delete events at all, so they can never match.
//
// TV is purged only when EVERY regular-season file is gone. Deleting a few
// episodes is normal for a permanent library and leaves the series alone.
const REAL_REMOVAL = new Set(["MissingFromDisk", "Manual"]);

async function purgeCandidates(sonarr, radarr) {
  const out = [];
  if (radarr) {
    const [roots, movies, queue] = await Promise.all([
      radarr("rootfolder"),
      radarr("movie"),
      radarr("queue?pageSize=500"),
    ]);
    // A dropped mount makes every file "missing". Never act on that.
    if (!roots.length || roots.some((r) => !r.accessible)) {
      throw new Error("a Radarr root folder is not accessible");
    }
    const downloading = queueIds(queue, "movieId");
    for (const m of movies) {
      if (m.monitored || m.hasFile || downloading.has(m.id)) continue;
      const hist = await radarr(`history/movie?movieId=${m.id}`);
      const del = hist.find(
        (h) =>
          h.eventType === "movieFileDeleted" &&
          REAL_REMOVAL.has(h.data?.reason),
      );
      if (!del || ageHours(del.date) < PURGE_GRACE_HOURS) continue;
      // History is newest-first: an import after the delete means it came back
      // on purpose, not a leftover.
      if (
        hist.some(
          (h) => h.eventType === "downloadFolderImported" && h.date > del.date,
        )
      )
        continue;
      out.push({
        kind: "movie",
        id: m.id,
        title: `${m.title} (${m.year})`,
        deleted: del.date,
        seerrMatch: { mediaType: "movie", tmdbId: m.tmdbId },
      });
    }
  }
  if (sonarr) {
    const [roots, series, queue] = await Promise.all([
      sonarr("rootfolder"),
      sonarr("series"),
      sonarr("queue?pageSize=500"),
    ]);
    if (!roots.length || roots.some((r) => !r.accessible)) {
      throw new Error("a Sonarr root folder is not accessible");
    }
    const downloading = queueIds(queue, "seriesId");
    for (const s of series) {
      if (downloading.has(s.id)) continue;
      const files = (s.seasons ?? [])
        .filter((x) => x.seasonNumber > 0)
        .reduce((n, x) => n + (x.statistics?.episodeFileCount ?? 0), 0);
      if (files > 0) continue;
      const hist = await sonarr(`history/series?seriesId=${s.id}`);
      const dels = hist.filter(
        (h) =>
          h.eventType === "episodeFileDeleted" &&
          REAL_REMOVAL.has(h.data?.reason),
      );
      if (!dels.length) continue;
      const last = dels[0];
      if (ageHours(last.date) < PURGE_GRACE_HOURS) continue;
      if (
        hist.some(
          (h) => h.eventType === "downloadFolderImported" && h.date > last.date,
        )
      )
        continue;
      // Every episode that lost a file must have been unmonitored by it.
      const eps = await sonarr(`episode?seriesId=${s.id}`);
      const deletedIds = new Set(dels.map((h) => h.episodeId));
      if (eps.some((e) => deletedIds.has(e.id) && e.monitored)) continue;
      out.push({
        kind: "tv",
        id: s.id,
        title: `${s.title} (${s.year})`,
        deleted: last.date,
        seerrMatch: { mediaType: "tv", tvdbId: s.tvdbId },
      });
    }
  }
  return out;
}

function seerrClient() {
  let key;
  try {
    key = JSON.parse(readFileSync(SEERR_SETTINGS, "utf8")).main.apiKey;
  } catch {
    return null;
  }
  return async (path, options) => {
    const res = await fetch(`${SEERR}${path}`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(30000),
      ...options,
    });
    if (!res.ok) throw new Error(`seerr ${path} -> HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

// Returns the lines to print. Seerr goes first: if the *arr removal then
// fails, the next run still sees the *arr entry and retries. The other order
// would strand a stale Seerr record with nothing left to match it against.
async function purgeDeleted(sonarr, radarr) {
  const candidates = await purgeCandidates(sonarr, radarr);
  if (!candidates.length) return [];
  if (candidates.length > PURGE_MAX) {
    return [
      `Deleted-title cleanup REFUSED: ${candidates.length} candidates is over the limit of ${PURGE_MAX}.`,
      `That looks like a mount problem or a mass delete, not tidying up. Nothing was removed.`,
      ...candidates.map(
        (c) =>
          `    ${c.kind}:${c.id}  ${c.title}  (deleted ${days(ageDays(c.deleted))} ago)`,
      ),
      `If it is real: PURGE_MAX=${candidates.length} ./scripts/media-stall-check.js`,
      "",
    ];
  }

  const seerr = seerrClient();
  let seerrMedia = null;
  if (seerr) {
    try {
      seerrMedia = (await seerr("/media?take=5000&filter=all")).results ?? [];
    } catch {
      /* reported per item below */
    }
  }

  const lines = [
    purgeDryRun
      ? "Deleted-title cleanup (dry run, nothing removed):"
      : "Cleaned up titles deleted in Jellyfin:",
  ];
  for (const c of candidates) {
    const m = seerrMedia?.find((x) =>
      Object.entries(c.seerrMatch).every(([k, v]) => x[k] === v),
    );
    if (seerrMedia === null) {
      lines.push(
        `    ${c.title} -- skipped, Seerr unreachable (retries next run)`,
      );
      continue;
    }
    const parts = [];
    try {
      if (m) {
        if (!purgeDryRun) await seerr(`/media/${m.id}`, { method: "DELETE" });
        parts.push("Seerr");
      }
      const api = c.kind === "movie" ? radarr : sonarr;
      const path =
        c.kind === "movie"
          ? `movie/${c.id}?deleteFiles=false&addImportExclusion=false`
          : `series/${c.id}?deleteFiles=false`;
      if (!purgeDryRun) await api(path, { method: "DELETE" });
      parts.push(c.kind === "movie" ? "Radarr" : "Sonarr");
      lines.push(
        `    ${c.title} -- ${purgeDryRun ? "would remove" : "removed"} from ${parts.join(" + ")}`,
      );
    } catch (err) {
      lines.push(
        `    ${c.title} -- FAILED after [${parts.join(", ")}]: ${err.message}`,
      );
    }
  }
  lines.push("");
  return lines;
}

// ----------------------------------------------------------------------- main

const sonarrKey = apiKeyFrom(SONARR_CONFIG);
const radarrKey = apiKeyFrom(RADARR_CONFIG);
if (!sonarrKey && !radarrKey) {
  console.error(
    `Could not read an ApiKey from ${SONARR_CONFIG} or ${RADARR_CONFIG}`,
  );
  process.exit(2);
}
const sonarr = makeClient(SONARR, sonarrKey);
const radarr = makeClient(RADARR, radarrKey);

// Cleanup runs before stall detection so a title removed here is not also
// reported below. Its output prints even on an otherwise clean run, which is
// what makes cron mail a note whenever something was removed.
if (purgeEnabled || purgeDryRun) {
  let lines;
  try {
    lines = await purgeDeleted(sonarr, radarr);
  } catch (err) {
    lines = [`Deleted-title cleanup skipped: ${err.message}`, ""];
  }
  if (!quiet) for (const l of lines) console.log(l);
}

const state = loadState();
const stalls = [];
const notes = [];

if (sonarr) {
  try {
    const { stalls: s } = await collectSonarr(sonarr);
    stalls.push(...s);
  } catch (err) {
    notes.push(`Sonarr unreachable: ${err.message}`);
  }
}
if (radarr) {
  try {
    const { stalls: s, profiles } = await collectRadarr(radarr);
    stalls.push(...s);
    // Worth saying out loud: if every Radarr profile is 2160p-only there is
    // nowhere to move a stuck movie TO, so the usual fix is unavailable.
    if (profiles.length && profiles.every((p) => profileFloor(p) >= 2160)) {
      notes.push(
        `Radarr has no sub-4K profile (only: ${profiles.map((p) => p.name).join(", ")}) -- ` +
          `a movie with no 4K release cannot be fixed by repointing it.`,
      );
    }
  } catch (err) {
    notes.push(`Radarr unreachable: ${err.message}`);
  }
}

const requests = await collectSeerr();
if (requests === null)
  notes.push("Seerr unreachable -- no requester attribution.");

// Attach requester info so the report leads with who is waiting. Seerr keys on
// external ids (tvdb/tmdb) while everything above keys on the *arr's own id, so
// this needs one extra lookup to bridge them.
if (requests && sonarr) {
  try {
    const series = await sonarr("series");
    const tvdbById = new Map(series.map((x) => [x.id, x.tvdbId]));
    for (const s of stalls.filter((x) => x.kind === "tv")) {
      const tvdb = tvdbById.get(s.id);
      const m = requests.find((r) => r.tvdbId && r.tvdbId === tvdb);
      if (m) s.request = m;
    }
  } catch {
    /* attribution is a nicety, not worth failing over */
  }
}
if (requests && radarr) {
  try {
    const movies = await radarr("movie");
    const tmdbById = new Map(movies.map((x) => [x.id, x.tmdbId]));
    for (const s of stalls.filter((x) => x.kind === "movie")) {
      const tmdb = tmdbById.get(s.id);
      const m = requests.find((r) => r.tmdbId && r.tmdbId === tmdb);
      if (m) s.request = m;
    }
  } catch {
    /* ditto */
  }
}

// Requested items first, then never-grabbed before merely-stalled, then oldest.
const rank = (s) => (s.request ? 0 : 1) * 10 + (s.tier === "NEVER" ? 0 : 1);
stalls.sort((a, b) => rank(a) - rank(b) || ageDays(b.added) - ageDays(a.added));

// Excludes come first: a title you have already ruled on should not consume a
// confirmation search or a line in the report.
const excludes = loadExcludes();
const excluded = stalls.filter((s) => isExcluded(s, excludes));
const live = stalls.filter((s) => !isExcluded(s, excludes));

// Throttle: only report items we have not already mentioned recently, unless
// --all. Note we still CONFIRM fresh suspects regardless, because the whole
// point is that a new stall should surface within hours.
const reportable = live.filter((s) => {
  if (showAll) return true;
  const last = state.alerted[s.key];
  return !last || (now - last) / DAY >= RENAG_DAYS;
});

// Confirm the highest-value suspects, cheapest-first: things a person asked for
// and which have never grabbed anything at all.
let budget = confirmEnabled ? MAX_CONFIRM : 0;
for (const s of reportable) {
  const cached = state.confirmed[s.key];
  if (cached && (now - cached.at) / DAY < CONFIRM_CACHE_DAYS) {
    s.confirm = cached.result;
    continue;
  }
  if (budget <= 0 || s.tier !== "NEVER") continue;
  s.confirm = await confirm(s, sonarr, radarr);
  state.confirmed[s.key] = { at: now, result: s.confirm };
  budget -= 1;
}

// Silence on a clean run is load-bearing: cron mails ANY output, so printing
// even an advisory note here would email every few hours forever. Notes only
// ride along with a report that was worth sending.
if (!reportable.length) {
  saveState(state);
  process.exit(0);
}

if (quiet) {
  for (const s of reportable) state.alerted[s.key] = now;
  saveState(state);
  process.exit(1);
}

console.log(`Media requests going nowhere -- ${reportable.length} item(s)\n`);

for (const s of reportable) {
  const who = s.request
    ? `requested by ${s.request.who} ${days(ageDays(s.request.when))} ago`
    : "not a Seerr request";
  console.log(`${s.title}`);
  console.log(
    `    ${s.kind === "tv" ? `${s.have}/${s.total} files, ${s.want} wanted` : "no file"}` +
      `  |  profile: ${s.profile}` +
      `  |  last import: ${days(ageDays(s.lastImport))}` +
      `  |  last grab: ${days(ageDays(s.lastGrab))}` +
      `  |  added ${days(ageDays(s.added))} ago`,
  );
  console.log(`    ${who}`);
  if (s.churn) {
    console.log(
      `    CHURNING -- ${s.churn.grabs} grabs but only ${s.churn.imports} imports.` +
        ` Downloads are failing, not missing.`,
    );
    console.log(
      `    Check the blocklist: releases that fail get blocklisted, and a series`,
    );
    console.log(
      `    can exhaust every candidate it has. See docs/sonarr-stuck-series.md.`,
    );
  }

  const c = s.confirm;
  // Sonarr and Radarr each have a local profile of this name that reaches down
  // to SD, so the remedy reads identically on both sides.
  const TV_FALLBACK = "Best Available (SD-1080p)";
  if (c?.verdict === "PROFILE_TRAP") {
    console.log(
      `    CONFIRMED PROFILE TRAP -- ${c.found} releases exist, ${c.profileBlocked} blocked`,
    );
    console.log(`    by the profile, 0 usable.`);
    for (const [reason, n] of c.top) {
      console.log(`        ${String(n).padStart(4)} | ${reason}`);
    }
    if (s.kind === "tv" && s.profile !== TV_FALLBACK) {
      console.log(`    FIX: set profile to "${TV_FALLBACK}", then`);
      console.log(`         ./scripts/sonarr-kick-missing.js ${s.id} --go`);
    } else if (s.kind === "tv") {
      console.log(
        `    Already on "${TV_FALLBACK}" -- the floor cannot go lower, so the`,
      );
      console.log(
        `    blocking format is a custom-format score, not the quality range.`,
      );
    } else if (s.profile !== TV_FALLBACK) {
      console.log(`    FIX: set profile to "${TV_FALLBACK}" and re-search.`);
    } else {
      console.log(
        `    Already on "${TV_FALLBACK}" -- the floor cannot go lower, so the`,
      );
      console.log(
        `    blocking format is a custom-format score, not the quality range.`,
      );
    }
  } else if (c?.verdict === "UNUSABLE") {
    console.log(
      `    ${c.found} releases found, 0 usable -- but NOT on profile grounds:`,
    );
    for (const [reason, n] of c.top) {
      console.log(`        ${String(n).padStart(4)} | ${reason}`);
    }
    console.log(
      `    Repointing the profile would change nothing. Mislabelled or`,
    );
    console.log(
      `    unparseable releases; needs a manual look or manual import.`,
    );
  } else if (c?.verdict === "NO_RELEASES") {
    console.log(
      `    No releases exist at all -- indexer coverage or genuinely lost media.`,
    );
    console.log(`    Not a profile problem; repointing will not help.`);
  } else if (c?.verdict === "CAN_GRAB") {
    console.log(
      `    ${c.found} releases, ${c.accepted} acceptable -- profile is fine, so this is`,
    );
    console.log(
      `    a download/import problem. Check Activity and SAB at :8086.`,
    );
  } else if (c?.error) {
    console.log(`    (confirmation failed: ${c.error})`);
  } else if (s.floor >= 2160 && s.have > 0) {
    console.log(
      `    SUSPECT: profile is 4K-only and the remaining episodes have no 4K`,
    );
    console.log(`    release available. Confirm with`);
    console.log(
      `        ./scripts/media-stall-check.js --all   (or sonarr-stuck-series.js --verify ${s.id})`,
    );
  } else if (s.floor >= 2160) {
    console.log(
      `    SUSPECT: profile is 4K-only and nothing has ever grabbed. Confirm with`,
    );
    console.log(
      `        ./scripts/media-stall-check.js --all   (or sonarr-stuck-series.js --verify ${s.id})`,
    );
  }
  console.log("");
  // --all is the tool's own suggested way to manually confirm a SUSPECT
  // (see the hint above). That's a console inspection, not a sent alert --
  // marking it here would silence the real cron alert for RENAG_DAYS even
  // though no mail ever went out.
  if (!showAll) state.alerted[s.key] = now;
}

if (notes.length) {
  console.log("notes:");
  for (const n of notes) console.log(`  - ${n}`);
  console.log("");
}
if (excluded.length) {
  console.log(
    `Excluded by media-stall-check.conf (${excluded.length}): ` +
      excluded.map((s) => s.title).join(", "),
  );
}
console.log(
  `Thresholds: 0 files -> ${GRACE_HOURS}h, partial -> ${STALE_DAYS}d, re-nag every ${RENAG_DAYS}d.`,
);
console.log(`Silence one of these: add its key or title to ${EXCLUDE_FILE}`);
console.log(`State: ${STATE_FILE}`);

saveState(state);
process.exit(1);
