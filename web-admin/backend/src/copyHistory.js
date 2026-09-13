// Durable copy-history ledger — runs on the SENDER host (neuromancer).
//
// mediaStagingPush.js knows the moment a transfer actually finishes (rsync
// exits 0); that's the one place with the full job context (label, size,
// paths) in scope, so it's the only writer. This module just owns the
// on-disk ledger: a single JSON array file, rewritten atomically, since a
// personal household's copy history is small enough that a real database
// would be overkill (see mediaStaging.js's writeJson()/readJson() for the
// same pattern applied to spool state).
//
// Later features (Seerr request matching, watched-status polling) fill in
// the nullable fields below after the fact; this module never fabricates
// them.

import { randomUUID } from "crypto";
import os from "os";
import { join } from "path";
import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { updateStatus } from "./statusEmitter.js";

const HISTORY_DIR = join(os.homedir(), "media-staging", "history");
const HISTORY_FILE = join(HISTORY_DIR, "copy-history.json");
const MAX_ENTRIES = 5000; // trim oldest beyond this so the file can't grow unbounded

async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function writeHistory(entries) {
  await mkdir(HISTORY_DIR, { recursive: true });
  const tmp = `${HISTORY_FILE}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, entries }, null, 2),
    "utf8",
  );
  await rename(tmp, HISTORY_FILE);
}

// Record a completed transfer. Called from mediaStagingPush.js's runJob()
// right after rsync exits 0, so `job` is the same object read from the
// pending spool file (id, library, folderKey, kind, rel, label, sizeBytes,
// destRoot, destPath, createdEpoch) and `client` is the destination config
// ({ name, host, ... }).
async function recordCopy({ client, job, completedEpoch }) {
  const entries = await readHistory();
  const entry = {
    id: randomUUID(),
    jobId: job.id,
    client: client.name,
    library: job.library,
    kind: job.kind,
    label: job.label,
    rel: job.rel,
    sizeBytes: typeof job.sizeBytes === "number" ? job.sizeBytes : null,
    destPath: job.destPath,
    startedEpoch: job.createdEpoch ?? null,
    completedEpoch,
    seerrRequestId: null,
    seerrMediaId: job.mediaId || null,
    watched: null,
    notifiedEpoch: null,
  };
  entries.push(entry);
  const trimmed =
    entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
  await writeHistory(trimmed);
  updateStatus("copyHistory", { lastUpdatedEpoch: completedEpoch });

  // Soft dependency: Seerr integration is optional and lives in its own
  // module. A dynamic import means copyHistory works standalone (and never
  // fails a copy) whether or not that feature is configured or even present.
  try {
    const seerrLedger = await import("./seerrLedger.js");
    await seerrLedger.matchAndNotify(entry);
  } catch (err) {
    console.error("[copyHistory] seerr match/notify failed:", err);
  }
}

// Called by seerrLedger once it has matched a copy to a request and (if
// possible) sent the "ready" email, so the copy-history row shows the link.
async function linkSeerrRequest(id, { seerrRequestId, notifiedEpoch }) {
  const entries = await readHistory();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  entries[idx] = {
    ...entries[idx],
    seerrRequestId: seerrRequestId ?? entries[idx].seerrRequestId,
    notifiedEpoch: notifiedEpoch ?? entries[idx].notifiedEpoch,
  };
  await writeHistory(entries);
}

async function updateWatchedStatus(id, watched) {
  const entries = await readHistory();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], watched };
  await writeHistory(entries);
}

async function listCopyHistory({ limit, client } = {}) {
  let entries = await readHistory();
  if (client) entries = entries.filter((e) => e.client === client);
  entries = entries.slice().reverse(); // newest first
  if (typeof limit === "number") entries = entries.slice(0, limit);
  return entries;
}

export { recordCopy, listCopyHistory, linkSeerrRequest, updateWatchedStatus };
