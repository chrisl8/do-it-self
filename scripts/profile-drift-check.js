#!/usr/bin/env node
// Alerts when a hand-mirrored quality profile has drifted from the TRaSH
// profile it copies.
//
// "Best Available (up to 4K)" (Sonarr and Radarr) is a LOCAL profile: Recyclarr
// cannot inherit a TRaSH profile's scores into a profile with no trash_id, so
// recon/config-defaults/recyclarr-configs/{sonarr,uhd-bluray-web}.yml carry a
// hand-copied list of every non-zero custom-format score. That list is a
// snapshot. If TRaSH rescores something (or adds a format) the TRaSH profile
// moves on its next sync and the copy silently stays behind, so 4K picks would
// quietly start being chosen differently on the two profiles.
//
// This compares the scores LIVE, through the *arr APIs, and also checks that
// Seerr's default profile is still the mirror (a Seerr config reset or a
// re-added server would put requests back on the 2160p-only profile and bring
// the silent-stall trap back).
//
//   ./profile-drift-check.js        # silent + exit 0 when clean; exit 1 on drift
//   ./profile-drift-check.js --all  # also print what was compared
//
// Run from cron daily. Like media-stall-check.js it prints nothing when all is
// well, so cron only mails when there is something to do.

import { readFileSync } from "node:fs";

const MOUNT = process.env.STALL_MOUNT ?? "/mnt/ssd-4tb";
const CFG = `${MOUNT}/container-mounts`;
const SEERR = "https://seerr.jamnapari-goblin.ts.net/api/v1";
const showAll = process.argv.includes("--all");

const MIRROR = process.env.DRIFT_MIRROR ?? "Best Available (up to 4K)";

// Differences that are deliberate. Anything else is drift. Keys are the custom
// format name; the value is [score on source, score on mirror].
const TARGETS = [
  {
    app: "Sonarr",
    base: "http://recon.jamnapari-goblin.ts.net:8989/api/v3",
    config: `${CFG}/recon/sonarr/config/config.xml`,
    source: "WEB-2160p",
    seerrPath: "settings/sonarr",
    // sonarr.yml: -50 is a hard reject of foreign-original shows at min score 0,
    // so it is not copied; the local floor exists only on the Best Available
    // profiles (Recyclarr cannot create or score it).
    expected: {
      "Language: Not English": [-50, 0],
      "Upscaled (Unlabelled Groups)": [0, -10000],
    },
  },
  {
    app: "Radarr",
    base: "http://recon.jamnapari-goblin.ts.net:7878/api/v3",
    config: `${CFG}/recon/radarr/config/config.xml`,
    source: "UHD Bluray + WEB",
    seerrPath: "settings/radarr",
    expected: {},
  },
];

function apiKey(path) {
  return readFileSync(path, "utf8").match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url.split("?")[0]} -> HTTP ${res.status}`);
  return res.json();
}

const scores = (p) =>
  Object.fromEntries(
    p.formatItems.filter((f) => f.score).map((f) => [f.name, f.score]),
  );

const problems = [];
let seerrKey = null;
try {
  seerrKey = JSON.parse(
    readFileSync(`${CFG}/seerr/config/settings.json`, "utf8"),
  ).main.apiKey;
} catch (e) {
  problems.push(`Seerr: cannot read its API key (${e.message})`);
}

for (const t of TARGETS) {
  try {
    const key = apiKey(t.config);
    if (!key) throw new Error(`no ApiKey in ${t.config}`);
    const profiles = await get(`${t.base}/qualityprofile?apikey=${key}`);
    const src = profiles.find((p) => p.name === t.source);
    const mirror = profiles.find((p) => p.name === MIRROR);
    if (!src) throw new Error(`profile "${t.source}" not found`);
    if (!mirror) throw new Error(`profile "${MIRROR}" not found`);

    const a = scores(src);
    const b = scores(mirror);
    const drift = [];
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const got = [a[name] ?? 0, b[name] ?? 0];
      const exp = t.expected[name];
      // The mirror must equal the source, unless this difference is expected.
      const ok = exp
        ? got[0] === exp[0] && got[1] === exp[1]
        : got[0] === got[1];
      if (!ok) drift.push({ name, source: got[0], mirror: got[1] });
    }
    for (const d of drift) {
      problems.push(
        `${t.app}: "${d.name}" is ${d.source} on ${t.source} but ${d.mirror} on ${MIRROR}`,
      );
    }
    if (showAll) {
      console.log(
        `${t.app}: ${Object.keys(a).length} scored on ${t.source}, ${Object.keys(b).length} on ${MIRROR}, ${drift.length} drifted`,
      );
    }

    if (seerrKey) {
      const servers = await get(`${SEERR}/${t.seerrPath}`, {
        "X-Api-Key": seerrKey,
      });
      for (const s of servers.filter((s) => !s.is4k && s.isDefault)) {
        if (s.activeProfileName !== MIRROR) {
          problems.push(
            `Seerr: default ${t.app} profile is "${s.activeProfileName}", not "${MIRROR}" -- new requests will stall on 2160p-only again`,
          );
        } else if (showAll) {
          console.log(`Seerr: ${t.app} default is ${MIRROR}`);
        }
      }
    }
  } catch (e) {
    problems.push(`${t.app}: check failed (${e.message})`);
  }
}

if (problems.length) {
  console.log("PROFILE DRIFT");
  for (const p of problems) console.log(`  - ${p}`);
  console.log(`
FIX: re-diff the scores and update the mirrored block in
  .modules/do-it-self-containers/recon/config-defaults/recyclarr-configs/
  (sonarr.yml: "up to 4K only: mirror of WEB-2160p"; uhd-bluray-web.yml:
  "Best Available (up to 4K) only"), commit to the module, copy it to
  ~/containers/recon/recyclarr-configs/, then:
    docker exec recon-recyclarr recyclarr sync <sonarr|radarr>
  For Seerr, set the Sonarr/Radarr default profile back to "${MIRROR}".`);
  process.exit(1);
}
