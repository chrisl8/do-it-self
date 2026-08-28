// Post-update maintenance findings.
//
// Reads JSON findings produced by scripts/post-update-checks/<container>.sh,
// which all-containers.sh runs automatically right after a successful
// `--get-updates` pull/build/restart of that container (see
// scripts/post-update-checks/nextcloud.sh for the first implementation).
//
// Acks are keyed by the finding's own `timestamp`, not just a boolean: an ack
// written for one run is automatically stale (and the finding reappears)
// once a later run produces a new timestamp, without needing to compare
// finding content.

import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";

const REPORTS_DIR =
  process.env.POST_UPDATE_CHECKS_REPORTS_DIR ||
  path.join(homedir(), "logs", "post-update-checks");
const ACKS_DIR =
  process.env.POST_UPDATE_CHECKS_ACKS_DIR || path.join(REPORTS_DIR, "acks");

async function ensureDirs() {
  await mkdir(REPORTS_DIR, { recursive: true }).catch(() => {});
  await mkdir(ACKS_DIR, { recursive: true }).catch(() => {});
}

async function loadAck(container) {
  try {
    const raw = await readFile(
      path.join(ACKS_DIR, `${container}.json`),
      "utf8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getFindings() {
  await ensureDirs();
  let files;
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    return {};
  }
  const byContainer = {};
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const container = file.replace(/\.json$/, "");
    try {
      const finding = JSON.parse(
        await readFile(path.join(REPORTS_DIR, file), "utf8"),
      );
      const ack = await loadAck(container);
      const acknowledged = ack?.timestamp === finding.timestamp;
      byContainer[container] = {
        ...finding,
        acknowledged,
        needsAttention: finding.status !== "clean" && !acknowledged,
      };
    } catch (err) {
      byContainer[container] = {
        status: "error",
        note: `Failed to read findings: ${err?.message || err}`,
        acknowledged: false,
        needsAttention: true,
      };
    }
  }
  return byContainer;
}

export async function acknowledge(container) {
  if (typeof container !== "string" || !container) {
    return { ok: false, error: "container is required" };
  }
  await ensureDirs();
  let finding;
  try {
    finding = JSON.parse(
      await readFile(path.join(REPORTS_DIR, `${container}.json`), "utf8"),
    );
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "no findings for this container",
    };
  }
  try {
    await writeFile(
      path.join(ACKS_DIR, `${container}.json`),
      JSON.stringify(
        { timestamp: finding.timestamp, ackedAt: new Date().toISOString() },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  return { ok: true };
}
