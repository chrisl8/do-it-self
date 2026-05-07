// Backup Pi monitor + action runner. SSHes to the Pi over Tailscale to a
// locked-down `webadmin` user whose key is forced to /usr/local/bin/pi-rpc.sh
// (see scripts/setup-backup-pi.sh, STEP 19b). The dispatcher whitelists
// `status` and `action <name>`; everything else is rejected on the Pi side.
//
// Two responsibilities:
//   1. Periodic poll of `status` → updateStatus("backuppi", payload).
//      Broadcast via statusEmitter, same flow as gitStatusPoller.
//   2. On-demand action runs that stream stdout/stderr chunks back to the
//      requesting WebSocket client (the only consumer that cares about live
//      output). Final result also broadcast via updateStatus so other clients
//      see "last action: X at HH:MM" on their next status push.
//
// Config: read from user-config.yaml `backuppi:` block on every poll/action,
// so changes take effect without a backend restart.

import { spawn } from "child_process";
import os from "os";
import { join } from "path";
import { getUserConfig } from "./configRegistry.js";
import { updateStatus, getStatus } from "./statusEmitter.js";

const POLL_INTERVAL_MS_DEFAULT = 60 * 1000;
const POLL_TIMEOUT_MS = 15 * 1000;
const ACTION_TIMEOUT_MS = 30 * 60 * 1000; // apt upgrade can take a while

export const ALLOWED_ACTIONS = new Set([
  "restart-kopia",
  "apt-upgrade",
  "borg-check",
  "borg-prune",
  "reboot",
]);

let tickTimer = null;
let tickInFlight = false;
let activeAction = null; // { action, ws } when something is running

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  return p;
}

// ControlMaster keeps a multiplexed SSH connection alive between calls,
// dropping per-call setup time from ~150ms to ~20ms. %C hashes the host so
// future multi-Pi support won't collide on the same socket file.
function sshControlPath() {
  return join(os.tmpdir(), "backuppi-ssh-%C");
}

function buildSshArgs(cfg, command) {
  return [
    "-i", expandHome(cfg.ssh_key_path),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sshControlPath()}`,
    "-o", "ControlPersist=300",
    `${cfg.ssh_user}@${cfg.host}`,
    command,
  ];
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
    ssh_user: bp.ssh_user,
    ssh_key_path: bp.ssh_key_path,
  };
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

function pollOnce(cfg) {
  return new Promise((resolve) => {
    const args = buildSshArgs(cfg, "status");
    const child = spawn("ssh", args);
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
      updateStatus("backuppi", {
        enabled: true,
        reachable: true,
        fetched_epoch: Math.floor(Date.now() / 1000),
        last_action: previous.last_action || null,
        ...parsed,
      });
      resolve();
    });
  });
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return; // 1 = WebSocket OPEN
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Client gone mid-send; nothing to do.
  }
}

export async function runAction(action, ws) {
  if (!ALLOWED_ACTIONS.has(action)) {
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

  activeAction = { action, ws };
  safeSend(ws, { type: "backupPiActionStarted", action });

  const args = buildSshArgs(cfg, `action ${action}`);
  const child = spawn("ssh", args);
  const timer = setTimeout(() => child.kill("SIGTERM"), ACTION_TIMEOUT_MS);

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

  child.on("error", (err) => {
    clearTimeout(timer);
    activeAction = null;
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success: false,
      error: err.message,
    });
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    activeAction = null;
    // Reboot drops the SSH socket mid-action; ssh client reports 255. Treat
    // both 0 (would happen if reboot is delayed) and 255 (connection lost) as
    // success for this action only.
    const success = action === "reboot"
      ? code === 0 || code === 255
      : code === 0;
    safeSend(ws, {
      type: "backupPiActionResult",
      action,
      success,
      exitCode: code,
    });
    // Record on the broadcast status so all clients see the latest action
    // outcome; refresh the full status in the background so disk/age fields
    // reflect the post-action state.
    const previous = getStatus()?.backuppi || {};
    updateStatus("backuppi", {
      ...previous,
      last_action: {
        action,
        success,
        finished_epoch: Math.floor(Date.now() / 1000),
      },
    });
    setTimeout(() => {
      tick().catch(() => {});
    }, action === "reboot" ? 30_000 : 2_000);
  });
}

async function start() {
  // Tick immediately so the UI has data within seconds of cold start.
  // Don't await — slow network shouldn't delay other backend init.
  tick();
  // Fixed 60s scheduler; tick() re-reads config every time, so enabling or
  // disabling backuppi in user-config.yaml takes effect within one cycle.
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
