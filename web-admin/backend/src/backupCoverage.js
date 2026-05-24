// Backup Coverage monitor + central ack store.
//
// Reads JSON reports produced by scripts/backup-coverage-audit.sh — one
// per host. Neuromancer writes its report locally; remote hosts (e.g.
// wintermute) push their reports via rsync. The web admin watches
// REPORTS_DIR for *.json files, builds a {host -> report} map, and
// broadcasts via statusEmitter so the Backup Coverage page can render
// any host.
//
// **Acks live centrally on neuromancer.** Each host has its own ack
// file under ACKS_DIR (e.g. <ACKS_DIR>/wintermute.json). The web admin
// can write any host's ack file directly — there's no SSH-back to a
// remote host, just local writes. At report-load time we *overlay* the
// central acks onto the corresponding report's entries (matching by
// path) and recompute the summary. That makes the central store the
// source of truth from the UI's perspective: even if a remote host's
// audit hasn't yet learned about a new ack, the UI shows it correctly,
// and the next report push from that host is overlaid the same way.
//
// The audit on a remote host still reads its own local ack file when
// classifying — that's fine, because the overlay corrects whatever it
// produced. If you want a remote audit log to reflect web-admin acks
// without waiting for the overlay, you can manually rsync the central
// ack file to the remote host; the audit will pick it up on its next
// run. Optional and not required for the UI to be correct.

import { readFile, writeFile, stat, readdir, mkdir } from "fs/promises";
import { hostname } from "os";
import path from "path";
import { updateStatus, getStatus } from "./statusEmitter.js";

const REPORTS_DIR =
  process.env.BACKUP_COVERAGE_REPORTS_DIR ||
  "/home/chrisl8/logs/coverage-reports";
const ACKS_DIR =
  process.env.BACKUP_COVERAGE_ACKS_DIR ||
  "/home/chrisl8/containers/scripts/backup-coverage-acks";

const POLL_INTERVAL_MS = 30 * 1000;
const LOCAL_HOST = hostname();

let pollTimer = null;
const lastMtimeMs = new Map(); // host -> mtimeMs of report file

async function ensureDirs() {
  await mkdir(REPORTS_DIR, { recursive: true }).catch(() => {});
  await mkdir(ACKS_DIR, { recursive: true }).catch(() => {});
}

async function loadOneReport(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { error: err.code === "ENOENT" ? "report missing" : err.message };
  }
}

async function loadAcksFor(host) {
  try {
    const raw = await readFile(path.join(ACKS_DIR, `${host}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAcksFor(host, acks) {
  await writeFile(
    path.join(ACKS_DIR, `${host}.json`),
    JSON.stringify(acks, null, 2),
    "utf8",
  );
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
    .map((f) => ({
      host: f.replace(/\.json$/, ""),
      file: path.join(REPORTS_DIR, f),
    }));
}

// Overlay central acks onto a report's entries. The report from the
// audit may already have its own acks pre-resolved; central acks win
// (web admin is the source of truth). Returns a *new* report; doesn't
// mutate the input.
function overlayAcks(report, acks) {
  if (!report || !Array.isArray(report.entries)) return report;
  const ackByPath = new Map(
    (acks || []).filter((a) => a && a.path).map((a) => [a.path, a]),
  );
  const entries = report.entries.map((e) => {
    if (ackByPath.has(e.path)) return { ...e, ack: ackByPath.get(e.path) };
    // If the report's pre-resolved ack is no longer in the central
    // store, clear it (an un-ack via web admin should reflect immediately).
    if (e.ack && !ackByPath.has(e.path)) return { ...e, ack: null };
    return e;
  });
  const needs_review = entries.filter(
    (e) =>
      (e.status === "uncovered" ||
        e.status === "partial" ||
        e.status === "unreadable") &&
      e.ack == null,
  ).length;
  const acknowledged = entries.filter((e) => e.ack != null).length;
  const covered = entries.filter((e) => e.status === "covered").length;
  return {
    ...report,
    entries,
    summary: { needs_review, acknowledged, covered },
  };
}

async function publishAll() {
  const discovered = await discoverReports();
  const byHost = {};
  for (const { host, file } of discovered) {
    const rawReport = await loadOneReport(file);
    const acks = await loadAcksFor(host);
    byHost[host] = overlayAcks(rawReport, acks);
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

// Locally apply an ack/unack to the in-memory state for instant UI
// feedback. The disk-persisted central ack file is what wins on the
// next publishAll() (e.g. when a new report arrives).
function patchEntryAck(host, entryPath, ack) {
  const current = getStatus()?.backupCoverage;
  if (!current?.byHost?.[host]?.entries) return;
  const report = current.byHost[host];
  const entries = report.entries.map((e) =>
    e.path === entryPath ? { ...e, ack } : e,
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

export async function acknowledgePath(host, entryPath, reason) {
  if (typeof entryPath !== "string" || !entryPath) {
    return { ok: false, error: "path is required" };
  }
  if (typeof host !== "string" || !host) {
    return { ok: false, error: "host is required" };
  }
  const acks = await loadAcksFor(host);
  const filtered = acks.filter((a) => a?.path !== entryPath);
  const ack = {
    path: entryPath,
    reason: typeof reason === "string" ? reason : "",
    acked_at: new Date().toISOString(),
  };
  filtered.push(ack);
  try {
    await saveAcksFor(host, filtered);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  patchEntryAck(host, entryPath, ack);
  return { ok: true, ack };
}

export async function unacknowledgePath(host, entryPath) {
  if (typeof entryPath !== "string" || !entryPath) {
    return { ok: false, error: "path is required" };
  }
  if (typeof host !== "string" || !host) {
    return { ok: false, error: "host is required" };
  }
  const acks = await loadAcksFor(host);
  const filtered = acks.filter((a) => a?.path !== entryPath);
  try {
    await saveAcksFor(host, filtered);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  patchEntryAck(host, entryPath, null);
  return { ok: true };
}

async function start() {
  await ensureDirs();
  await publishAll();
  pollTimer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  console.log(
    `[backup-coverage] poller started (${POLL_INTERVAL_MS / 1000}s) reports_dir=${REPORTS_DIR} acks_dir=${ACKS_DIR} local_host=${LOCAL_HOST}`,
  );
}

async function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export default { init: start, stop };
