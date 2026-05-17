// Backup Coverage monitor + acknowledgement writer.
//
// Reads the JSON report produced by scripts/backup-coverage-audit.sh
// (hourly cron on neuromancer) and broadcasts it via statusEmitter so the
// frontend's Backup Coverage page can render it. Handles the
// "Acknowledge" button by appending to the ack JSON file the audit script
// reads on its next run.
//
// File polling: the report changes hourly. We poll mtime every 30s and
// re-read on change. Cheap; avoids fs.watch portability headaches.

import { readFile, writeFile, stat } from "fs/promises";
import { updateStatus, getStatus } from "./statusEmitter.js";

const REPORT_PATH =
  process.env.BACKUP_COVERAGE_REPORT_PATH ||
  "/home/chrisl8/logs/backup-coverage-audit.json";
const ACK_PATH =
  process.env.BACKUP_COVERAGE_ACK_PATH ||
  "/home/chrisl8/containers/scripts/backup-coverage-acks.json";

const POLL_INTERVAL_MS = 30 * 1000;

let pollTimer = null;
let lastMtimeMs = 0;

async function loadReport() {
  try {
    const raw = await readFile(REPORT_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {
      host: null,
      audited_at: null,
      summary: { needs_review: 0, acknowledged: 0, covered: 0 },
      entries: [],
      exclude_patterns: [],
      error:
        err.code === "ENOENT"
          ? "Coverage report not generated yet — run scripts/backup-coverage-audit.sh."
          : err.message,
    };
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

async function publishReport() {
  const report = await loadReport();
  updateStatus("backupCoverage", report);
}

async function tick() {
  try {
    const st = await stat(REPORT_PATH);
    const mtimeMs = st.mtimeMs;
    if (mtimeMs > lastMtimeMs) {
      lastMtimeMs = mtimeMs;
      await publishReport();
    }
  } catch {
    // File doesn't exist yet — publish the empty/error state once, then
    // sit quietly until the cron fires.
    if (lastMtimeMs === 0) {
      lastMtimeMs = -1;
      await publishReport();
    }
  }
}

// Re-render the in-memory report immediately after an ack, so the UI
// reflects the change without waiting for the next hourly audit. The
// next audit will produce a freshly-classified copy on its own.
function markAckedInMemory(path, ack) {
  const current = getStatus()?.backupCoverage;
  if (!current || !Array.isArray(current.entries)) return;
  const updatedEntries = current.entries.map((e) =>
    e.path === path ? { ...e, ack } : e,
  );
  const needs_review = updatedEntries.filter(
    (e) =>
      (e.status === "uncovered" ||
        e.status === "partial" ||
        e.status === "unreadable") &&
      e.ack == null,
  ).length;
  const acknowledged = updatedEntries.filter((e) => e.ack != null).length;
  const covered = updatedEntries.filter((e) => e.status === "covered").length;
  updateStatus("backupCoverage", {
    ...current,
    entries: updatedEntries,
    summary: { needs_review, acknowledged, covered },
  });
}

function markUnackedInMemory(path) {
  const current = getStatus()?.backupCoverage;
  if (!current || !Array.isArray(current.entries)) return;
  const updatedEntries = current.entries.map((e) =>
    e.path === path ? { ...e, ack: null } : e,
  );
  const needs_review = updatedEntries.filter(
    (e) =>
      (e.status === "uncovered" ||
        e.status === "partial" ||
        e.status === "unreadable") &&
      e.ack == null,
  ).length;
  const acknowledged = updatedEntries.filter((e) => e.ack != null).length;
  const covered = updatedEntries.filter((e) => e.status === "covered").length;
  updateStatus("backupCoverage", {
    ...current,
    entries: updatedEntries,
    summary: { needs_review, acknowledged, covered },
  });
}

export async function acknowledgePath(path, reason) {
  if (typeof path !== "string" || !path) {
    return { ok: false, error: "path is required" };
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
  markAckedInMemory(path, ack);
  return { ok: true, ack };
}

export async function unacknowledgePath(path) {
  if (typeof path !== "string" || !path) {
    return { ok: false, error: "path is required" };
  }
  const acks = await loadAcks();
  const filtered = acks.filter((a) => a?.path !== path);
  try {
    await writeFile(ACK_PATH, JSON.stringify(filtered, null, 2), "utf8");
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  markUnackedInMemory(path);
  return { ok: true };
}

async function start() {
  // Initial publish, then poll for mtime changes.
  await tick();
  pollTimer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  console.log(
    `[backup-coverage] poller started (${POLL_INTERVAL_MS / 1000}s)`,
  );
}

async function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export default { init: start, stop };
