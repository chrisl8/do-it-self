#!/usr/bin/env node
// Searches ONLY the missing episodes of one series -- never upgrades.
//
// Back catalog does not self-heal. RSS is Sonarr's only automatic input and it
// is a "what's new" feed, so a show that stopped airing years ago is invisible
// to it forever. Missing episodes only move when explicitly searched. See
// docs/sonarr-stuck-series.md.
//
// Why not just hit "Search Monitored" in the UI: shows moved to Best Available
// (SD-1080p) sit below its WEB 1080p cutoff, so anything that also picks up
// cutoff-unmet episodes would try to re-grab the entire library at 1080p --
// M*A*S*H alone is 251 files / 452 GB. This targets explicit episode ids that
// have no file, so an upgrade cannot happen by construction.
//
//   ./sonarr-kick-missing.js 23        # dry run -- prints what it would search
//   ./sonarr-kick-missing.js 23 --go   # actually search
//
// Unaired episodes are skipped: searching them burns indexer queries to find
// something that does not exist yet.

import { readFileSync } from "node:fs";

const CONFIG = "/mnt/ssd-4tb/container-mounts/recon/sonarr/config/config.xml";
const BASE = "http://recon.jamnapari-goblin.ts.net:8989/api/v3";

const apiKey = readFileSync(CONFIG, "utf8").match(
  /<ApiKey>([^<]+)<\/ApiKey>/,
)?.[1];
if (!apiKey) {
  console.error(`Could not read ApiKey from ${CONFIG}`);
  process.exit(1);
}

async function api(path, options) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}/${path}${sep}apikey=${apiKey}`, options);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const [idArg, flag] = process.argv.slice(2);
if (!idArg) {
  console.error("usage: sonarr-kick-missing.js <seriesId> [--go]");
  process.exit(1);
}
const seriesId = Number(idArg);
const go = flag === "--go";

const [series, episodes] = await Promise.all([
  api(`series/${seriesId}`),
  api(`episode?seriesId=${seriesId}`),
]);

const now = new Date();
const missing = [];
let unaired = 0;
let unmonitored = 0;

for (const ep of episodes) {
  if (ep.hasFile) continue;
  if (!ep.monitored) {
    unmonitored += 1;
    continue;
  }
  if (!ep.airDateUtc || new Date(ep.airDateUtc) > now) {
    unaired += 1;
    continue;
  }
  missing.push(ep);
}

const bySeason = new Map();
for (const ep of missing) {
  bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
}

console.log(`${series.title} (${series.year})`);
console.log(
  `  have ${series.statistics.episodeFileCount}/${series.statistics.totalEpisodeCount}` +
    `  |  profile: ${series.qualityProfileId}`,
);
console.log(
  `  missing + aired + monitored : ${missing.length}   <- will search`,
);
if (unaired) console.log(`  unaired (skipped)           : ${unaired}`);
if (unmonitored) console.log(`  unmonitored (skipped)       : ${unmonitored}`);

if (!missing.length) {
  console.log("\nNothing to search.");
  process.exit(0);
}

console.log("\n  per season:");
for (const [season, n] of [...bySeason].sort((a, b) => a[0] - b[0])) {
  console.log(`    S${String(season).padStart(2, "0")}  ${n}`);
}

if (!go) {
  console.log(
    `\nDry run. ${missing.length} episode searches would fire (one indexer query each).`,
  );
  console.log(`Re-run with --go to do it.`);
  process.exit(0);
}

const result = await api("command", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "EpisodeSearch",
    episodeIds: missing.map((e) => e.id),
  }),
});
console.log(
  `\nQueued EpisodeSearch for ${missing.length} episodes (command ${result.id}, ${result.status}).`,
);
console.log(`Watch: Sonarr Activity, or SAB at :8086`);
