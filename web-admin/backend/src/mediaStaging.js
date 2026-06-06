// Media Staging — RECEIVER side (runs on the client host, e.g. deepthought).
//
// Lets the client's operator browse the SOURCE Jellyfin (e.g. neuromancer's,
// reached directly because its sidecar is shared) and request titles to be
// copied to this host's local Jellyfin so they play from local disk.
//
// Topology note: the client CANNOT reach the source host, but the source host
// CAN reach the client. So transfers are PUSHED by the source (see
// mediaStagingPush.js). This module never runs rsync. Instead:
//   - browsing/selection resolves each pick to a library-relative path (rel)
//     via the source Jellyfin API,
//   - "Copy" writes a job file to a spool dir that the source host reads over
//     SSH,
//   - the source host writes status back into the spool; a poller here turns
//     spool state into the WebSocket snapshot the UI renders.
//
// Active only where a `mediaStaging:` block exists in user-config.yaml. On
// other hosts the poller reports { enabled: false } and the tab self-hides.

import { spawn } from "child_process";
import os from "os";
import { join } from "path";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  stat,
  rm,
  realpath,
} from "fs/promises";
import { getUserConfig } from "./configRegistry.js";
import { getSecret, setSecret, createFolder } from "./infisicalClient.js";
import { updateStatus } from "./statusEmitter.js";
import * as jf from "./jellyfinClient.js";

const POLL_INTERVAL_MS_DEFAULT = 5 * 1000;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const POSTER_MAX_WIDTH = 240;
// "done" jobs clear from the queue quickly — the Staged section is the record
// of what's on disk, so a lingering "done" row is just noise. failed/cancelled
// stick around (you need them to Retry) until dismissed or this longer expiry.
const DONE_RETENTION_MS = 60 * 1000;
const TERMINAL_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_TERMINAL_IN_VIEW = 10;

let tickTimer = null;
let tickInFlight = false;
let lastDisk = null;
let jobCounter = 0;
const seenDoneIds = new Set(); // jobs we've already triggered a refresh for

const secretCache = new Map(); // `${path}/${key}` → { value, expiresAt }
let cachedUserId = null;

// ── helpers ─────────────────────────────────────────────────────
function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  return p;
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

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

// ── config ──────────────────────────────────────────────────────
async function readConfig() {
  const config = await getUserConfig();
  const ms = config?.mediaStaging;
  if (
    !ms ||
    !ms.enabled ||
    !ms.jellyfin_base_url ||
    !Array.isArray(ms.libraries) ||
    ms.libraries.length === 0
  ) {
    return null;
  }
  const libraries = ms.libraries
    .filter((l) => l?.name && l?.jellyfin_path_prefix && l?.dest_root)
    .map((l) => ({
      name: l.name,
      collection_type: l.collection_type || "movies",
      jellyfin_path_prefix: l.jellyfin_path_prefix,
      dest_root: expandHome(l.dest_root),
    }));
  if (libraries.length === 0) return null;
  return {
    enabled: true,
    jellyfinBaseUrl: ms.jellyfin_base_url,
    jellyfinApiKeyPath: ms.jellyfin_api_key_infisical_path || "/mediaStaging",
    jellyfinApiKeyName:
      ms.jellyfin_api_key_infisical_key || "NEUROMANCER_JELLYFIN_API_KEY",
    localJellyfinBaseUrl: ms.local_jellyfin_base_url || "http://localhost:8096",
    localJellyfinApiKeyName:
      ms.local_jellyfin_api_key_infisical_key || "DEEPTHOUGHT_JELLYFIN_API_KEY",
    spoolDir: expandHome(ms.spool_dir || "~/media-staging"),
    freeSpacePath: expandHome(ms.free_space_path || libraries[0].dest_root),
    libraries,
    pollIntervalMs: (ms.poll_interval_seconds || 5) * 1000,
  };
}

async function sourceServer(cfg) {
  const apiKey = await getSecretCached(
    cfg.jellyfinApiKeyPath,
    cfg.jellyfinApiKeyName,
  );
  if (!apiKey)
    throw new Error("source Jellyfin API key unavailable (Infisical)");
  return { baseUrl: cfg.jellyfinBaseUrl, apiKey };
}

async function localServer(cfg) {
  const apiKey = await getSecretCached(
    cfg.jellyfinApiKeyPath,
    cfg.localJellyfinApiKeyName,
  );
  if (!apiKey) return null;
  return { baseUrl: cfg.localJellyfinBaseUrl, apiKey };
}

async function resolveUserId(server) {
  if (cachedUserId) return cachedUserId;
  cachedUserId = await jf.getAdminUserId(server).catch(() => null);
  return cachedUserId;
}

// Write the source and/or local Jellyfin API keys into Infisical at the
// configured path. This is the in-app way to inject these secrets (Infisical
// is reached through the web admin's machine identity, not an interactive
// CLI), mirroring the Backup Pi "Set passphrase" flow. Only non-empty keys are
// written, so you can set one without clobbering the other.
async function setApiKeys({ sourceKey, localKey }) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: "media staging not configured" };
  const folder = cfg.jellyfinApiKeyPath.replace(/^\/+/, "");
  if (folder) await createFolder(folder, "/").catch(() => {});
  const written = [];
  try {
    if (typeof sourceKey === "string" && sourceKey.length > 0) {
      await setSecret(
        cfg.jellyfinApiKeyName,
        sourceKey,
        cfg.jellyfinApiKeyPath,
      );
      secretCache.delete(`${cfg.jellyfinApiKeyPath}/${cfg.jellyfinApiKeyName}`);
      cachedUserId = null; // re-resolve the admin user with the new key
      written.push(cfg.jellyfinApiKeyName);
    }
    if (typeof localKey === "string" && localKey.length > 0) {
      await setSecret(
        cfg.localJellyfinApiKeyName,
        localKey,
        cfg.jellyfinApiKeyPath,
      );
      secretCache.delete(
        `${cfg.jellyfinApiKeyPath}/${cfg.localJellyfinApiKeyName}`,
      );
      written.push(cfg.localJellyfinApiKeyName);
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (written.length === 0) return { ok: false, error: "no keys provided" };
  return { ok: true, keys: written, path: cfg.jellyfinApiKeyPath };
}

function findLibrary(cfg, name) {
  const lib = cfg.libraries.find((l) => l.name === name);
  if (!lib) throw new Error(`library "${name}" not configured`);
  return lib;
}

function itemTypeForLibrary(lib) {
  return lib.collection_type === "tvshows" ? "Series" : "Movie";
}

function destPathFor(lib, rel) {
  return join(lib.dest_root, rel);
}

// ── disk usage ──────────────────────────────────────────────────
function parseDf(output) {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  const total = Number(cols[1]);
  const used = Number(cols[2]);
  const free = Number(cols[3]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    pct: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

function readDisk(cfg) {
  return new Promise((resolve) => {
    const child = spawn("df", ["-PB1", cfg.freeSpacePath]);
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseDf(out));
    });
  });
}

// ── staged-item enumeration ─────────────────────────────────────
async function dirSize(p) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

async function listDir(p) {
  try {
    return await readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function getStaged() {
  const cfg = await readConfig();
  if (!cfg) return { enabled: false, libraries: [] };
  const libraries = [];
  for (const lib of cfg.libraries) {
    const entries = await listDir(lib.dest_root);
    const items = [];
    for (const entry of entries) {
      const full = join(lib.dest_root, entry.name);
      const item = {
        label: entry.name,
        path: full,
        sizeBytes: await dirSize(full),
        kind: lib.collection_type === "tvshows" ? "series" : "movie",
      };
      if (lib.collection_type === "tvshows" && entry.isDirectory()) {
        const seasonDirs = (await listDir(full)).filter((d) => d.isDirectory());
        item.children = [];
        for (const sd of seasonDirs) {
          const sFull = join(full, sd.name);
          item.children.push({
            label: sd.name,
            path: sFull,
            sizeBytes: await dirSize(sFull),
            kind: "season",
          });
        }
      }
      items.push(item);
    }
    libraries.push({
      name: lib.name,
      collectionType: lib.collection_type,
      destRoot: lib.dest_root,
      items,
    });
  }
  return { enabled: true, libraries };
}

async function deleteStaged(targetPath) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: "media staging not configured" };
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, error: "no path provided" };
  }
  let resolved;
  try {
    resolved = await realpath(targetPath);
  } catch {
    return { ok: false, error: "path does not exist" };
  }
  let allowed = false;
  for (const lib of cfg.libraries) {
    let root;
    try {
      root = await realpath(lib.dest_root);
    } catch {
      continue;
    }
    if (resolved === root)
      return { ok: false, error: "refusing to delete a library root" };
    if (resolved.startsWith(root + "/")) {
      allowed = true;
      break;
    }
  }
  if (!allowed)
    return { ok: false, error: "path is not inside a configured dest_root" };
  try {
    await rm(resolved, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  refreshLocalLibrary(cfg).catch(() => {});
  readDisk(cfg).then((d) => {
    if (d) {
      lastDisk = d;
      publishSnapshot(cfg);
    }
  });
  return { ok: true };
}

// ── listing for the UI ──────────────────────────────────────────
async function existsPath(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function getConfigForUI() {
  const cfg = await readConfig();
  if (!cfg) return { enabled: false };
  return {
    enabled: true,
    libraries: cfg.libraries.map((l) => ({
      name: l.name,
      collectionType: l.collection_type,
    })),
    freeSpacePath: cfg.freeSpacePath,
  };
}

async function withLibraryContext(libraryName) {
  const cfg = await readConfig();
  if (!cfg) throw new Error("media staging not configured");
  const lib = findLibrary(cfg, libraryName);
  const server = await sourceServer(cfg);
  const folders = await jf.getVirtualFolders(server);
  const vf = folders.find((f) => f.name === lib.name);
  if (!vf)
    throw new Error(`library "${lib.name}" not found on source Jellyfin`);
  const userId = await resolveUserId(server);
  return { cfg, lib, server, vf, userId };
}

// Map an item's Jellyfin path → local dest path, then check it exists.
async function stagedFor(lib, jellyfinPath, useParentDir) {
  if (!jellyfinPath) return false;
  try {
    const rel = jf.computeRel({ jellyfinPath, libraryCfg: lib, useParentDir });
    return await existsPath(destPathFor(lib, rel));
  } catch {
    return false;
  }
}

async function getItemsForUI(libraryName) {
  const { lib, server, vf, userId } = await withLibraryContext(libraryName);
  const items = await jf.listLibraryItems(server, {
    parentId: vf.itemId,
    userId,
    itemType: itemTypeForLibrary(lib),
  });
  const isTv = lib.collection_type === "tvshows";
  const out = [];
  for (const it of items) {
    let mapError = null;
    if (it.path) {
      try {
        jf.computeRel({
          jellyfinPath: it.path,
          libraryCfg: lib,
          useParentDir: !isTv,
        });
      } catch (e) {
        mapError = e?.message || String(e);
      }
    }
    out.push({
      ...it,
      staged: await stagedFor(lib, it.path, !isTv),
      mapError,
    });
  }
  return out;
}

async function getSeasonsForUI(libraryName, seriesId) {
  const { lib, server, userId } = await withLibraryContext(libraryName);
  const seasons = await jf.listSeasons(server, { seriesId, userId });
  const out = [];
  for (const s of seasons) {
    out.push({ ...s, staged: await stagedFor(lib, s.path, false) });
  }
  return out;
}

async function getEpisodesForUI(libraryName, seriesId, seasonId) {
  const { lib, server, userId } = await withLibraryContext(libraryName);
  const episodes = await jf.listEpisodes(server, {
    seriesId,
    seasonId,
    userId,
  });
  const out = [];
  for (const e of episodes) {
    out.push({ ...e, staged: await stagedFor(lib, e.path, false) });
  }
  return out;
}

async function getPosterResponse(itemId) {
  const cfg = await readConfig();
  if (!cfg) throw new Error("media staging not configured");
  const server = await sourceServer(cfg);
  return jf.getPrimaryImageResponse(server, itemId, {
    maxWidth: POSTER_MAX_WIDTH,
  });
}

// ── selection → job ─────────────────────────────────────────────
// Resolve a client selection (Jellyfin ids only) to a transferable job by
// reading the canonical Path from the source server and reducing it to a
// library-relative path.
async function resolveSelection(server, userId, cfg, sel) {
  const lib = findLibrary(cfg, sel.libraryName);
  let jellyfinPath = null;
  let sizeBytes = null;
  let label = "";
  let useParentDir = false;

  if (sel.kind === "movie") {
    const item = await jf.getItemById(server, { id: sel.id, userId });
    jellyfinPath = item?.MediaSources?.[0]?.Path || item?.Path;
    sizeBytes = item?.MediaSources?.[0]?.Size ?? null;
    label = item?.Name || sel.id;
    useParentDir = true;
  } else if (sel.kind === "series") {
    const item = await jf.getItemById(server, {
      id: sel.seriesId,
      userId,
      fields: "Path",
    });
    jellyfinPath = item?.Path;
    sizeBytes = await jf
      .sumSeriesBytes(server, { seriesId: sel.seriesId, userId })
      .catch(() => null);
    label = item?.Name || sel.seriesId;
  } else if (sel.kind === "season") {
    const item = await jf.getItemById(server, {
      id: sel.seasonId,
      userId,
      fields: "Path",
    });
    jellyfinPath = item?.Path;
    sizeBytes = await jf
      .sumSeriesBytes(server, {
        seriesId: sel.seriesId,
        seasonId: sel.seasonId,
        userId,
      })
      .catch(() => null);
    label = item?.Name || sel.seasonId;
  } else if (sel.kind === "episode") {
    const item = await jf.getItemById(server, { id: sel.episodeId, userId });
    jellyfinPath = item?.MediaSources?.[0]?.Path || item?.Path;
    sizeBytes = item?.MediaSources?.[0]?.Size ?? null;
    label = item?.Name || sel.episodeId;
  } else {
    throw new Error(`unknown selection kind "${sel.kind}"`);
  }

  const rel = jf.computeRel({ jellyfinPath, libraryCfg: lib, useParentDir });
  return {
    library: lib.name,
    kind: sel.kind,
    rel,
    label: label || rel,
    sizeBytes,
    destRoot: lib.dest_root,
    destPath: destPathFor(lib, rel),
  };
}

// ── spool I/O ───────────────────────────────────────────────────
function pendingDir(cfg) {
  return join(cfg.spoolDir, "pending");
}
function statusDir(cfg) {
  return join(cfg.spoolDir, "status");
}
function cancelDir(cfg) {
  return join(cfg.spoolDir, "cancel");
}

async function ensureSpool(cfg) {
  await mkdir(pendingDir(cfg), { recursive: true });
  await mkdir(statusDir(cfg), { recursive: true });
  await mkdir(cancelDir(cfg), { recursive: true });
}

async function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(obj), "utf8");
  await rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function enqueueCopies(selections, ws) {
  const cfg = await readConfig();
  if (!cfg) {
    safeSend(ws, {
      type: "mediaStagingCopyResult",
      success: false,
      error: "media staging not configured",
    });
    return;
  }
  let server;
  let userId;
  try {
    server = await sourceServer(cfg);
    userId = await resolveUserId(server);
  } catch (err) {
    safeSend(ws, {
      type: "mediaStagingCopyResult",
      success: false,
      error: err?.message || "source Jellyfin unavailable",
    });
    return;
  }
  await ensureSpool(cfg);

  // Dedupe against jobs already in the spool (by destPath).
  const existing = new Set();
  for (const f of await listDir(pendingDir(cfg))) {
    if (!f.isFile()) continue;
    const j = await readJson(join(pendingDir(cfg), f.name));
    if (j?.destPath) existing.add(j.destPath);
  }

  for (const sel of selections || []) {
    let req;
    try {
      req = await resolveSelection(server, userId, cfg, sel);
    } catch (err) {
      safeSend(ws, {
        type: "mediaStagingCopyResult",
        jobId: null,
        success: false,
        label: sel?.label || sel?.id,
        error: err?.message || "could not resolve selection",
      });
      continue;
    }
    if (existing.has(req.destPath)) continue;
    existing.add(req.destPath);
    const id = `${nowEpoch().toString(36)}-${++jobCounter}`;
    await writeJson(join(pendingDir(cfg), `${id}.json`), {
      id,
      ...req,
      createdEpoch: nowEpoch(),
    });
  }
  await refreshQueue(cfg);
}

// Cancel: drop a marker the sender honors (skips if unclaimed, SIGTERMs if
// in-flight). Also remove the pending file if the sender hasn't claimed it yet
// (no status written), so it never starts.
async function cancelCopy(jobId) {
  const cfg = await readConfig();
  if (!cfg || typeof jobId !== "string") return;
  await ensureSpool(cfg).catch(() => {});
  await writeFile(join(cancelDir(cfg), jobId), "", "utf8").catch(() => {});
  const status = await readJson(join(statusDir(cfg), `${jobId}.json`));
  if (!status) {
    // Not yet claimed — remove pending so it never runs.
    await rm(join(pendingDir(cfg), `${jobId}.json`), { force: true }).catch(
      () => {},
    );
  }
  await refreshQueue(cfg);
}

// Retry a failed/cancelled job: clear its status + cancel markers so the
// sender re-claims the still-present pending file on its next poll (resuming
// any partial transfer via rsync --partial). Self-service recovery for the
// inevitable mid-copy restart / network blip.
async function retryJob(jobId) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: "media staging not configured" };
  if (typeof jobId !== "string") return { ok: false, error: "bad job id" };
  const pending = join(pendingDir(cfg), `${jobId}.json`);
  try {
    await stat(pending);
  } catch {
    return { ok: false, error: "job expired — re-select it from the list" };
  }
  await rm(join(statusDir(cfg), `${jobId}.json`), { force: true }).catch(
    () => {},
  );
  await rm(join(cancelDir(cfg), jobId), { force: true }).catch(() => {});
  seenDoneIds.delete(jobId);
  await refreshQueue(cfg);
  return { ok: true };
}

// Dismiss a job from the queue: remove its spool files so it stops showing.
// Intended for failed/cancelled rows the user doesn't want to retry.
async function dismissJob(jobId) {
  const cfg = await readConfig();
  if (!cfg || typeof jobId !== "string") return { ok: false };
  await rm(join(pendingDir(cfg), `${jobId}.json`), { force: true }).catch(
    () => {},
  );
  await rm(join(statusDir(cfg), `${jobId}.json`), { force: true }).catch(
    () => {},
  );
  await rm(join(cancelDir(cfg), jobId), { force: true }).catch(() => {});
  seenDoneIds.delete(jobId);
  await refreshQueue(cfg);
  return { ok: true };
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* client gone */
  }
}

// ── snapshot building ───────────────────────────────────────────
function publishSnapshot(cfg, queue) {
  updateStatus("mediaStaging", {
    enabled: !!cfg,
    disk: lastDisk,
    queue: queue || [],
  });
}

// Merge pending + status files into the queue the UI renders, prune old
// terminal jobs, and trigger a local library refresh when a job first
// completes.
async function refreshQueue(cfg) {
  if (!cfg) {
    updateStatus("mediaStaging", { enabled: false });
    return;
  }
  await ensureSpool(cfg).catch(() => {});
  const pendFiles = (await listDir(pendingDir(cfg))).filter((f) => f.isFile());

  const active = [];
  const terminal = [];
  let anyNewlyDone = false;

  for (const f of pendFiles) {
    const id = f.name.replace(/\.json$/, "");
    const job = await readJson(join(pendingDir(cfg), `${id}.json`));
    if (!job) continue;
    const status = await readJson(join(statusDir(cfg), `${id}.json`));
    const state = status?.state || "pending";
    const entry = {
      id,
      label: job.label,
      kind: job.kind,
      sizeBytes: job.sizeBytes,
      status: state,
      percent: status?.percent || 0,
      rate: status?.rate || null,
      eta: status?.eta || null,
      error: status?.error || null,
      updatedEpoch: status?.updatedEpoch || job.createdEpoch,
    };
    const isTerminal =
      state === "done" || state === "failed" || state === "cancelled";
    if (isTerminal) {
      // Prune finished jobs (and their status/cancel files). "done" clears
      // fast since it's now reflected in the Staged section; failures linger
      // so they stay retry-able.
      const retentionSec =
        (state === "done" ? DONE_RETENTION_MS : TERMINAL_RETENTION_MS) / 1000;
      if (
        status?.updatedEpoch &&
        nowEpoch() - status.updatedEpoch > retentionSec
      ) {
        await rm(join(pendingDir(cfg), `${id}.json`), { force: true }).catch(
          () => {},
        );
        await rm(join(statusDir(cfg), `${id}.json`), { force: true }).catch(
          () => {},
        );
        await rm(join(cancelDir(cfg), id), { force: true }).catch(() => {});
        seenDoneIds.delete(id);
        continue;
      }
      terminal.push(entry);
      if (state === "done" && !seenDoneIds.has(id)) {
        seenDoneIds.add(id);
        anyNewlyDone = true;
      }
    } else {
      active.push(entry);
    }
  }

  terminal.sort((a, b) => (b.updatedEpoch || 0) - (a.updatedEpoch || 0));
  const queue = [...active, ...terminal.slice(0, MAX_TERMINAL_IN_VIEW)];
  publishSnapshot(cfg, queue);

  if (anyNewlyDone) {
    lastDisk = (await readDisk(cfg)) || lastDisk;
    scheduleLocalRefresh(cfg);
    publishSnapshot(cfg, queue);
  }
}

// Debounced local Jellyfin refresh so a batch of episodes triggers one scan.
let refreshTimer = null;
function scheduleLocalRefresh(cfg) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshLocalLibrary(cfg).catch(() => {});
  }, 5000);
}

async function refreshLocalLibrary(cfg) {
  const server = await localServer(cfg);
  if (!server) return;
  await jf.refreshLibrary(server);
}

// ── poller ──────────────────────────────────────────────────────
async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const cfg = await readConfig();
    if (!cfg) {
      updateStatus("mediaStaging", { enabled: false });
      return;
    }
    lastDisk = (await readDisk(cfg)) || lastDisk;
    await refreshQueue(cfg);
  } catch (err) {
    console.error("[mediaStaging] poll error:", err?.message || err);
  } finally {
    tickInFlight = false;
  }
}

async function start() {
  tick();
  tickTimer = setInterval(tick, POLL_INTERVAL_MS_DEFAULT);
  console.log(
    `[mediaStaging] receiver poller started (${POLL_INTERVAL_MS_DEFAULT / 1000}s)`,
  );
}

async function stop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export {
  getConfigForUI,
  getItemsForUI,
  getSeasonsForUI,
  getEpisodesForUI,
  getPosterResponse,
  getStaged,
  deleteStaged,
  enqueueCopies,
  cancelCopy,
  retryJob,
  dismissJob,
  setApiKeys,
};
export default { init: start, stop };
