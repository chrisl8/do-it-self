import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { readFile, writeFile } from "fs/promises";
import os from "os";
import "dotenv/config";
import getFormattedDockerContainers from "./dockerStatus.js";
import { statusEmitter, getStatus, updateStatus } from "./statusEmitter.js";
import { getReleaseNotesForStack } from "./githubReleases.js";
import {
  getRegistry,
  getUserConfig,
  saveUserConfig,
  getConfigStatus,
  validateContainer,
  writeContainerEnv,
  writeAllContainerEnvs,
  maskSecrets,
} from "./configRegistry.js";

const fileName = fileURLToPath(import.meta.url);
const dirName = dirname(fileName);

const app = express();

const activeStacks = new Set();

// Update-all state
let updateAllResumeResolver = null;
let updateAllChildProcess = null;
let updateAllAborted = false;

function spawnTracked(command, args, timeoutMs) {
  let output = "";
  const child = spawn(command, args);
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
  const child = spawn(scriptPath);
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
    const child = spawn("apcaccess");
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
    res.json(registry);
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
    res.json(userConfig);
  } catch (err) {
    console.error("Error reading raw config:", err);
    res.status(500).json({ error: "Failed to read user config" });
  }
});

app.put("/api/config/shared", async (req, res) => {
  try {
    const userConfig = await getUserConfig();
    userConfig.shared = { ...userConfig.shared, ...req.body };
    await saveUserConfig(userConfig);
    const envResults = await writeAllContainerEnvs();
    res.json({ success: true, envsGenerated: Object.keys(envResults).length });
  } catch (err) {
    console.error("Error saving shared config:", err);
    res.status(500).json({ error: "Failed to save shared config" });
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
    userConfig.containers[name] = {
      ...existing,
      ...req.body,
      variables: { ...(existing.variables || {}), ...(req.body.variables || {}) },
      volume_mounts: { ...(existing.volume_mounts || {}), ...(req.body.volume_mounts || {}) },
    };
    await saveUserConfig(userConfig);
    // Regenerate this container's .env file immediately
    const envResult = await writeContainerEnv(name);
    res.json({ success: true, envWritten: envResult.written, envMissing: envResult.missing });
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
    const result = validateContainer(registry, userConfig, req.params.name);
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

const port = process.env.PORT || 8080;

async function webserver() {
  const server = app.listen(port);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

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
      const message = JSON.parse(data);
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

          processUpdateQueue();
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

  console.log(`Docker Status server running on port ${port}`);
}

export default webserver;
