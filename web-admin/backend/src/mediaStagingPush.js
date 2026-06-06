// Media Staging — SENDER side (runs on the source host, e.g. neuromancer).
//
// The client (deepthought) cannot reach this host, but this host CAN reach the
// client. So this module PUSHES media: it polls the client's spool over SSH,
// claims pending jobs, rsyncs the files into the client's Jellyfin mount, and
// writes status back into the spool for the client's UI to display. The flow
// mirrors the backup-coverage push (manager reaches client; client never
// reaches back).
//
// Active only where a `mediaStagingPush:` block exists in user-config.yaml.
//
// SSH: a single dedicated key per client, from-restricted to this host's
// Tailscale IP (see docs/MEDIA_STAGING_SETUP.md). All transfers and spool I/O
// ride that one key with a persistent ControlMaster connection.

import { spawn } from "child_process";
import os from "os";
import { join } from "path";
import { getUserConfig } from "./configRegistry.js";

const POLL_INTERVAL_MS_DEFAULT = 10 * 1000;
const STATUS_THROTTLE_MS = 3 * 1000;
const CANCEL_CHECK_MS = 5 * 1000;
const STALE_CLAIM_MS = 2 * 60 * 1000; // re-claim a job whose owner died mid-copy
const RSYNC_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SSH_OP_TIMEOUT_MS = 20 * 1000;

let tickTimer = null;
let tickInFlight = false;
let activeJob = null; // { id, client, child } — single-flight across all clients

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  return p;
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// A library can span several folders, each backed by its own host source_root
// and tied to the receiver by a `key`. Normalize to { name, folders[] } where
// each folder is { key, sourceRoot }. Legacy single-source_root configs become
// a one-folder list with key "default".
function normalizeLibrary(l) {
  if (!l?.name) return null;
  let folders = [];
  if (Array.isArray(l.folders) && l.folders.length > 0) {
    folders = l.folders
      .filter((f) => f?.source_root)
      .map((f, i) => ({
        key: f.key || `f${i}`,
        sourceRoot: expandHome(f.source_root),
      }));
  } else if (l.source_root) {
    folders = [{ key: "default", sourceRoot: expandHome(l.source_root) }];
  }
  return { name: l.name, folders };
}

// ── config ──────────────────────────────────────────────────────
async function readConfig() {
  const config = await getUserConfig();
  const mp = config?.mediaStagingPush;
  if (!mp || !mp.enabled || !Array.isArray(mp.clients)) return null;
  const clients = mp.clients
    .filter((c) => c?.name && c?.host && c?.ssh_user && c?.ssh_key_path)
    .map((c) => ({
      name: c.name,
      host: c.host,
      sshUser: c.ssh_user,
      sshKey: expandHome(c.ssh_key_path),
      spoolDir: c.spool_dir || "~/media-staging",
      libraries: (Array.isArray(c.libraries) ? c.libraries : [])
        .map(normalizeLibrary)
        .filter((l) => l && l.folders.length > 0),
    }));
  if (clients.length === 0) return null;
  return {
    enabled: true,
    clients,
    pollIntervalMs: (mp.poll_interval_seconds || 10) * 1000,
  };
}

// ── SSH primitives ──────────────────────────────────────────────
function sshOpts(client) {
  return [
    "-i",
    client.sshKey,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(os.tmpdir(), `media-staging-push-${client.name}-%C`)}`,
    "-o",
    "ControlPersist=300",
  ];
}

// Remote shell string used as rsync's -e transport (no media paths here, so
// space-splitting in this string is safe).
function rshString(client) {
  return ["ssh", ...sshOpts(client)].join(" ");
}

function remoteExec(
  client,
  command,
  { input, timeoutMs = SSH_OP_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [
      ...sshOpts(client),
      `${client.sshUser}@${client.host}`,
      command,
    ]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function listRemote(client, dir) {
  const { stdout } = await remoteExec(
    client,
    `ls -1 ${shQuote(dir)} 2>/dev/null`,
  );
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readRemoteJson(client, path) {
  const { code, stdout } = await remoteExec(
    client,
    `cat ${shQuote(path)} 2>/dev/null`,
  );
  if (code !== 0 || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function remoteExists(client, path) {
  const { stdout } = await remoteExec(
    client,
    `test -e ${shQuote(path)} && echo y || true`,
  );
  return stdout.trim() === "y";
}

async function writeRemoteStatus(client, statusPath, obj) {
  const tmp = `${statusPath}.tmp`;
  await remoteExec(
    client,
    `cat > ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(statusPath)}`,
    { input: JSON.stringify(obj) },
  );
}

// ── job discovery ───────────────────────────────────────────────
function paths(client) {
  const base = client.spoolDir;
  return {
    pending: `${base}/pending`,
    status: `${base}/status`,
    cancel: `${base}/cancel`,
    statusFile: (id) => `${base}/status/${id}.json`,
    pendingFile: (id) => `${base}/pending/${id}.json`,
    cancelFile: (id) => `${base}/cancel/${id}`,
  };
}

// Find the next eligible job across all clients. Eligible = pending file with
// no status, or a stale claimed/copying status (previous owner died).
async function findNextJob(cfg) {
  for (const client of cfg.clients) {
    const p = paths(client);
    const ids = (await listRemote(client, p.pending))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""));
    for (const id of ids) {
      const status = await readRemoteJson(client, p.statusFile(id));
      if (status) {
        const { state, updatedEpoch } = status;
        if (state === "done" || state === "failed" || state === "cancelled") {
          continue;
        }
        const stale =
          !updatedEpoch || nowEpoch() - updatedEpoch > STALE_CLAIM_MS / 1000;
        if (!stale) continue; // owned/fresh elsewhere
      }
      const job = await readRemoteJson(client, p.pendingFile(id));
      if (job) return { client, job, p };
    }
  }
  return null;
}

function sourceRootFor(client, libraryName, folderKey) {
  const lib = client.libraries.find((l) => l.name === libraryName);
  if (!lib) return null;
  // Match the folder the receiver tagged the job with; fall back to the first
  // folder for legacy jobs written before folderKey existed.
  const folder = folderKey
    ? lib.folders.find((f) => f.key === folderKey)
    : lib.folders[0];
  return folder?.sourceRoot || null;
}

// ── running a transfer ──────────────────────────────────────────
async function runJob({ client, job, p }) {
  const id = job.id;
  const setStatus = (extra) =>
    writeRemoteStatus(client, p.statusFile(id), {
      id,
      updatedEpoch: nowEpoch(),
      ...extra,
    });

  // Honor a cancel requested before we started.
  if (await remoteExists(client, p.cancelFile(id))) {
    await setStatus({ state: "cancelled", percent: 0 });
    return;
  }

  const sourceRoot = sourceRootFor(client, job.library, job.folderKey);
  if (!sourceRoot) {
    await setStatus({
      state: "failed",
      error: `no source_root configured for library "${job.library}"${job.folderKey ? ` folder "${job.folderKey}"` : ""}`,
    });
    return;
  }

  await setStatus({ state: "claimed", percent: 0 });

  // Ensure the dest library root exists (rsync --relative creates the rest).
  await remoteExec(client, `mkdir -p ${shQuote(job.destRoot)}`);

  const sourceArg = `${sourceRoot.replace(/\/+$/, "")}/./${job.rel}`;
  const target = `${client.sshUser}@${client.host}:${job.destRoot.replace(/\/+$/, "")}/`;
  const args = [
    "-a",
    "--relative",
    "--partial",
    "--append-verify",
    "--protect-args", // safe filenames with spaces / special chars
    "--info=progress2",
    "--no-inc-recursive",
    "-e",
    rshString(client),
    sourceArg,
    target,
  ];

  const PROGRESS_RE = /([\d,]+)\s+(\d+)%\s+(\S+)\s+(\d+:\d{2}:\d{2})/;
  let percent = 0;
  let rate = null;
  let eta = null;
  let lastWrite = 0;

  const child = spawn("rsync", args);
  activeJob = { id, client, child };
  const timer = setTimeout(() => child.kill("SIGTERM"), RSYNC_TIMEOUT_MS);

  // Poll the cancel marker; SIGTERM the transfer if the client asked to stop.
  const cancelTimer = setInterval(async () => {
    if (await remoteExists(client, p.cancelFile(id))) child.kill("SIGTERM");
  }, CANCEL_CHECK_MS);

  const onChunk = (buf) => {
    for (const line of buf.toString().split(/[\r\n]+/)) {
      const m = PROGRESS_RE.exec(line.trim());
      if (!m) continue;
      percent = Number(m[2]);
      rate = m[3];
      eta = m[4];
      const now = Date.now();
      if (now - lastWrite >= STATUS_THROTTLE_MS) {
        lastWrite = now;
        setStatus({ state: "copying", percent, rate, eta }).catch(() => {});
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  await new Promise((resolve) => {
    child.on("error", async (err) => {
      clearTimeout(timer);
      clearInterval(cancelTimer);
      await setStatus({ state: "failed", percent, error: err.message });
      resolve();
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearInterval(cancelTimer);
      const cancelled = await remoteExists(client, p.cancelFile(id));
      if (cancelled) {
        await setStatus({ state: "cancelled", percent });
      } else if (code === 0) {
        await setStatus({ state: "done", percent: 100 });
      } else {
        await setStatus({
          state: "failed",
          percent,
          error: `rsync exited ${code}`,
        });
      }
      resolve();
    });
  });
}

// ── poller ──────────────────────────────────────────────────────
async function tick() {
  if (tickInFlight || activeJob) return;
  tickInFlight = true;
  try {
    const cfg = await readConfig();
    if (!cfg) return;
    const next = await findNextJob(cfg);
    if (!next) return;
    activeJob = { id: next.job.id, client: next.client }; // claim slot
    runJob(next)
      .catch((err) =>
        console.error("[mediaStagingPush] job error:", err?.message || err),
      )
      .finally(() => {
        activeJob = null;
      });
  } catch (err) {
    console.error("[mediaStagingPush] poll error:", err?.message || err);
  } finally {
    tickInFlight = false;
  }
}

async function start() {
  const cfg = await readConfig();
  const interval = cfg?.pollIntervalMs || POLL_INTERVAL_MS_DEFAULT;
  tick();
  tickTimer = setInterval(tick, interval);
  console.log(`[mediaStagingPush] sender poller started (${interval / 1000}s)`);
}

async function stop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export default { init: start, stop };
