import webserver from "./server.js";
import dockerWatcher from "./dockerWatcher.js";
import gitStatusPoller from "./gitStatusPoller.js";
import backupPi from "./backupPi.js";
import backupCoverage from "./backupCoverage.js";
import mediaStaging from "./mediaStaging.js";
import mediaStagingPush from "./mediaStagingPush.js";

async function main() {
  try {
    await webserver();
    await dockerWatcher.init();
    await gitStatusPoller.init();
    await backupPi.init();
    await backupCoverage.init();
    await mediaStaging.init();
    await mediaStagingPush.init();
    console.log("Docker Status monitoring started");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
