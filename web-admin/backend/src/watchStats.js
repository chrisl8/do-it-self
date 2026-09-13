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

  const itemsById = new Map();
  for (const user of users) {
    for (const folder of folders) {
      if (!folder.itemId) continue;
      const items = await jf.listPlaybackItems(srv, {
        parentId: folder.itemId,
        userId: user.id,
      });
      for (const it of items) {
        if (!itemsById.has(it.id)) {
          itemsById.set(it.id, {
            id: it.id,
            name: it.name,
            type: it.type,
            seriesName: it.seriesName,
            library: folder.name,
            perUser: {},
          });
        }
        itemsById.get(it.id).perUser[user.name] = {
          played: it.played,
          playCount: it.playCount,
          lastPlayedDate: it.lastPlayedDate,
        };
      }
    }
  }

  const data = {
    enabled: true,
    users: users.map((u) => u.name),
    items: Array.from(itemsById.values()),
  };
  statsCache = { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
  return data;
}
