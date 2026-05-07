import webserver from "./server.js";
import dockerWatcher from "./dockerWatcher.js";
import gitStatusPoller from "./gitStatusPoller.js";
import backupPi from "./backupPi.js";

async function main() {
  try {
    await webserver();
    await dockerWatcher.init();
    await gitStatusPoller.init();
    await backupPi.init();
    console.log("Docker Status monitoring started");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
