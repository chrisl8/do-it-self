// Backup Pi monitor + action runner.
//
// Two SSH paths into the Pi:
//   1. webadmin path  (pi-rpc.sh)  → status JSON, apt-upgrade, reboot.
//      Uses backuppi.ssh_user / backuppi.ssh_key_path.
//   2. manager  path  (borg-manage.sh) → borg verbs (check, prune,
//      list-last, restore-test, extract). Uses backuppi.mgmt_ssh_user /
//      backuppi.mgmt_ssh_key_path, with BORG_PASSPHRASE forwarded via SSH
//      SendEnv. The Pi never stores borg passphrases at rest.
//
// Passphrases are fetched from Infisical at use-time and cached for a few
// minutes. Pattern mirrors scripts/borg-backup.sh's load_secret().
//
// Config: read from user-config.yaml `backuppi:` block on every poll/action.
// Per-client metadata (name, repo, freshness threshold, infisical secret
// key) lives in backuppi.clients[].

import { spawn } from "child_process";
import os from "os";
import { join } from "path";
import { getUserConfig } from "./configRegistry.js";
import { getSecret, setSecret } from "./infisicalClient.js";
import { updateStatus, getStatus } from "./statusEmitter.js";

const POLL_INTERVAL_MS_DEFAULT = 60 * 1000;
const POLL_TIMEOUT_MS = 15 * 1000;
const ACTION_TIMEOUT_MS = 30 * 60 * 1000; // apt upgrade can take a while
const PASSPHRASE_CACHE_TTL_MS = 5 * 60 * 1000;

// pi-rpc.sh's verb whitelist (matches scripts/setup-backup-pi.sh STEP 19b).
const RPC_ACTIONS = new Set(["apt-upgrade", "reboot"]);

// borg-manage.sh's verb whitelist (matches scripts/setup-backup-pi.sh STEP 10).
const MGMT_VERBS = new Set([
  "check",
  "prune",
  "compact",
  "list",
  "list-last",
  "info",
]);

let tickTimer = null;
let tickInFlight = false;
let activeAction = null; // { action, ws } when something is running

// In-memory passphrase cache keyed by `${path}/${key}`. Avoids hammering the
// Infisical CLI every 60s during status polls.
const passphraseCache = new Map(); // key → { value, expiresAt }

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  return p;
}

function sshControlPath(prefix) {
  return join(os.tmpdir(), `${prefix}-ssh-%C`);
}

function buildSshArgs({ key, user, host, command, controlPrefix, sendEnv = [] }) {
  const args = [
    "-i", expandHome(key),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sshControlPath(controlPrefix)}`,
    "-o", "ControlPersist=300",
  ];
  for (const name of sendEnv) {
    args.push("-o", `SendEnv=${name}`);
  }
  args.push(`${user}@${host}`, command);
  return args;
}

async function readConfig() {
  const config = await getUserConfig();
  const bp = config.backuppi;
  if (!bp || !bp.enabled || !bp.host || !bp.ssh_user || !bp.ssh_key_path) {
    return null;
  }
  return {
    enabled: true,
    host: bp.host,
    rpcUser: bp.ssh_user,
    rpcKey: bp.ssh_key_path,
    mgmtUser: bp.mgmt_ssh_user || "borg",
    mgmtKey: bp.mgmt_ssh_key_path || "~/.ssh/borg-pi-mgmt",
    clients: Array.isArray(bp.clients) ? bp.clients : [],
  };
}

// ── Infisical passphrase fetch ──────────────────────────────────
// Uses the in-process Infisical REST client (infisicalClient.js). Returns
// null on missing/unreachable. Caches for 5 minutes to avoid hitting the
// API every 60s status poll.
async function getPassphraseFromInfisical(infisicalPath, infisicalKey) {
  const cacheKey = `${infisicalPath}/${infisicalKey}`;
  const cached = passphraseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const value = await getSecret(infisicalKey, infisicalPath);
    if (!value) return null;
    passphraseCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PASSPHRASE_CACHE_TTL_MS,
    });
    return value;
  } catch {
    return null;
  }
}

// Invalidate one cache entry (used after a successful set).
function invalidatePassphraseCache(infisicalPath, infisicalKey) {
  passphraseCache.delete(`${infisicalPath}/${infisicalKey}`);
}

// Write a client's borg passphrase to Infisical via the REST API.
// Looks up the infisical_path + infisical_key from the user-config backuppi
// entry for the named client, then calls setSecret.
export async function setClientPassphrase(clientName, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    return { ok: false, error: "passphrase is empty" };
  }
  const cfg = await readConfig();
  if (!cfg) {
    return { ok: false, error: "backuppi not configured" };
  }
  const entry = cfg.clients.find((c) => c?.name === clientName);
  if (!entry) {
    return {
      ok: false,
      error:
        `Client '${clientName}' is not in backuppi.clients in ` +
        `~/containers/user-config.yaml. Add an entry with { name, ` +
        `infisical_path, infisical_key } and try again (no web admin ` +
        `restart needed — config is re-read on each request).`,
    };
  }
  if (!entry.infisical_key) {
    return {
      ok: false,
      error: `Client '${clientName}' has no infisical_key in backuppi.clients`,
    };
  }
  const path = entry.infisical_path || "/borgbackup";
  try {
    await setSecret(entry.infisical_key, passphrase, path);
    invalidatePassphraseCache(path, entry.infisical_key);
    return { ok: true, key: entry.infisical_key, path };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Build the env object for `spawn` — combines per-client BORG_PASSPHRASE_<UPPER>
// vars with the existing process env. Returns { env, sendEnvNames }.
async function buildPassphraseEnv(cfg) {
  const env = { ...process.env };
  const sendEnvNames = [];
  for (const client of cfg.clients) {
    if (!client?.name || !client?.infisical_key) continue;
    const upper = client.name.replace(/-/g, "_").toUpperCase();
    const path = client.infisical_path || "/borgbackup";
    const value = await getPassphraseFromInfisical(path, client.infisical_key);
    if (value) {
      const varName = `BORG_PASSPHRASE_${upper}`;
      env[varName] = value;
      sendEnvNames.push(varName);
    }
  }
  return { env, sendEnvNames };
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const cfg = await readConfig();
    if (!cfg) {
      updateStatus("backuppi", { enabled: false });
      return;
    }
    await pollOnce(cfg);
  } catch (err) {
    console.error("[backuppi] poll error:", err?.message || err);
    updateStatus("backuppi", {
      enabled: true,
      reachable: false,
      error: err?.message || String(err),
      fetched_epoch: Math.floor(Date.now() / 1000),
    });
  } finally {
    tickInFlight = false;
  }
}

async function pollOnce(cfg) {
  const { env, sendEnvNames } = await buildPassphraseEnv(cfg);
  const args = buildSshArgs({
    key: cfg.rpcKey,
    user: cfg.rpcUser,
    host: cfg.host,
    command: "status",
    controlPrefix: "backuppi-rpc",
    sendEnv: sendEnvNames,
  });
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), POLL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      updateStatus("backuppi", {
        enabled: true,
        reachable: false,
        error: err.message,
        fetched_epoch: Math.floor(Date.now() / 1000),
      });
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        updateStatus("backuppi", {
          enabled: true,
          reachable: false,
          error: stderr.slice(0, 500) || `ssh exited ${code}`,
          fetched_epoch: Math.floor(Date.now() / 1000),
        });
        return resolve();
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        updateStatus("backuppi", {
          enabled: true,
          reachable: false,
          error: "Unable to parse status JSON from Pi",
          fetched_epoch: Math.floor(Date.now() / 1000),
        });
        return resolve();
      }
      const previous = getStatus()?.backuppi || {};
      // Per-client staleness — based on last_archive_iso (if passphrase
      // forwarded) or last_activity_iso (filesystem fallback) vs the
      // client's freshness_hours from user-config.yaml.
      const nowEpoch = parsed.now_epoch || Math.floor(Date.now() / 1000);
      const clientsEnriched = (parsed.clients || []).map((c) => {
        const cfgEntry = cfg.clients.find((x) => x?.name === c.name);
        const thresholdHours = cfgEntry?.freshness_hours || 48;
        const iso = c.last_archive_iso || "";
        let ageHours = null;
        if (iso) {
          const t = parseBorgArchiveTimestamp(iso);
          if (!Number.isNaN(t)) {
            ageHours = (nowEpoch * 1000 - t) / 3600000;
          }
        }
        const stale = ageHours == null ? false : ageHours > thresholdHours;
        return {
          ...c,
          freshness_threshold_hours: thresholdHours,
          age_hours: ageHours,
          stale,
        };
      });
      const any_client_stale = clientsEnriched.some(
        (c) => c.stale || c.error,
      );
      updateStatus("backuppi", {
        enabled: true,
        reachable: true,
        fetched_epoch: Math.floor(Date.now() / 1000),
        last_action: previous.last_action || null,
        any_client_stale,
        ...parsed,
        clients: clientsEnriched,
      });
      resolve();
    });
  });
}

// Permissive parser for the `last_archive_iso` field from pi-status.sh.
// Older pi-status.sh emits borg's default `{time}` format ("Fri, 2026-05-15
// 03:25:40"); newer emits `{isoformat}` ("2026-05-15T03:25:40"). JavaScript's
// Date.parse handles ISO but not the day-of-week variant. Returns ms epoch
// or NaN on failure.
function parseBorgArchiveTimestamp(s) {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = /^(?:[A-Za-z]{3},\s+)?(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) {
    t = Date.parse(`${m[1]}T${m[2]}`);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return; // 1 = WebSocket OPEN
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Client gone mid-send; nothing to do.
  }
}

// Parse an action name into either an RPC verb or a mgmt verb + client.
// Returns { kind: "rpc", verb } | { kind: "mgmt", verb, client } | null.
function parseAction(action, knownClientNames) {
  if (RPC_ACTIONS.has(action)) {
    return { kind: "rpc", verb: action };
  }
  // borg-check, borg-prune (no -<name>) → mgmt verb against all clients
  if (action === "borg-check" || action === "borg-prune") {
    const verb = action.replace(/^borg-/, "");
    return { kind: "mgmt", verb, client: null };
  }
  // borg-check-<name>, borg-prune-<name> → mgmt verb against one client
  const m = /^borg-(check|prune)-(.+)$/.exec(action);
  if (m && knownClientNames.includes(m[2])) {
    return { kind: "mgmt", verb: m[1], client: m[2] };
  }
  return null;
}

export const ALLOWED_ACTIONS = new Set([...RPC_ACTIONS, "borg-check", "borg-prune"]);

export async function runAction(action, ws) {
  const cfg = await readConfig();
  if (!cfg) {
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success: false,
      error: "backuppi not configured (set backuppi.enabled in user-config.yaml)",
    });
    return;
  }
  const knownClientNames = cfg.clients.map((c) => c?.name).filter(Boolean);
  const parsed = parseAction(action, knownClientNames);
  if (!parsed) {
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success: false,
      error: "action not in allowed set",
    });
    return;
  }
  if (activeAction) {
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success: false,
      error: `another action is already running: ${activeAction.action}`,
    });
    return;
  }

  activeAction = { action, ws };
  safeSend(ws, { type: "backupPiActionStarted", action });

  try {
    if (parsed.kind === "rpc") {
      await runRpcAction(cfg, action, parsed.verb, ws);
    } else {
      // mgmt verb. If no client, run for every configured client in sequence.
      const targets = parsed.client ? [parsed.client] : knownClientNames;
      let allOk = true;
      let lastCode = 0;
      for (const clientName of targets) {
        const { code, ok } = await runMgmtVerb(cfg, action, parsed.verb, clientName, ws);
        lastCode = code;
        if (!ok) allOk = false;
      }
      finishAction(action, allOk, lastCode, ws);
    }
  } catch (err) {
    activeAction = null;
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success: false,
      error: err?.message || String(err),
    });
  }
}

function runRpcAction(cfg, actionLabel, verb, ws) {
  return new Promise((resolve) => {
    const args = buildSshArgs({
      key: cfg.rpcKey,
      user: cfg.rpcUser,
      host: cfg.host,
      command: `action ${verb}`,
      controlPrefix: "backuppi-rpc",
    });
    const child = spawn("ssh", args);
    const timer = setTimeout(() => child.kill("SIGTERM"), ACTION_TIMEOUT_MS);
    pipeChildToWs(child, actionLabel, ws);
    child.on("error", (err) => {
      clearTimeout(timer);
      finishAction(actionLabel, false, null, ws, err.message);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Reboot drops the SSH socket; ssh client reports 255. Treat as success.
      const ok = verb === "reboot" ? code === 0 || code === 255 : code === 0;
      finishAction(actionLabel, ok, code, ws);
      resolve();
    });
  });
}

async function runMgmtVerb(cfg, actionLabel, verb, clientName, ws) {
  // Fetch this client's passphrase. Without it, mgmt verbs can't proceed.
  const entry = cfg.clients.find((c) => c?.name === clientName);
  if (!entry || !entry.infisical_key) {
    safeSend(ws, {
      type: "backupPiActionOutput",
      action: actionLabel,
      stream: "stderr",
      chunk: `[${clientName}] no infisical_key configured in backuppi.clients\n`,
    });
    return { ok: false, code: 1 };
  }
  const passphrase = await getPassphraseFromInfisical(
    entry.infisical_path || "/borgbackup",
    entry.infisical_key,
  );
  if (!passphrase) {
    safeSend(ws, {
      type: "backupPiActionOutput",
      action: actionLabel,
      stream: "stderr",
      chunk: `[${clientName}] could not fetch passphrase from Infisical (${entry.infisical_key})\n`,
    });
    return { ok: false, code: 1 };
  }

  const env = { ...process.env, BORG_PASSPHRASE: passphrase };
  const args = buildSshArgs({
    key: cfg.mgmtKey,
    user: cfg.mgmtUser,
    host: cfg.host,
    command: `${verb} ${clientName}`,
    controlPrefix: "backuppi-mgmt",
    sendEnv: ["BORG_PASSPHRASE"],
  });

  safeSend(ws, {
    type: "backupPiActionOutput",
    action: actionLabel,
    stream: "stdout",
    chunk: `── ${verb} ${clientName} ──\n`,
  });

  return new Promise((resolve) => {
    const child = spawn("ssh", args, { env });
    const timer = setTimeout(() => child.kill("SIGTERM"), ACTION_TIMEOUT_MS);
    pipeChildToWs(child, actionLabel, ws);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

function pipeChildToWs(child, action, ws) {
  child.stdout.on("data", (chunk) => {
    safeSend(ws, {
      type: "backupPiActionOutput",
      action,
      stream: "stdout",
      chunk: chunk.toString(),
    });
  });
  child.stderr.on("data", (chunk) => {
    safeSend(ws, {
      type: "backupPiActionOutput",
      action,
      stream: "stderr",
      chunk: chunk.toString(),
    });
  });
}

function finishAction(action, success, exitCode, ws, errorMsg) {
  activeAction = null;
  safeSend(ws, {
    type: "backupPiActionResult",
    action,
    success,
    exitCode,
    error: errorMsg,
  });
  const previous = getStatus()?.backuppi || {};
  updateStatus("backuppi", {
    ...previous,
    last_action: {
      action,
      success,
      finished_epoch: Math.floor(Date.now() / 1000),
    },
  });
  // Re-poll so the UI reflects post-action state (mtime moved after prune, etc.)
  setTimeout(
    () => {
      tick().catch(() => {});
    },
    action === "reboot" ? 30_000 : 2_000,
  );
}

async function start() {
  // Tick immediately so the UI has data within seconds of cold start.
  tick();
  tickTimer = setInterval(tick, POLL_INTERVAL_MS_DEFAULT);
  console.log(`[backuppi] poller started (${POLL_INTERVAL_MS_DEFAULT / 1000}s)`);
}

async function stop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export default { init: start, stop };
