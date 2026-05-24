// Backup Coverage monitor + acknowledgement writer.
//
// Reads JSON reports produced by scripts/backup-coverage-audit.sh — one
// per host. Neuromancer writes its report locally; remote hosts (e.g.
// wintermute) push their reports here via rsync. The web admin watches
// REPORTS_DIR for *.json files, builds a {host -> report} map, and
// broadcasts via statusEmitter so the frontend's Backup Coverage page
// can render any host.
//
// Acknowledgements are local-only: we can write the ack file for the
// host the web admin runs on (matches os.hostname()), but not remote
// hosts. Remote ack edits would require SSH back to the source host;
// out of scope for now.
//
// Polling: every 30s walks REPORTS_DIR, re-reads any file whose mtime
// has changed. Cheap; portable.

import { readFile, writeFile, stat, readdir, mkdir } from "fs/promises";
import { hostname } from "os";
import path from "path";
import { updateStatus, getStatus } from "./statusEmitter.js";

const REPORTS_DIR =
  process.env.BACKUP_COVERAGE_REPORTS_DIR ||
  "/home/chrisl8/logs/coverage-reports";
const ACK_PATH =
  process.env.BACKUP_COVERAGE_ACK_PATH ||
  "/home/chrisl8/containers/scripts/backup-coverage-acks.json";

const POLL_INTERVAL_MS = 30 * 1000;
const LOCAL_HOST = hostname();

let pollTimer = null;
const lastMtimeMs = new Map(); // host -> mtimeMs

async function ensureReportsDir() {
  try {
    await mkdir(REPORTS_DIR, { recursive: true });
  } catch {
    // ignore; we'll fail on read with a meaningful error if perms are wrong
  }
}

async function loadOneReport(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { error: err.code === "ENOENT" ? "report missing" : err.message };
  }
}

async function discoverReports() {
  let files;
  try {
    files = await readdir(REPORTS_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ host: f.replace(/\.json$/, ""), file: path.join(REPORTS_DIR, f) }));
}

// publishAll: full rebuild of the {hosts, byHost} map and broadcast.
async function publishAll() {
  const discovered = await discoverReports();
  const byHost = {};
  for (const { host, file } of discovered) {
    const report = await loadOneReport(file);
    byHost[host] = report;
  }
  // Stable host order: local first, then alpha.
  const hosts = Object.keys(byHost).sort((a, b) => {
    if (a === LOCAL_HOST) return -1;
    if (b === LOCAL_HOST) return 1;
    return a.localeCompare(b);
  });
  updateStatus("backupCoverage", { localHost: LOCAL_HOST, hosts, byHost });
}

async function tick() {
  try {
    const discovered = await discoverReports();
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
    // Detect deletions too: if a host we used to see is gone, re-publish.
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

async function loadAcks() {
  try {
    const raw = await readFile(ACK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Locally apply an ack/unack to the in-memory state for instant UI feedback.
// On the next audit cycle the disk-persisted ack file is what wins.
function patchEntryAck(host, path, ack) {
  const current = getStatus()?.backupCoverage;
  if (!current?.byHost?.[host]?.entries) return;
  const report = current.byHost[host];
  const entries = report.entries.map((e) =>
    e.path === path ? { ...e, ack } : e,
  );
  const needs_review = entries.filter(
    (e) =>
      (e.status === "uncovered" ||
        e.status === "partial" ||
        e.status === "unreadable") &&
      e.ack == null,
  ).length;
  const acknowledged = entries.filter((e) => e.ack != null).length;
  const covered = entries.filter((e) => e.status === "covered").length;
  const newByHost = {
    ...current.byHost,
    [host]: {
      ...report,
      entries,
      summary: { needs_review, acknowledged, covered },
    },
  };
  updateStatus("backupCoverage", { ...current, byHost: newByHost });
}

export async function acknowledgePath(host, path, reason) {
  if (typeof path !== "string" || !path) {
    return { ok: false, error: "path is required" };
  }
  // Acks are only writable for the LOCAL host's report. Remote acks
  // would require SSH back to the source host.
  if (host && host !== LOCAL_HOST) {
    return {
      ok: false,
      error: `Acknowledgements for ${host} must be set on that host directly (this web admin only manages ${LOCAL_HOST}).`,
    };
  }
  const acks = await loadAcks();
  const filtered = acks.filter((a) => a?.path !== path);
  const ack = {
    path,
    reason: typeof reason === "string" ? reason : "",
    acked_at: new Date().toISOString(),
  };
  filtered.push(ack);
  try {
    await writeFile(ACK_PATH, JSON.stringify(filtered, null, 2), "utf8");
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  patchEntryAck(LOCAL_HOST, path, ack);
  return { ok: true, ack };
}

export async function unacknowledgePath(host, path) {
  if (typeof path !== "string" || !path) {
    return { ok: false, error: "path is required" };
  }
  if (host && host !== LOCAL_HOST) {
    return {
      ok: false,
      error: `Acknowledgements for ${host} must be unset on that host directly.`,
    };
  }
  const acks = await loadAcks();
  const filtered = acks.filter((a) => a?.path !== path);
  try {
    await writeFile(ACK_PATH, JSON.stringify(filtered, null, 2), "utf8");
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  patchEntryAck(LOCAL_HOST, path, null);
  return { ok: true };
}

async function start() {
  await ensureReportsDir();
  await publishAll();
  pollTimer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  console.log(
    `[backup-coverage] poller started (${POLL_INTERVAL_MS / 1000}s) reports_dir=${REPORTS_DIR} local_host=${LOCAL_HOST}`,
  );
}

async function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export default { init: start, stop };
