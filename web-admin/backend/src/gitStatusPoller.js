// Background git-status poller. Every 15 minutes, fetches the platform repo
// and each installed module, computes upstream state, and pushes the payload
// via statusEmitter so the frontend surfaces "N behind" without the user
// clicking Refresh.
//
// Design notes:
// - No moduleOpInFlight lock. git fetch is read-only; .git/objects locking
//   serializes against concurrent mutations naturally.
// - Single-flight guard: a tick that takes longer than the interval (slow
//   network) won't double-fire; the next interval finds the previous tick
//   still running and skips.
// - Fetch failures per-repo are logged and don't abort the batch.
// - First tick runs immediately on init() so the UI has data within seconds,
//   not 15 minutes, of a cold start.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import os from "os";
import YAML from "yaml";
import { updateStatus } from "./statusEmitter.js";
import { getRepoStatus, bestEffortFetch } from "./gitRepoStatus.js";

const CONTAINERS_DIR = join(os.homedir(), "containers");
const MODULES_DIR = join(CONTAINERS_DIR, ".modules");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");

const TICK_INTERVAL_MS = 15 * 60 * 1000;

let tickTimer = null;
let tickInFlight = false;

function readInstalledModuleNames() {
  if (!existsSync(INSTALLED_MODULES_PATH)) return [];
  try {
    const parsed = YAML.parse(readFileSync(INSTALLED_MODULES_PATH, "utf8"));
    return Object.keys(parsed?.modules || {}).filter((n) =>
      existsSync(join(MODULES_DIR, n)),
    );
  } catch {
    return [];
  }
}

async function buildRepoEntry(name, label, repoPath, isModule) {
  const status = await getRepoStatus(name, label, repoPath, isModule);
  status.fetchedAt = new Date().toISOString();
  return status;
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const moduleNames = readInstalledModuleNames();

    // Fetch in parallel -- per-repo timeouts bound the worst case.
    await Promise.all([
      bestEffortFetch(CONTAINERS_DIR, "platform"),
      ...moduleNames.map((name) => bestEffortFetch(join(MODULES_DIR, name), name)),
    ]);

    const repos = [];
    repos.push(await buildRepoEntry("platform", "Platform", CONTAINERS_DIR, false));
    for (const name of moduleNames) {
      repos.push(await buildRepoEntry(name, name, join(MODULES_DIR, name), true));
    }

    updateStatus("gitStatus", {
      repos,
      lastTickAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("gitStatusPoller tick failed:", err.message);
  } finally {
    tickInFlight = false;
  }
}

async function start() {
  console.log("git status poller: starting (15-minute interval)");
  // Kick off the first tick without blocking init() -- a slow network
  // shouldn't delay the web admin coming up.
  tick();
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
}

async function stop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export default { init: start, stop };
