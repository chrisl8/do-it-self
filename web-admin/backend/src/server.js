import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { readFile } from "fs/promises";
import os from "os";
import "dotenv/config";
import getFormattedDockerContainers from "./dockerStatus.js";
import { statusEmitter, getStatus, updateStatus } from "./statusEmitter.js";

const fileName = fileURLToPath(import.meta.url);
const dirName = dirname(fileName);

const app = express();

const activeStacks = new Set();

const CONTAINERS_DIR = join(os.homedir(), "containers");
const ICONS_BASE_DIR = join(CONTAINERS_DIR, "homepage/dashboard-icons");

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
