import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn, execFile } from "child_process";
import { readFile, writeFile, unlink, chmod, mkdir } from "fs/promises";
import { unlinkSync, existsSync } from "fs";
import { promisify } from "util";
import http from "http";
import os from "os";
import getFormattedDockerContainers from "./dockerStatus.js";
import { statusEmitter, getStatus, updateStatus } from "./statusEmitter.js";
import { getReleaseNotesForStack } from "./githubReleases.js";
import { getUpstreamState, fetchRemote, bestEffortFetch } from "./gitRepoStatus.js";
import {
  getRegistry,
  getUserConfig,
  saveUserConfig,
  getConfigStatus,
  validateContainer,
  writeContainerEnv,
  writeAllContainerEnvs,
  maskSecrets,
  generateMissingSecrets,
} from "./configRegistry.js";
import {
  getModuleCatalog,
  getInstalledModules,
  getAvailableContainers,
  getContainerSources,
} from "./moduleRegistry.js";
import {
  isAvailable as isInfisicalAvailable,
  getContainerSecrets,
  setContainerSecrets,
  setSharedSecrets,
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  createFolder,
} from "./infisicalClient.js";

const fileName = fileURLToPath(import.meta.url);
const dirName = dirname(fileName);

const app = express();

const activeStacks = new Set();

// Update-all state
let updateAllResumeResolver = null;
let updateAllChildProcess = null;
let updateAllAborted = false;

// Start-all state
let startAllChildProcess = null;
let startAllAborted = false;

// Children spawned from the backend get an explicit, minimal env rather than
// inheriting process.env. This prevents variables intended for the web-admin's
// own compose.yaml substitution (e.g. TS_STATE_HOST_DIR, HOMEPAGE_GROUP) from
// leaking to docker compose invocations in child scripts — shell env wins over
// project .env files in docker compose, so leaked vars would override each
// target container's own settings. Allowlist exactly what the shell scripts need.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "XDG_RUNTIME_DIR",
  "NODE_ENV",
];

function childEnv() {
  const out = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

function spawnTracked(command, args, timeoutMs) {
  let output = "";
  const child = spawn(command, args, { env: childEnv() });
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });

  const promise = new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: output + "\n" + err.message });
    });
  });

  return { child, promise };
}

async function processUpdateQueue() {
  const scriptPath = join(os.homedir(), "containers/scripts/all-containers.sh");
  const status = getStatus().updateAllStatus;

  while (status.queue.length > 0) {
    if (updateAllAborted) {
      break;
    }

    const stackName = status.queue.shift();

    // Skip if already being updated individually
    if (activeStacks.has(stackName)) {
      status.completed.push(stackName);
      updateStatus("updateAllStatus", { ...status });
      continue;
    }

    status.current = stackName;
    updateStatus("updateAllStatus", { ...status });

    activeStacks.add(stackName);
    updateStatus(`restartStatus.${stackName}`, {
      status: "in_progress",
      operation: "upgrade",
    });

    console.log(`[Update All] Upgrading ${stackName} (${status.completed.length + 1} of ${status.total})...`);

    const { child, promise } = spawnTracked(scriptPath, [
      "--stop",
      "--start",
      "--no-wait",
      "--container",
      stackName,
      "--update-git-repos",
      "--get-updates",
    ], 600000);

    updateAllChildProcess = child;
    const { exitCode, output } = await promise;
    updateAllChildProcess = null;

    activeStacks.delete(stackName);

    // Refresh container data
    try {
      const containers = await getFormattedDockerContainers();
      updateStatus("docker.running", containers.running);
      updateStatus("docker.stacks", containers.stacks);
    } catch (err) {
      console.error("[Update All] Error refreshing containers:", err);
    }

    if (updateAllAborted) {
      updateStatus(`restartStatus.${stackName}`, undefined);
      break;
    }

    if (exitCode === 0) {
      console.log(`[Update All] ${stackName} upgraded successfully`);
      status.completed.push(stackName);
      status.current = null;
      updateStatus(`restartStatus.${stackName}`, undefined);
      updateStatus("updateAllStatus", { ...status });
    } else {
      console.log(`[Update All] ${stackName} failed (exit code ${exitCode}), pausing`);
      status.status = "paused";
      status.current = null;
      status.failed = { stackName, error: `Script exited with code ${exitCode}`, output };
      updateStatus(`restartStatus.${stackName}`, {
        status: "failed",
        operation: "upgrade",
        output,
        error: `Script exited with code ${exitCode}`,
      });
      updateStatus("updateAllStatus", { ...status });

      // Wait for user action
      const action = await new Promise((resolve) => {
        updateAllResumeResolver = resolve;
      });
      updateAllResumeResolver = null;

      if (action === "retry") {
        status.queue.unshift(stackName);
        updateStatus(`restartStatus.${stackName}`, undefined);
      } else if (action === "skip") {
        // Leave restartStatus as failed, continue to next
      } else if (action === "cancel") {
        break;
      }

      status.status = "running";
      status.failed = null;
      updateStatus("updateAllStatus", { ...status });
    }
  }

  // Done
  if (updateAllAborted) {
    status.status = "cancelled";
  } else if (status.queue.length === 0) {
    status.status = "completed";
  } else {
    status.status = "cancelled";
  }
  status.current = null;
  status.failed = null;
  updateStatus("updateAllStatus", { ...status });

  console.log(`[Update All] Finished: ${status.status} (${status.completed.length} of ${status.total} updated)`);

  updateAllAborted = false;
}

async function processStartAllQueue() {
  const scriptPath = join(os.homedir(), "containers/scripts/all-containers.sh");
  const status = getStatus().startAllStatus;

  while (status.queue.length > 0) {
    if (startAllAborted) {
      break;
    }

    const stackName = status.queue.shift();

    if (activeStacks.has(stackName)) {
      status.completed.push(stackName);
      updateStatus("startAllStatus", { ...status });
      continue;
    }

    status.current = stackName;
    updateStatus("startAllStatus", { ...status });

    activeStacks.add(stackName);
    updateStatus(`restartStatus.${stackName}`, {
      status: "in_progress",
      operation: "start",
    });

    const progressIdx = status.completed.length + status.failed.length + 1;
    console.log(`[Start All] Starting ${stackName} (${progressIdx} of ${status.total})...`);

    const { child, promise } = spawnTracked(scriptPath, [
      "--start",
      "--no-wait",
      "--container",
      stackName,
    ], 600000);

    startAllChildProcess = child;
    const { exitCode, output } = await promise;
    startAllChildProcess = null;

    activeStacks.delete(stackName);

    // Refresh container data
    try {
      const containers = await getFormattedDockerContainers();
      updateStatus("docker.running", containers.running);
      updateStatus("docker.stacks", containers.stacks);
    } catch (err) {
      console.error("[Start All] Error refreshing containers:", err);
    }

    if (startAllAborted) {
      updateStatus(`restartStatus.${stackName}`, undefined);
      break;
    }

    if (exitCode === 0) {
      console.log(`[Start All] ${stackName} started successfully`);
      status.completed.push(stackName);
      status.current = null;
      updateStatus(`restartStatus.${stackName}`, undefined);
      updateStatus("startAllStatus", { ...status });
    } else {
      console.log(`[Start All] ${stackName} failed (exit code ${exitCode}), continuing`);
      status.failed.push({ stackName, error: `Script exited with code ${exitCode}`, output });
      status.current = null;
      updateStatus(`restartStatus.${stackName}`, {
        status: "failed",
        operation: "start",
        output,
        error: `Script exited with code ${exitCode}`,
      });
      updateStatus("startAllStatus", { ...status });
      // No pause-on-failure: keep going through the queue
    }
  }

  // Done
  if (startAllAborted) {
    status.status = "cancelled";
  } else {
    status.status = "completed";
  }
  status.current = null;
  updateStatus("startAllStatus", { ...status });

  console.log(`[Start All] Finished: ${status.status} (${status.completed.length} of ${status.total} started, ${status.failed.length} failed)`);

  startAllAborted = false;
}

const CONTAINERS_DIR = join(os.homedir(), "containers");
const ICONS_BASE_DIR = join(CONTAINERS_DIR, "homepage/dashboard-icons");
const KOPIA_CONF_FILE = join(CONTAINERS_DIR, "scripts/kopia-backup-check.conf");
const KOPIA_HOST_THRESHOLDS_FILE = join(CONTAINERS_DIR, "scripts/kopia-host-thresholds.json");

app.use(express.json());
app.use(express.static(join(dirName, "../public")));

app.use("/dashboard-icons/svg", express.static(join(ICONS_BASE_DIR, "svg")));
app.use("/dashboard-icons/png", express.static(join(ICONS_BASE_DIR, "png")));
app.use("/dashboard-icons/webp", express.static(join(ICONS_BASE_DIR, "webp")));
app.use(
  "/dashboard-icons/fallback",
  express.static(join(CONTAINERS_DIR, "homepage/icons")),
);

app.get("/api/borg-status", async (req, res) => {
  try {
    const statusFile = join(os.homedir(), "containers/homepage/images/borg-status.json");
    const data = await readFile(statusFile, "utf8");
    res.json(JSON.parse(data));
  } catch (err) {
    console.error("Error reading borg status:", err);
    res.status(500).json({ error: "Failed to read borg status" });
  }
});

// Signal for the "borg not configured" banner. Presence of borg-backup.conf
// means the user has run scripts/setup-borg-backup.sh; absence means backups
// are off and the user should be nudged.
app.get("/api/system/backup-status", async (req, res) => {
  const confPath = join(CONTAINERS_DIR, "scripts/borg-backup.conf");
  let configured = false;
  try {
    await readFile(confPath, "utf8");
    configured = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("backup-status: unexpected error reading borg conf:", err);
    }
  }
  res.json({ configured });
});

app.get("/api/kopia-status", async (req, res) => {
  try {
    const statusFile = join(
      os.homedir(),
      "containers/homepage/images/kopia-status.json",
    );
    const data = await readFile(statusFile, "utf8");
    res.json(JSON.parse(data));
  } catch (err) {
    console.error("Error reading kopia status:", err);
    res.status(500).json({ error: "Failed to read kopia status" });
  }
});

app.get("/api/kopia-log", async (req, res) => {
  try {
    const logFile = join(os.homedir(), "logs/kopia-backup-check.log");
    const data = await readFile(logFile, "utf8");
    const lines = data.split("\n");
    res.json({ log: lines });
  } catch (err) {
    console.error("Error reading kopia log:", err);
    res.status(500).json({ error: "Failed to read kopia log" });
  }
});

app.get("/api/kopia-threshold", async (req, res) => {
  try {
    const data = await readFile(KOPIA_CONF_FILE, "utf8");
    const match = data.match(/^KOPIA_STALE_HOURS=(\d+)/m);
    if (!match) {
      res.status(500).json({ error: "Could not find KOPIA_STALE_HOURS in config" });
      return;
    }
    res.json({ threshold: parseInt(match[1], 10) });
  } catch (err) {
    console.error("Error reading kopia threshold:", err);
    res.status(500).json({ error: "Failed to read kopia config" });
  }
});

app.put("/api/kopia-threshold", async (req, res) => {
  const { threshold } = req.body;
  if (!Number.isInteger(threshold) || threshold < 1) {
    res.status(400).json({ error: "Threshold must be a positive integer" });
    return;
  }
  try {
    const data = await readFile(KOPIA_CONF_FILE, "utf8");
    const updated = data.replace(
      /^KOPIA_STALE_HOURS=\d+/m,
      `KOPIA_STALE_HOURS=${threshold}`,
    );
    if (updated === data) {
      res.status(500).json({ error: "Could not find KOPIA_STALE_HOURS in config" });
      return;
    }
    await writeFile(KOPIA_CONF_FILE, updated, "utf8");
    console.log(`Kopia stale threshold updated to ${threshold}h`);
    res.json({ success: true, threshold });
  } catch (err) {
    console.error("Error updating kopia threshold:", err);
    res.status(500).json({ error: "Failed to update kopia config" });
  }
});

app.get("/api/kopia-ignore-hosts", async (req, res) => {
  try {
    const data = await readFile(KOPIA_CONF_FILE, "utf8");
    const match = data.match(/^KOPIA_IGNORE_HOSTS=\(([^)]*)\)/m);
    if (!match) {
      res.json({ hosts: [] });
      return;
    }
    // Parse bash array: ("host1" "host2") — extract quoted strings
    const hosts = (match[1].match(/"([^"]*)"/g) || []).map((s) => s.replace(/"/g, ""));
    res.json({ hosts });
  } catch (err) {
    console.error("Error reading kopia ignore hosts:", err);
    res.status(500).json({ error: "Failed to read kopia config" });
  }
});

app.put("/api/kopia-ignore-hosts", async (req, res) => {
  const { hosts } = req.body;
  if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== "string" || !h.trim())) {
    res.status(400).json({ error: "Hosts must be an array of non-empty strings" });
    return;
  }
  const hostnameRe = /^[a-zA-Z0-9._-]+$/;
  if (hosts.some((h) => !hostnameRe.test(h.trim()))) {
    res.status(400).json({ error: "Hostnames may only contain letters, numbers, dots, hyphens, and underscores" });
    return;
  }
  try {
    const data = await readFile(KOPIA_CONF_FILE, "utf8");
    const bashArray = hosts.length > 0
      ? `KOPIA_IGNORE_HOSTS=(${hosts.map((h) => `"${h.trim()}"`).join(" ")})`
      : `KOPIA_IGNORE_HOSTS=()`;
    const updated = data.replace(
      /^KOPIA_IGNORE_HOSTS=\([^)]*\)/m,
      bashArray,
    );
    if (updated === data && !data.match(/^KOPIA_IGNORE_HOSTS=/m)) {
      res.status(500).json({ error: "Could not find KOPIA_IGNORE_HOSTS in config" });
      return;
    }
    await writeFile(KOPIA_CONF_FILE, updated, "utf8");
    console.log(`Kopia ignore hosts updated to: ${hosts.join(", ") || "(none)"}`);
    res.json({ success: true, hosts });
  } catch (err) {
    console.error("Error updating kopia ignore hosts:", err);
    res.status(500).json({ error: "Failed to update kopia config" });
  }
});

app.get("/api/kopia-host-thresholds", async (req, res) => {
  try {
    const data = await readFile(KOPIA_HOST_THRESHOLDS_FILE, "utf8");
    res.json(JSON.parse(data));
  } catch (err) {
    if (err.code === "ENOENT") {
      res.json({});
      return;
    }
    console.error("Error reading kopia host thresholds:", err);
    res.status(500).json({ error: "Failed to read host thresholds" });
  }
});

app.put("/api/kopia-host-thresholds", async (req, res) => {
  const { thresholds } = req.body;
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    res.status(400).json({ error: "Thresholds must be an object" });
    return;
  }
  for (const [host, hours] of Object.entries(thresholds)) {
    if (!Number.isInteger(hours) || hours < 1) {
      res.status(400).json({ error: `Invalid threshold for ${host}: must be a positive integer` });
      return;
    }
  }
  try {
    await writeFile(KOPIA_HOST_THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2) + "\n", "utf8");
    console.log(`Kopia host thresholds updated: ${JSON.stringify(thresholds)}`);
    res.json({ success: true, thresholds });
  } catch (err) {
    console.error("Error updating kopia host thresholds:", err);
    res.status(500).json({ error: "Failed to update host thresholds" });
  }
});

let kopiaCheckRunning = false;

app.post("/api/kopia-check", async (req, res) => {
  if (kopiaCheckRunning) {
    res.status(409).json({ error: "Kopia check is already running" });
    return;
  }
  kopiaCheckRunning = true;
  console.log("Kopia backup check requested via web admin");
  const scriptPath = join(os.homedir(), "containers/scripts/kopia-backup-check.sh");
  const child = spawn(scriptPath, [], { env: childEnv() });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("close", (code) => {
    kopiaCheckRunning = false;
    console.log(`Kopia backup check finished (exit code: ${code})`);
    if (code === 0) {
      res.json({ success: true, output });
    } else {
      res.status(500).json({ success: false, error: `Script exited with code ${code}`, output });
    }
  });
  child.on("error", (err) => {
    kopiaCheckRunning = false;
    console.error("Error spawning kopia-backup-check.sh:", err);
    res.status(500).json({ error: "Failed to run kopia check script" });
  });
});

app.get("/api/ups-status", async (req, res) => {
  try {
    const child = spawn("apcaccess", [], { env: childEnv() });
    let data = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      data += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0 || !data.trim()) {
        res.status(500).json({ error: error || "apcaccess failed" });
        return;
      }
      const status = {};
      for (const line of data.trim().split("\n")) {
        if (line.includes(":")) {
          let key = line.split(":")[0].trim();
          let value = line.slice(line.indexOf(":") + 1).trim();
          switch (key) {
            case "LINEV":
              key = "LINE_VOLTAGE";
              value = Number(value.split(" ")[0]);
              break;
            case "LOADPCT":
              key = "LOAD_PERCENT";
              value = Number(value.split(" ")[0]);
              break;
            case "BCHARGE":
              key = "BATTERY_CHARGE_PERCENT";
              value = Number(value.split(" ")[0]);
              break;
            case "TIMELEFT":
              key = "MINUTES_LEFT";
              value = Number(value.split(" ")[0]);
              break;
            case "END APC":
              key = "END_APC";
              break;
          }
          status[key] = value;
        }
      }
      res.json(status);
    });
    child.on("error", (err) => {
      console.error("Error spawning apcaccess:", err);
      res.status(500).json({ error: "apcaccess not available" });
    });
  } catch (err) {
    console.error("Error getting UPS status:", err);
    res.status(500).json({ error: "Failed to get UPS status" });
  }
});

app.get("/api/borg-log", async (req, res) => {
  try {
    const logFile = join(os.homedir(), "logs/borg-backup.log");
    const data = await readFile(logFile, "utf8");
    const lines = data.split("\n");
    const lastLines = lines.slice(-100);
    res.json({ log: lastLines });
  } catch (err) {
    console.error("Error reading borg log:", err);
    res.status(500).json({ error: "Failed to read borg log" });
  }
});

// --- Container Configuration Registry APIs ---

app.get("/api/registry", async (req, res) => {
  try {
    const registry = await getRegistry();
    const sources = await getContainerSources();
    res.json({ ...registry, sources });
  } catch (err) {
    console.error("Error reading registry:", err);
    res.status(500).json({ error: "Failed to read container registry" });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const registry = await getRegistry();
    const userConfig = await getUserConfig();
    const masked = maskSecrets(registry, userConfig);
    res.json(masked);
  } catch (err) {
    console.error("Error reading config:", err);
    res.status(500).json({ error: "Failed to read user config" });
  }
});

app.get("/api/config/raw", async (req, res) => {
  try {
    const userConfig = await getUserConfig();
    // Merge secrets from Infisical if available
    if (await isInfisicalAvailable()) {
      try {
        const registry = await getRegistry();
        // Load shared secrets
        const sharedSecrets = await listSecrets("/shared").catch(() => []);
        for (const s of sharedSecrets) {
          if (!userConfig.shared) userConfig.shared = {};
          userConfig.shared[s.key] = s.value;
        }
        // Load per-container secrets
        for (const name of Object.keys(registry.containers || {})) {
          const containerSecrets = await listSecrets(`/${name}`).catch(() => []);
          if (containerSecrets.length > 0) {
            if (!userConfig.containers) userConfig.containers = {};
            if (!userConfig.containers[name]) userConfig.containers[name] = {};
            if (!userConfig.containers[name].variables) userConfig.containers[name].variables = {};
            for (const s of containerSecrets) {
              userConfig.containers[name].variables[s.key] = s.value;
            }
          }
        }
      } catch (e) {
        console.warn("Could not load secrets from Infisical:", e.message);
      }
    }
    res.json(userConfig);
  } catch (err) {
    console.error("Error reading raw config:", err);
    res.status(500).json({ error: "Failed to read user config" });
  }
});

app.get("/api/config/infisical-status", async (req, res) => {
  try {
    const available = await isInfisicalAvailable();
    res.json({ available });
  } catch (err) {
    res.json({ available: false });
  }
});

app.put("/api/config/shared", async (req, res) => {
  try {
    // Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) live
    // in Infisical at /shared only. user-config.yaml no longer has a
    // `shared:` block; the runtime injection path
    // (`infisical export --path=/shared` in scripts/all-containers.sh)
    // is the single delivery channel. So Infisical is a hard requirement
    // for ANY save through this endpoint, secret or not.
    if (Object.keys(req.body).length > 0 && !(await isInfisicalAvailable())) {
      return res.status(503).json({
        error: "Cannot save shared variables: Infisical is not available",
        detail:
          "Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) are stored in Infisical only. Start the infisical container and try again.",
      });
    }

    await setSharedSecrets(req.body);

    const envResults = await writeAllContainerEnvs();
    res.json({ success: true, envsGenerated: Object.keys(envResults).length });
  } catch (err) {
    console.error("Error saving shared config:", err);
    res.status(500).json({ error: "Failed to save shared config" });
  }
});

// Healthcheck URLs for backup-related cron scripts. These secrets live in
// Infisical but aren't attached to a registered container, so they don't
// surface in the normal Container Variables editor. Edited on the Backups tab.
const HEALTHCHECK_SECRETS = {
  kopia: { path: "/kopia-backup-check", key: "HEALTHCHECK_URL" },
  borg: { path: "/borgbackup", key: "BORG_HEALTHCHECK_URL" },
  borgRestore: { path: "/borgbackup", key: "BORG_RESTORE_TEST_HEALTHCHECK_URL" },
};

app.get("/api/config/backup-healthchecks", async (req, res) => {
  try {
    if (!(await isInfisicalAvailable())) {
      return res.json({ available: false });
    }
    const entries = await Promise.all(
      Object.entries(HEALTHCHECK_SECRETS).map(async ([name, { path, key }]) => [
        name,
        await getSecret(key, path),
      ]),
    );
    res.json({ available: true, ...Object.fromEntries(entries) });
  } catch (err) {
    console.error("Error loading backup healthcheck URLs:", err);
    res.status(500).json({ error: "Failed to load healthcheck URLs" });
  }
});

app.put("/api/config/backup-healthchecks", async (req, res) => {
  try {
    if (!(await isInfisicalAvailable())) {
      return res.status(503).json({ error: "Infisical is not available" });
    }
    for (const [name, value] of Object.entries(req.body)) {
      if (!(name in HEALTHCHECK_SECRETS)) {
        return res.status(400).json({ error: `Unknown healthcheck: ${name}` });
      }
      if (value && typeof value !== "string") {
        return res.status(400).json({ error: `Invalid value for ${name}` });
      }
      if (value && !/^https?:\/\//.test(value)) {
        return res.status(400).json({
          error: `${name} must start with http:// or https://`,
        });
      }
    }
    for (const [name, value] of Object.entries(req.body)) {
      const { path, key } = HEALTHCHECK_SECRETS[name];
      if (value === "" || value === null) {
        try {
          await deleteSecret(key, path);
        } catch (err) {
          // Swallow "not found" — deleting an absent secret is a no-op
          if (!/404/.test(err.message)) throw err;
        }
      } else if (typeof value === "string") {
        // Ensure folder exists before writing (idempotent)
        const folderName = path.replace(/^\//, "");
        await createFolder(folderName, "/");
        await setSecret(key, value, path);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving backup healthcheck URLs:", err);
    res.status(500).json({ error: "Failed to save healthcheck URLs" });
  }
});

app.put("/api/config/mounts", async (req, res) => {
  try {
    const userConfig = await getUserConfig();
    userConfig.mounts = req.body.mounts;
    await saveUserConfig(userConfig);
    // Mounts affect all container volumes, so regenerate everything
    const envResults = await writeAllContainerEnvs();
    res.json({ success: true, envsGenerated: Object.keys(envResults).length });
  } catch (err) {
    console.error("Error saving mounts:", err);
    res.status(500).json({ error: "Failed to save mounts" });
  }
});

app.put("/api/config/container/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const userConfig = await getUserConfig();
    if (!userConfig.containers) userConfig.containers = {};
    const existing = userConfig.containers[name] || {};

    // Separate variables into secrets (Infisical) and non-secret config (user-config.yaml)
    const variables = { ...(existing.variables || {}), ...(req.body.variables || {}) };

    // Non-variable config (enabled, volume_mounts) always goes to user-config.yaml
    userConfig.containers[name] = {
      ...existing,
      ...req.body,
      volume_mounts: { ...(existing.volume_mounts || {}), ...(req.body.volume_mounts || {}) },
    };
    // Don't store variables in user-config.yaml if Infisical is available
    let autoGenerated = 0;
    if (await isInfisicalAvailable()) {
      delete userConfig.containers[name].variables;
      await setContainerSecrets(name, variables);
      // Auto-generate any missing internal secrets when enabling a container
      if (req.body.enabled === true) {
        const genResult = await generateMissingSecrets(name);
        autoGenerated = genResult.generated;
      }
    } else {
      userConfig.containers[name].variables = variables;
    }

    await saveUserConfig(userConfig);
    const registry = await getRegistry();
    const containerDef = registry.containers?.[name];
    let envResult = { written: 0, missing: [] };
    if (!containerDef?.system_service) {
      envResult = await writeContainerEnv(name);
    }
    res.json({ success: true, envWritten: envResult.written, envMissing: envResult.missing, autoGenerated });
  } catch (err) {
    console.error("Error saving container config:", err);
    res.status(500).json({ error: "Failed to save container config" });
  }
});

app.get("/api/config/validate", async (req, res) => {
  try {
    const status = await getConfigStatus();
    res.json(status);
  } catch (err) {
    console.error("Error validating config:", err);
    res.status(500).json({ error: "Failed to validate config" });
  }
});

app.get("/api/config/validate/:name", async (req, res) => {
  try {
    const registry = await getRegistry();
    const userConfig = await getUserConfig();
    const result = await validateContainer(registry, userConfig, req.params.name);
    res.json(result);
  } catch (err) {
    console.error("Error validating container:", err);
    res.status(500).json({ error: "Failed to validate container" });
  }
});

app.post("/api/config/generate-env/:name", async (req, res) => {
  try {
    const result = await writeContainerEnv(req.params.name);
    res.json(result);
  } catch (err) {
    console.error("Error generating env:", err);
    res.status(500).json({ error: "Failed to generate .env file" });
  }
});

app.post("/api/config/generate-all-envs", async (req, res) => {
  try {
    const results = await writeAllContainerEnvs();
    res.json(results);
  } catch (err) {
    console.error("Error generating envs:", err);
    res.status(500).json({ error: "Failed to generate .env files" });
  }
});

// --- Module System APIs ---

app.get("/api/modules/catalog", async (req, res) => {
  try {
    const catalog = await getModuleCatalog();
    res.json(catalog);
  } catch (err) {
    console.error("Error reading module catalog:", err);
    res.status(500).json({ error: "Failed to read module catalog" });
  }
});

app.get("/api/modules/installed", async (req, res) => {
  try {
    const installed = await getInstalledModules();
    res.json(installed);
  } catch (err) {
    console.error("Error reading installed modules:", err);
    res.status(500).json({ error: "Failed to read installed modules" });
  }
});

app.get("/api/modules/available", async (req, res) => {
  try {
    const available = await getAvailableContainers();
    res.json(available);
  } catch (err) {
    console.error("Error reading available containers:", err);
    res.status(500).json({ error: "Failed to read available containers" });
  }
});

const execFileAsync = promisify(execFile);
const MODULES_DIR = join(CONTAINERS_DIR, ".modules");
const MAX_CHANGES_PER_REPO = 50;

async function getRepoStatus(name, label, repoPath, isModule) {
  const result = { name, label, isModule, clean: true, changes: [] };
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoPath,
      env: { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" },
    });
    const lines = stdout.trim().split("\n").filter(Boolean);
    result.clean = lines.length === 0;
    const capped = lines.slice(0, MAX_CHANGES_PER_REPO);
    result.changes = capped.map((line) => {
      const match = line.match(/^(.+?)\s+(\S.*)$/);
      return match
        ? { status: match[1].trim(), file: match[2] }
        : { status: "?", file: line.trim() };
    });
    if (lines.length > MAX_CHANGES_PER_REPO) {
      result.truncated = lines.length - MAX_CHANGES_PER_REPO;
    }
  } catch (err) {
    result.error = err.message;
  }
  Object.assign(result, await getUpstreamState(repoPath));
  return result;
}

app.get("/api/git-status", async (req, res) => {
  try {
    const doFetch = req.query.fetch === "1" || req.query.fetch === "true";
    const installed = await getInstalledModules();
    const moduleNames = Object.keys(installed.modules || {})
      .filter((name) => existsSync(join(MODULES_DIR, name)));

    if (doFetch) {
      await bestEffortFetch(CONTAINERS_DIR, "platform");
      await Promise.all(
        moduleNames.map((name) => bestEffortFetch(join(MODULES_DIR, name), name)),
      );
    }

    const repos = [];
    const platformStatus = await getRepoStatus("platform", "Platform", CONTAINERS_DIR, false);
    if (doFetch) platformStatus.fetchedAt = new Date().toISOString();
    repos.push(platformStatus);
    for (const moduleName of moduleNames) {
      const status = await getRepoStatus(moduleName, moduleName, join(MODULES_DIR, moduleName), true);
      if (doFetch) status.fetchedAt = new Date().toISOString();
      repos.push(status);
    }
    res.json({ repos });
  } catch (err) {
    console.error("Error checking git status:", err);
    res.status(500).json({ error: "Failed to check git status" });
  }
});

// Mutating module operations serialize through a single in-memory lock.
// Two concurrent installs would race on installed-modules.yaml and
// container-registry.yaml; the CLI doesn't guard against this either,
// so we enforce one-at-a-time here.
const MODULE_SH = join(os.homedir(), "containers/scripts/module.sh");
let moduleOpInFlight = false;

function acquireModuleLock(res) {
  if (moduleOpInFlight) {
    res.status(409).json({
      error: "Another module operation is in progress. Wait for it to finish and try again.",
      output: "",
    });
    return false;
  }
  moduleOpInFlight = true;
  return true;
}

async function runModuleCommand(args) {
  const { promise } = spawnTracked(MODULE_SH, args, 300000);
  return await promise;
}

async function refreshDockerStatusAfterModuleOp() {
  try {
    const containers = await getFormattedDockerContainers();
    updateStatus("docker.running", containers.running);
    updateStatus("docker.stacks", containers.stacks);
  } catch (err) {
    console.error("Error refreshing docker status after module op:", err);
  }
}

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function validateName(res, name, label) {
  if (!name || typeof name !== "string" || !SAFE_NAME_RE.test(name)) {
    res.status(400).json({ error: `Invalid ${label}: ${name}` });
    return false;
  }
  return true;
}

async function handleModuleMutation(res, args) {
  if (!acquireModuleLock(res)) return;
  try {
    const { exitCode, output } = await runModuleCommand(args);
    await refreshDockerStatusAfterModuleOp();
    if (exitCode !== 0) {
      res.status(500).json({ success: false, exitCode, output });
    } else {
      res.json({ success: true, output });
    }
  } catch (err) {
    console.error(`Error running module.sh ${args.join(" ")}:`, err);
    res.status(500).json({ success: false, output: err.message });
  } finally {
    moduleOpInFlight = false;
  }
}

app.post("/api/modules/sources", async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'url' in request body" });
  }
  const args = ["add-source", url];
  if (name && typeof name === "string") args.push("--name", name);
  await handleModuleMutation(res, args);
});

app.delete("/api/modules/sources/:name", async (req, res) => {
  if (!validateName(res, req.params.name, "source name")) return;
  await handleModuleMutation(res, ["remove-source", req.params.name]);
});

app.post("/api/modules/sources/:name/update", async (req, res) => {
  if (!validateName(res, req.params.name, "source name")) return;
  await handleModuleMutation(res, ["update", req.params.name]);
});

app.post("/api/modules/sources/update-all", async (req, res) => {
  await handleModuleMutation(res, ["update"]);
});

app.post("/api/modules/regenerate-registry", async (req, res) => {
  await handleModuleMutation(res, ["regenerate-registry"]);
});

app.post("/api/modules/containers/:name/install", async (req, res) => {
  if (!validateName(res, req.params.name, "container name")) return;
  const moduleName = req.body?.module;
  if (!validateName(res, moduleName, "module name")) return;
  await handleModuleMutation(res, ["install", moduleName, req.params.name]);
});

app.delete("/api/modules/containers/:name", async (req, res) => {
  if (!validateName(res, req.params.name, "container name")) return;
  await handleModuleMutation(res, ["uninstall", req.params.name]);
});

app.post("/api/modules/dev-sync/:name", async (req, res) => {
  if (!validateName(res, req.params.name, "module name")) return;
  await handleModuleMutation(res, ["dev-sync", req.params.name, "--yes"]);
});

// Safe platform repo update. Reuses the module lock because the flow writes
// to installed-modules.yaml (setup hook completions). Maps structured exit
// codes from update-platform.js to a category so the UI can pick severity.
const UPDATE_PLATFORM_SH = join(os.homedir(), "containers/scripts/update-platform.sh");
function categorizePlatformUpdateExit(code) {
  if (code === 0) return "ok";
  if (code === 2) return "precondition";
  if (code === 3) return "validation";
  if (code === 4) return "backup";
  return "error";
}

app.post("/api/platform/update", async (req, res) => {
  if (!acquireModuleLock(res)) return;
  try {
    const args = ["--yes"];
    if (req.body?.preBackup) args.push("--pre-backup");
    const { promise } = spawnTracked(UPDATE_PLATFORM_SH, args, 15 * 60 * 1000);
    const { exitCode, output } = await promise;
    await refreshDockerStatusAfterModuleOp();
    res.json({
      success: exitCode === 0,
      exitCode,
      output,
      category: categorizePlatformUpdateExit(exitCode),
    });
  } catch (err) {
    console.error("Error running update-platform.sh:", err);
    res.status(500).json({ success: false, output: err.message, category: "error" });
  } finally {
    moduleOpInFlight = false;
  }
});

// "Update everything": platform update first (it can bring in new module
// catalog entries), then module update --all. Stops after platform on failure
// since a broken platform state could leave modules in an inconsistent place.
app.post("/api/platform/update-everything", async (req, res) => {
  if (!acquireModuleLock(res)) return;
  try {
    const out = [];
    out.push("── Platform update ──");
    const platformArgs = ["--yes"];
    if (req.body?.preBackup) platformArgs.push("--pre-backup");
    const { promise: platformPromise } = spawnTracked(
      UPDATE_PLATFORM_SH, platformArgs, 15 * 60 * 1000,
    );
    const platform = await platformPromise;
    out.push(platform.output);

    let modules = { exitCode: 0, output: "" };
    if (platform.exitCode === 0) {
      out.push("\n── Module update ──");
      const { promise: modPromise } = spawnTracked(MODULE_SH, ["update"], 15 * 60 * 1000);
      modules = await modPromise;
      out.push(modules.output);
    } else {
      out.push("\n── Module update — skipped (platform update failed) ──");
    }

    await refreshDockerStatusAfterModuleOp();
    res.json({
      success: platform.exitCode === 0 && modules.exitCode === 0,
      platformExitCode: platform.exitCode,
      platformCategory: categorizePlatformUpdateExit(platform.exitCode),
      moduleExitCode: modules.exitCode,
      output: out.join("\n"),
    });
  } catch (err) {
    console.error("Error running update-everything:", err);
    res.status(500).json({ success: false, output: err.message, category: "error" });
  } finally {
    moduleOpInFlight = false;
  }
});

app.use((req, res, next) => {
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/dashboard-icons/")
  ) {
    return next();
  }
  const indexPath = join(dirName, "../public/index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error("Error sending index.html:", err);
      res.status(500).send("Error loading page");
    }
  });
});

// Primary listener path: a Unix domain socket. The Tailscale Serve sidecar
// in web-admin/compose.yaml bind-mounts the directory containing this socket
// (web-admin/backend/sockets/) and proxies https://admin.<tailnet>.ts.net to
// it. Filesystem permissions on the socket file (chmod 0660) are the access
// control: only processes that can open the file can connect. The only such
// process on the host (besides the web-admin user itself) is the docker
// container that bind-mounts it. Nothing on the LAN, the public internet, any
// tailnet device that isn't the sidecar's own MagicDNS host, or any other
// docker container can reach the backend except via that sidecar.
const SOCKET_PATH =
  process.env.SOCKET_PATH ||
  join(dirName, "..", "sockets", "web-admin.sock");
// Optional secondary listener: a loopback TCP port for local debugging from
// the host (curl http://127.0.0.1:3333/...). Off by default. Set
// DEBUG_TCP_PORT in web-admin/backend/.env to enable.
const DEBUG_TCP_PORT = process.env.DEBUG_TCP_PORT;

async function webserver() {
  // Make sure the socket directory exists. The bind mount in compose.yaml
  // depends on this directory being present before the sidecar container
  // starts, so creating it here protects against a fresh checkout where
  // setup.sh hasn't run.
  await mkdir(dirname(SOCKET_PATH), { recursive: true });

  // Clean up a stale socket file from a previous run. Linux does NOT
  // auto-remove unix sockets when the listening process dies, so without
  // this the next listen() would EADDRINUSE.
  try {
    await unlink(SOCKET_PATH);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const wss = new WebSocketServer({ noServer: true });

  // Wire WebSocket upgrades. wss is configured with `noServer: true` so a
  // single wss instance can serve multiple http.Server listeners (the
  // primary unix-socket server and the optional loopback TCP server).
  function wireUpgrade(server) {
    server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
  }

  // Primary listener: Unix domain socket. Awaiting the listen callback
  // ensures the socket file exists (and is chmod'd) before we report
  // ready, so the sidecar's first probe can't race us.
  const unixServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(SOCKET_PATH, async () => {
      try {
        // chmod 660: owner (the user running PM2) and group can read/write,
        // others cannot. The docker container's tailscaled runs as root and
        // bypasses these checks, so it has access. Arbitrary host users do
        // not (assuming they're not in the owner's group).
        await chmod(SOCKET_PATH, 0o660);
        console.log(`web-admin listening on unix:${SOCKET_PATH}`);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  wireUpgrade(unixServer);

  if (DEBUG_TCP_PORT) {
    const tcpServer = http.createServer(app);
    tcpServer.listen(parseInt(DEBUG_TCP_PORT, 10), "127.0.0.1", () => {
      console.log(
        `web-admin also listening on http://127.0.0.1:${DEBUG_TCP_PORT} (debug)`,
      );
    });
    wireUpgrade(tcpServer);
  }

  // Best-effort cleanup of the socket file on graceful shutdown so the
  // next start doesn't have to do it. The unlink-on-startup above is the
  // real safety net; this is just hygiene.
  const cleanup = () => {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone or never existed -- nothing to do.
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  wss.on("connection", async (ws) => {
    console.log("WebSocket client connected");

    const emitStatusToFrontEnd = () => {
      const status = getStatus();
      const sequenceId =
        Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
      status.type = "status";
      status.sequenceId = sequenceId;
      ws.send(JSON.stringify(status));
    };

    emitStatusToFrontEnd();

    statusEmitter.on("update", () => {
      emitStatusToFrontEnd();
    });

    ws.on("message", async (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === "getDockerContainers") {
        try {
          const containers = await getFormattedDockerContainers();
          ws.send(
            JSON.stringify({ type: "dockerContainers", payload: containers }),
          );
        } catch (e) {
          console.error("Error getting docker containers:", e);
          ws.send(
            JSON.stringify({
              type: "dockerContainersError",
              error:
                e?.message ||
                "Unable to obtain docker containers via Docker Engine API.",
            }),
          );
        }
      } else if (message.type === "restartDockerStack") {
        const stackName = message.payload?.stackName;
        if (!stackName) {
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: false,
              stackName,
              error: "No stack name provided",
            }),
          );
          return;
        }

        if (activeStacks.has(stackName)) {
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: false,
              stackName,
              error: "Stack is already being restarted",
            }),
          );
          return;
        }

        activeStacks.add(stackName);

        console.log(`Restart requested for ${stackName}...`);

        updateStatus(`restartStatus.${stackName}`, {
          status: "in_progress",
          operation: "restart",
        });

        const scriptPath = join(
          os.homedir(),
          "containers/scripts/all-containers.sh",
        );
        const child = spawn(scriptPath, [
          "--stop",
          "--start",
          "--no-wait",
          "--container",
          stackName,
        ]);

        ws.send(
          JSON.stringify({
            type: "dockerStackRestartStarted",
            stackName,
          }),
        );

        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
        });
        child.stderr.on("data", (data) => {
          output += data.toString();
        });

        child.on("error", (err) => {
          activeStacks.delete(stackName);
          console.error(`Failed to spawn restart for ${stackName}:`, err);
          updateStatus(`restartStatus.${stackName}`, {
            status: "failed",
            operation: "restart",
            output: "",
            error: err.message,
          });
        });

        child.on("close", (code) => {
          activeStacks.delete(stackName);
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: code === 0,
              stackName,
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            }),
          );
          console.log(
            `Restart completed for ${stackName}: ${code === 0 ? "SUCCESS" : "FAILED"} (exit code: ${code})`,
          );
          if (code === 0) {
            updateStatus(`restartStatus.${stackName}`, undefined);
          } else {
            updateStatus(`restartStatus.${stackName}`, {
              status: "failed",
              operation: "restart",
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            });
          }
          getFormattedDockerContainers()
            .then((containers) => {
              updateStatus("docker.running", containers.running);
              updateStatus("docker.stacks", containers.stacks);
              statusEmitter.emit("update");
            })
            .catch((err) => {
              console.error("Error refreshing containers after restart:", err);
            });
        });
      } else if (message.type === "restartDockerStackWithUpgrade") {
        const stackName = message.payload?.stackName;
        if (!stackName) {
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: false,
              stackName,
              operation: "upgrade",
              error: "No stack name provided",
            }),
          );
          return;
        }

        if (activeStacks.has(stackName)) {
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: false,
              stackName,
              operation: "upgrade",
              error: "Stack is already being restarted",
            }),
          );
          return;
        }

        activeStacks.add(stackName);

        console.log(`Upgrade requested for ${stackName}...`);

        updateStatus(`restartStatus.${stackName}`, {
          status: "in_progress",
          operation: "upgrade",
        });

        const scriptPath = join(
          os.homedir(),
          "containers/scripts/all-containers.sh",
        );
        const child = spawn(scriptPath, [
          "--stop",
          "--start",
          "--no-wait",
          "--container",
          stackName,
          "--update-git-repos",
          "--get-updates",
        ]);

        ws.send(
          JSON.stringify({
            type: "dockerStackRestartStarted",
            stackName,
            operation: "upgrade",
          }),
        );

        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
        });
        child.stderr.on("data", (data) => {
          output += data.toString();
        });

        child.on("error", (err) => {
          activeStacks.delete(stackName);
          console.error(`Failed to spawn upgrade for ${stackName}:`, err);
          updateStatus(`restartStatus.${stackName}`, {
            status: "failed",
            operation: "upgrade",
            output: "",
            error: err.message,
          });
        });

        child.on("close", (code) => {
          activeStacks.delete(stackName);
          ws.send(
            JSON.stringify({
              type: "dockerStackRestartResult",
              success: code === 0,
              stackName,
              operation: "upgrade",
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            }),
          );
          console.log(
            `Upgrade completed for ${stackName}: ${code === 0 ? "SUCCESS" : "FAILED"} (exit code: ${code})`,
          );
          if (code === 0) {
            updateStatus(`restartStatus.${stackName}`, undefined);
          } else {
            updateStatus(`restartStatus.${stackName}`, {
              status: "failed",
              operation: "upgrade",
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            });
          }
          getFormattedDockerContainers()
            .then((containers) => {
              updateStatus("docker.running", containers.running);
              updateStatus("docker.stacks", containers.stacks);
              statusEmitter.emit("update");
            })
            .catch((err) => {
              console.error("Error refreshing containers after update:", err);
            });
        });
      } else if (message.type === "clearRestartStatus") {
        const stackName = message.payload?.stackName;
        if (stackName) {
          updateStatus(`restartStatus.${stackName}`, undefined);
        }
      } else if (message.type === "startUpdateAll") {
        const currentStatus = getStatus().updateAllStatus;
        if (currentStatus && (currentStatus.status === "running" || currentStatus.status === "paused")) {
          ws.send(
            JSON.stringify({
              type: "updateAllError",
              error: "An update-all operation is already in progress",
            }),
          );
          return;
        }

        // Build queue from stacks with pending updates
        try {
          const containers = await getFormattedDockerContainers();
          updateStatus("docker.running", containers.running);
          updateStatus("docker.stacks", containers.stacks);

          const queue = Object.entries(containers.stacks)
            .filter(([, info]) => info.hasPendingUpdates)
            .sort(([, a], [, b]) =>
              (a.sortOrder || "z999").localeCompare(b.sortOrder || "z999", undefined, { numeric: true }),
            )
            .map(([name]) => name);

          if (queue.length === 0) {
            ws.send(
              JSON.stringify({
                type: "updateAllError",
                error: "No stacks have pending updates",
              }),
            );
            return;
          }

          console.log(`[Update All] Starting batch update of ${queue.length} stacks: ${queue.join(", ")}`);

          updateAllAborted = false;
          updateStatus("updateAllStatus", {
            status: "running",
            queue: [...queue],
            current: null,
            completed: [],
            failed: null,
            total: queue.length,
          });

          processUpdateQueue().catch((err) =>
            console.error("[Update All] Unhandled error in queue:", err),
          );
        } catch (e) {
          console.error("[Update All] Error starting batch update:", e);
          ws.send(
            JSON.stringify({
              type: "updateAllError",
              error: e?.message || "Failed to start batch update",
            }),
          );
        }
      } else if (message.type === "updateAllAction") {
        const action = message.payload?.action;
        if (updateAllResumeResolver && ["skip", "retry", "cancel"].includes(action)) {
          console.log(`[Update All] User action: ${action}`);
          updateAllResumeResolver(action);
        }
      } else if (message.type === "cancelUpdateAll") {
        console.log("[Update All] Cancellation requested");
        updateAllAborted = true;
        if (updateAllChildProcess) {
          updateAllChildProcess.kill("SIGTERM");
        }
        if (updateAllResumeResolver) {
          updateAllResumeResolver("cancel");
        }
      } else if (message.type === "dismissUpdateAll") {
        updateStatus("updateAllStatus", null);
      } else if (message.type === "startAllEnabled") {
        const currentStartStatus = getStatus().startAllStatus;
        if (currentStartStatus && currentStartStatus.status === "running") {
          ws.send(
            JSON.stringify({
              type: "startAllError",
              error: "A start-all operation is already in progress",
            }),
          );
          return;
        }
        const currentUpdateAllStatus = getStatus().updateAllStatus;
        if (currentUpdateAllStatus && (currentUpdateAllStatus.status === "running" || currentUpdateAllStatus.status === "paused")) {
          ws.send(
            JSON.stringify({
              type: "startAllError",
              error: "An update-all operation is in progress",
            }),
          );
          return;
        }

        // Build queue from enabled, ready, not-running stacks
        try {
          const containers = await getFormattedDockerContainers();
          updateStatus("docker.running", containers.running);
          updateStatus("docker.stacks", containers.stacks);

          const queue = Object.entries(containers.stacks)
            .filter(([name, info]) =>
              !info.isDisabled &&
              info.configReady !== false &&
              !containers.running[name]
            )
            .sort(([, a], [, b]) =>
              (a.sortOrder || "z999").localeCompare(b.sortOrder || "z999", undefined, { numeric: true }),
            )
            .map(([name]) => name);

          if (queue.length === 0) {
            ws.send(
              JSON.stringify({
                type: "startAllError",
                error: "No enabled containers need to be started",
              }),
            );
            return;
          }

          console.log(`[Start All] Starting batch of ${queue.length} stacks: ${queue.join(", ")}`);

          startAllAborted = false;
          updateStatus("startAllStatus", {
            status: "running",
            queue: [...queue],
            current: null,
            completed: [],
            failed: [],
            total: queue.length,
          });

          processStartAllQueue().catch((err) =>
            console.error("[Start All] Unhandled error in queue:", err),
          );
        } catch (e) {
          console.error("[Start All] Error starting batch:", e);
          ws.send(
            JSON.stringify({
              type: "startAllError",
              error: e?.message || "Failed to start batch",
            }),
          );
        }
      } else if (message.type === "cancelStartAll") {
        console.log("[Start All] Cancellation requested");
        startAllAborted = true;
        if (startAllChildProcess) {
          startAllChildProcess.kill("SIGTERM");
        }
      } else if (message.type === "dismissStartAll") {
        updateStatus("startAllStatus", null);
      } else if (message.type === "runTailscalePreflight") {
        // Spawn the preflight helper with --json, reading TS_API_TOKEN
        // from Infisical /shared. Soft-skip if the token isn't there.
        try {
          const secrets = await listSecrets("/shared").catch(() => []);
          const tokenSecret = secrets.find((s) => s.key === "TS_API_TOKEN");
          if (!tokenSecret?.value) {
            updateStatus("tailscalePreflightStatus", {
              status: "unavailable",
              message:
                "TS_API_TOKEN not set in Infisical /shared. Add it via Configuration → Shared secrets.",
              checks: [],
            });
          } else {
            updateStatus("tailscalePreflightStatus", { status: "running", checks: [] });
            const childEnv = { ...process.env };
            childEnv.TS_API_TOKEN = tokenSecret.value;
            for (const s of secrets) {
              if (s.key && s.value) childEnv[s.key] = s.value;
            }
            const preflightPath = join(
              os.homedir(),
              "containers/scripts/lib/tailscale-preflight.js",
            );
            const child = spawn("node", [preflightPath, "--json"], { env: childEnv });
            let output = "";
            child.stdout.on("data", (d) => (output += d.toString()));
            child.stderr.on("data", (d) => (output += d.toString()));
            child.on("close", (code) => {
              try {
                const result = JSON.parse(output);
                updateStatus("tailscalePreflightStatus", {
                  status: result.ok ? "passed" : "failed",
                  checks: result.checks || [],
                  error: result.error || null,
                });
              } catch {
                updateStatus("tailscalePreflightStatus", {
                  status: "failed",
                  checks: [],
                  error: `Preflight script exited ${code}, output: ${output.slice(0, 500)}`,
                });
              }
            });
          }
        } catch (e) {
          console.error("[Tailscale Preflight] Error:", e);
          updateStatus("tailscalePreflightStatus", {
            status: "failed",
            checks: [],
            error: e?.message || "Failed to run preflight",
          });
        }
      } else if (message.type === "getReleaseNotes") {
        const stackName = message.payload?.stackName;
        if (!stackName) {
          ws.send(
            JSON.stringify({
              type: "releaseNotes",
              payload: { stackName, error: "No stack name provided" },
            }),
          );
          return;
        }

        try {
          const currentStatus = getStatus();
          const stackContainers =
            currentStatus?.docker?.running?.[stackName] || null;
          const result = await getReleaseNotesForStack(
            stackName,
            stackContainers,
          );
          ws.send(
            JSON.stringify({ type: "releaseNotes", payload: result }),
          );
        } catch (e) {
          console.error(
            `Error fetching release notes for ${stackName}:`,
            e,
          );
          ws.send(
            JSON.stringify({
              type: "releaseNotes",
              payload: {
                stackName,
                error: e?.message || "Failed to fetch release notes",
              },
            }),
          );
        }
      }
    });

    ws.on("close", () => {
      statusEmitter.removeListener("update", emitStatusToFrontEnd);
      console.log("WebSocket client disconnected");
    });
  });
}

export default webserver;
