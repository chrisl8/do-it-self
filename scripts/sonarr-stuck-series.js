#!/usr/bin/env node
// Finds Sonarr series that can never grab, because their quality profile does
// not overlap with any release that exists.
//
// The failure this catches is silent: Sonarr searches, finds plenty, rejects
// every result on "<quality> is not wanted in profile", and reports nothing.
// Star Trek: Voyager sat at 0/173 this way -- a 4K-only profile on a show
// finished on SD video, which has no 4K master and never will.
//
//   ./sonarr-stuck-series.js            # free pass, no indexer traffic
//   ./sonarr-stuck-series.js --verify 39  # confirm one series for real
//
// The free pass is a heuristic and can only flag suspects. --verify is the
// definitive check but costs a real indexer search, so it is one series at a
// time on purpose -- sweeping all of them would hammer every indexer in
// Prowlarr and risk a ban.

import { readFileSync } from "node:fs";

const CONFIG = "/mnt/ssd-4tb/container-mounts/recon/sonarr/config/config.xml";
const BASE = "http://recon.jamnapari-goblin.ts.net:8989/api/v3";
const FIX_PROFILE = "Best Available (SD-1080p)";

const apiKey = readFileSync(CONFIG, "utf8").match(
  /<ApiKey>([^<]+)<\/ApiKey>/,
)?.[1];
if (!apiKey) {
  console.error(`Could not read ApiKey from ${CONFIG}`);
  process.exit(1);
}

async function api(path) {
  const res = await fetch(
    `${BASE}/${path}${path.includes("?") ? "&" : "?"}apikey=${apiKey}`,
  );
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// Highest quality a profile will accept, as a rough resolution number.
function profileCeilingAndFloor(profile) {
  const allowed = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.quality && item.allowed) allowed.push(item.quality.name);
      if (item.items) walk(item.items);
    }
  };
  walk(profile.items);
  const res = (name) => {
    if (/2160/.test(name)) return 2160;
    if (/1080/.test(name)) return 1080;
    if (/720/.test(name)) return 720;
    if (/576|480|DVD|SDTV/i.test(name)) return 480;
    return 0;
  };
  const nums = allowed.map(res).filter(Boolean);
  return { floor: Math.min(...nums), ceiling: Math.max(...nums), allowed };
}

// Whether a profile floor is defensible for a show of this vintage.
//
// This used to give anything from 2013 onward a free pass at 2160, on the
// reasoning that 4K TV masters exist after then. That is true and irrelevant:
// 4K existing in the world says nothing about whether THIS show has it. Most
// post-2013 TV -- network sitcoms, cartoons, BBC drama, anything that is not
// prestige streaming -- never gets a 4K master. The free pass is exactly why
// this scan reported "no suspects" while The Good Place (2016) sat at 0/59 and
// Infinity Train (2019) at 0/55, both dead on a 4K-only profile.
//
// So a 2160 floor is never self-justifying. It is treated as suspect for every
// year, and the "has it ever grabbed anything?" test below does the real work
// of separating healthy 4K shows from stuck ones. Only the lower floors, where
// the format genuinely did not exist yet, can be ruled out by year alone.
function plausible(year, floor) {
  if (floor >= 2160) return false;
  if (floor >= 720) return year >= 1998;
  return true;
}

async function verify(seriesId) {
  const all = await api("series");
  const series = all.find((s) => s.id === Number(seriesId));
  if (!series) throw new Error(`No series with id ${seriesId}`);

  const season = series.seasons.find(
    (s) =>
      s.seasonNumber > 0 &&
      s.statistics?.episodeFileCount < s.statistics?.totalEpisodeCount,
  );
  const seasonNumber = season ? season.seasonNumber : 1;

  console.log(
    `Searching ${series.title} season ${seasonNumber} (real indexer query, may take a minute)...\n`,
  );
  const releases = await api(
    `release?seriesId=${series.id}&seasonNumber=${seasonNumber}`,
  );
  const accepted = releases.filter((r) => !r.rejections?.length);

  const reasons = new Map();
  for (const r of releases) {
    for (const rej of r.rejections ?? [])
      reasons.set(rej, (reasons.get(rej) ?? 0) + 1);
  }

  console.log(`  releases found: ${releases.length}`);
  console.log(`  accepted:       ${accepted.length}`);
  if (releases.length && !accepted.length) {
    console.log(
      `\n  STUCK -- found ${releases.length} releases, can use none of them.`,
    );
    console.log(`  Fix: set this series to "${FIX_PROFILE}".`);
  } else if (accepted.length) {
    console.log(
      `\n  Not stuck. Sonarr can grab; missing episodes are a different problem.`,
    );
  } else {
    console.log(
      `\n  No releases at all -- indexer coverage, not a profile problem.`,
    );
  }
  console.log("\n  top rejection reasons:");
  for (const [reason, n] of [...reasons]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)) {
    console.log(`    ${String(n).padStart(4)} | ${reason}`);
  }
}

async function scan() {
  const [series, profiles, missingEps] = await Promise.all([
    api("series"),
    api("qualityprofile"),
    api("wanted/missing?pageSize=2000&monitored=true"),
  ]);
  const byId = new Map(profiles.map((p) => [p.id, p]));

  // Count only episodes that have aired AND are monitored AND have no file --
  // which is what wanted/missing returns. Subtracting file count from total
  // episode count (the old way) counts specials and unaired episodes as
  // "missing", which flagged healthy shows like The Mandalorian at 24/25 and
  // buried the real cases. It also wildly overstates the gap on shows with lost
  // episodes: Doctor Who reads 15/749, but only 38 are actually wanted.
  const wanted = new Map();
  for (const ep of missingEps.records ?? []) {
    wanted.set(ep.seriesId, (wanted.get(ep.seriesId) ?? 0) + 1);
  }

  const suspects = [];
  for (const s of series) {
    if (!s.monitored) continue;
    const stats = s.statistics ?? {};
    const missing = wanted.get(s.id) ?? 0;
    if (missing <= 0) continue;

    const profile = byId.get(s.qualityProfileId);
    if (!profile) continue;
    const { floor } = profileCeilingAndFloor(profile);
    if (plausible(s.year, floor)) continue;

    // A 4K-only profile is only a problem if it is actually failing. A show
    // that has grabbed something recently is working as intended, however
    // narrow its profile looks -- so ask what happened rather than guessing
    // what should have. This is what makes dropping the year free-pass above
    // safe instead of merely noisy.
    const grabs = await api(`history/series?seriesId=${s.id}&eventType=1`);
    const lastGrab = grabs.length
      ? grabs
          .map((g) => g.date)
          .sort()
          .at(-1)
      : null;
    if (lastGrab && (Date.now() - new Date(lastGrab)) / 86400000 < 14) continue;

    suspects.push({
      lastGrab,
      id: s.id,
      title: s.title,
      year: s.year,
      profile: profile.name,
      have: stats.episodeFileCount ?? 0,
      total: stats.totalEpisodeCount ?? 0,
      floor,
    });
  }

  if (!suspects.length) {
    console.log(
      "No suspects. Every monitored series with missing episodes is on a profile that could plausibly match.",
    );
    return;
  }

  console.log(
    `${suspects.length} series look unable to ever match their profile:\n`,
  );
  console.log("    id  year  files      profile                     title");
  for (const s of suspects.sort((a, b) => a.year - b.year)) {
    console.log(
      `  ${String(s.id).padStart(4)}  ${s.year}  ${String(`${s.have}/${s.total}`).padStart(8)}  ${s.profile.padEnd(26)}  ${s.title}`,
    );
  }
  console.log(
    `\nEach is on a profile whose lowest allowed quality did not exist when it aired.`,
  );
  console.log(`Confirm one with:  ./sonarr-stuck-series.js --verify <id>`);
  console.log(`Fix by setting the series to "${FIX_PROFILE}" in Sonarr.`);
}

const [flag, value] = process.argv.slice(2);
try {
  if (flag === "--verify") {
    if (!value) throw new Error("--verify needs a series id");
    await verify(value);
  } else {
    await scan();
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
