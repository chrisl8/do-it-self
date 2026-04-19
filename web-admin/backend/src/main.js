import webserver from "./server.js";
import dockerWatcher from "./dockerWatcher.js";
import gitStatusPoller from "./gitStatusPoller.js";

async function main() {
  try {
    await webserver();
    await dockerWatcher.init();
    await gitStatusPoller.init();
    console.log("Docker Status monitoring started");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
