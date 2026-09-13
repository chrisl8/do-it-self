// Household watch-history: who's watched what on NEUROMANCER's own Jellyfin,
// and how often — independent of Media Staging/Seerr entirely. Runs
// in-process against the local Jellyfin (this host's own web-admin can reach
// it directly, no cross-host SSH story like the deepthought watched-status
// snapshot needs).
//
// Live-queried on request rather than polled into a ledger: Jellyfin only
// returns one user's UserData per request, so a full refresh is
// (users × libraries) queries — cheap enough for a personal household to run
// on demand, with a short cache so opening the dashboard a few times in a
// row doesn't re-hit Jellyfin every time.

import { getUserConfig } from "./configRegistry.js";
import { getSecret, setSecret, createFolder } from "./infisicalClient.js";
import * as jf from "./jellyfinClient.js";

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_CACHE_TTL_MS = 2 * 60 * 1000;
const secretCache = new Map();
let statsCache = null; // { expiresAt, data }

async function getSecretCached(path, key) {
  if (!path || !key) return null;
  const cacheKey = `${path}/${key}`;
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await getSecret(key, path);
    if (!value) return null;
    secretCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
    });
    return value;
  } catch {
    return null;
  }
}

async function readConfig() {
  const config = await getUserConfig();
  const ws = config?.watchStats;
  if (!ws || !ws.enabled || !ws.jellyfin_base_url) return null;
  return {
    baseUrl: ws.jellyfin_base_url,
    apiKeyPath: ws.jellyfin_api_key_infisical_path || "/watchStats",
    apiKeyName: ws.jellyfin_api_key_infisical_key || "JELLYFIN_API_KEY",
  };
}

async function server(cfg) {
  const apiKey = await getSecretCached(cfg.apiKeyPath, cfg.apiKeyName);
  if (!apiKey) throw new Error("Jellyfin API key unavailable (Infisical)");
  return { baseUrl: cfg.baseUrl, apiKey };
}

// In-app secret injection — same pattern as seerrLedger.js's setApiKey().
export async function setApiKey(apiKey) {
  const config = await getUserConfig();
  const ws = config?.watchStats;
  if (!ws) {
    return {
      ok: false,
      error: "add a watchStats: block to user-config.yaml first",
    };
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return { ok: false, error: "no api key provided" };
  }
  const path = ws.jellyfin_api_key_infisical_path || "/watchStats";
  const keyName = ws.jellyfin_api_key_infisical_key || "JELLYFIN_API_KEY";
  const folder = path.replace(/^\/+/, "");
  if (folder) await createFolder(folder, "/").catch(() => {});
  await setSecret(keyName, apiKey, path);
  secretCache.delete(`${path}/${keyName}`);
  statsCache = null;
  return { ok: true };
}

export async function getWatchStats({ forceRefresh = false } = {}) {
  const cfg = await readConfig();
  if (!cfg) return { enabled: false, users: [], items: [] };
  if (!forceRefresh && statsCache && statsCache.expiresAt > Date.now()) {
    return statsCache.data;
  }
  const srv = await server(cfg);
  const [users, folders] = await Promise.all([
    jf.listUsers(srv),
    jf.getVirtualFolders(srv),
  ]);

  // Movies stay one row each; episodes roll up to their series — a
  // thousand-episode library otherwise means a thousand near-identical
  // rows. Series aggregation: watchedCount/episodeCount (out of every
  // episode SEEN across all users, so the denominator is stable) and
  // summed play count, per user.
  const movies = new Map(); // id -> item
  const series = new Map(); // `${library}::${seriesName}` -> agg

  const laterDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

  // One request per (user, library) pair — Jellyfin only returns one user's
  // UserData per call. Run them concurrently rather than serially: a
  // household's worth of users times a couple of libraries is a handful of
  // requests, and serial awaits were most of why this took minutes.
  const pairs = [];
  for (const user of users) {
    for (const folder of folders) {
      if (folder.itemId) pairs.push({ user, folder });
    }
  }
  const results = await Promise.all(
    pairs.map(({ user, folder }) =>
      jf
        .listPlaybackItems(srv, { parentId: folder.itemId, userId: user.id })
        .then((items) => ({ user, folder, items })),
    ),
  );

  for (const { user, folder, items } of results) {
    for (const it of items) {
      if (it.type === "Episode") {
        const seriesName = it.seriesName || it.name;
        const key = `${folder.name}::${seriesName}`;
        if (!series.has(key)) {
          series.set(key, {
            name: seriesName,
            library: folder.name,
            kind: "series",
            episodeIds: new Set(),
            perUser: {},
          });
        }
        const s = series.get(key);
        s.episodeIds.add(it.id);
        if (!s.perUser[user.name]) {
          s.perUser[user.name] = {
            watchedIds: new Set(),
            playCount: 0,
            lastPlayedDate: null,
          };
        }
        const su = s.perUser[user.name];
        if (it.played) su.watchedIds.add(it.id);
        su.playCount += it.playCount || 0;
        su.lastPlayedDate = laterDate(su.lastPlayedDate, it.lastPlayedDate);
      } else {
        if (!movies.has(it.id)) {
          movies.set(it.id, {
            id: it.id,
            name: it.name,
            library: folder.name,
            kind: "movie",
            perUser: {},
          });
        }
        movies.get(it.id).perUser[user.name] = {
          played: it.played,
          playCount: it.playCount,
          lastPlayedDate: it.lastPlayedDate,
        };
      }
    }
  }

  const seriesItems = Array.from(series.entries()).map(([key, s]) => ({
    id: key,
    name: s.name,
    library: s.library,
    kind: "series",
    episodeCount: s.episodeIds.size,
    perUser: Object.fromEntries(
      Object.entries(s.perUser).map(([user, su]) => [
        user,
        {
          watchedCount: su.watchedIds.size,
          episodeCount: s.episodeIds.size,
          playCount: su.playCount,
          lastPlayedDate: su.lastPlayedDate,
        },
      ]),
    ),
  }));

  const data = {
    enabled: true,
    users: users.map((u) => u.name),
    items: [...Array.from(movies.values()), ...seriesItems],
  };
  statsCache = { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
  return data;
}
