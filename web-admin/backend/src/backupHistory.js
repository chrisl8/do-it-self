// Backup History monitor.
//
// Reads JSONL logs produced by scripts/backup-history-log.sh — one line
// per borg archive, one file per host. Neuromancer's own archives (if
// ever logged the same way) would write locally; remote hosts (e.g.
// wintermute) push their log via rsync using the same coverage-push key
// the Backup Coverage audit uses. The web admin watches HISTORY_DIR for
// *.jsonl files, parses each into a per-host array of archive records
// sorted oldest-first, and broadcasts via statusEmitter so the Backup
// History page can chart size/duration/file-count trends per host.
//
// Each record: { host, name, start, end, original_size, compressed_size,
// deduplicated_size, nfiles }. Sizes are bytes; start/end are borg's ISO
// timestamps (no timezone — local time of the source host).

import { readFile, stat, readdir, mkdir } from "fs/promises";
import { hostname, homedir } from "os";
import path from "path";
import { updateStatus } from "./statusEmitter.js";

const HISTORY_DIR =
  process.env.BACKUP_HISTORY_DIR ||
  path.join(homedir(), "logs", "backup-history");

const POLL_INTERVAL_MS = 30 * 1000;
const LOCAL_HOST = hostname();

let pollTimer = null;
const lastMtimeMs = new Map(); // host -> mtimeMs of jsonl file

async function ensureDir() {
  await mkdir(HISTORY_DIR, { recursive: true }).catch(() => {});
}

async function loadOneLog(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return { error: err.code === "ENOENT" ? "log missing" : err.message };
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip a malformed/partial line (e.g. concurrent write mid-append)
    }
  }
  records.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return records;
}

async function discoverLogs() {
  let files;
  try {
    files = await readdir(HISTORY_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      host: f.replace(/\.jsonl$/, ""),
      file: path.join(HISTORY_DIR, f),
    }));
}

async function publishAll() {
  const discovered = await discoverLogs();
  const byHost = {};
  for (const { host, file } of discovered) {
    byHost[host] = await loadOneLog(file);
  }
  const hosts = Object.keys(byHost).sort((a, b) => {
    if (a === LOCAL_HOST) return -1;
    if (b === LOCAL_HOST) return 1;
    return a.localeCompare(b);
  });
  updateStatus("backupHistory", { localHost: LOCAL_HOST, hosts, byHost });
}

async function tick() {
  try {
    const discovered = await discoverLogs();
    let changed = false;
    const seenHosts = new Set();
    for (const { host, file } of discovered) {
      seenHosts.add(host);
      try {
        const st = await stat(file);
        if (lastMtimeMs.get(host) !== st.mtimeMs) {
          lastMtimeMs.set(host, st.mtimeMs);
          changed = true;
        }
      } catch {
        // file vanished mid-tick; let next tick handle it
      }
    }
    for (const host of lastMtimeMs.keys()) {
      if (!seenHosts.has(host)) {
        lastMtimeMs.delete(host);
        changed = true;
      }
    }
    if (changed) await publishAll();
  } catch {
    // ignore poll errors; keep ticking
  }
}

async function start() {
  await ensureDir();
  await publishAll();
  pollTimer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  console.log(
    `[backup-history] poller started (${POLL_INTERVAL_MS / 1000}s) history_dir=${HISTORY_DIR} local_host=${LOCAL_HOST}`,
  );
}

async function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export default { init: start, stop };
