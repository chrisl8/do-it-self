#!/usr/bin/env node

// CLI entry point for the regenerateMonitoringMounts function in
// web-admin/backend/src/configRegistry.js. The web admin invokes that
// function from a few API endpoints, but the CLI start path
// (scripts/all-containers.sh --start) doesn't go through the web admin.
// This script lets all-containers.sh trigger the same logic before
// starting homepage or beszel, so the monitoring mounts in their
// compose.yaml are always up-to-date with user-config.yaml.
//
// Imports from the web-admin's source files directly. Requires
// web-admin/backend/node_modules to exist (setup.sh installs it).

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CONFIG_REGISTRY_PATH = join(
  REPO_ROOT,
  "web-admin",
  "backend",
  "src",
  "configRegistry.js",
);

if (!existsSync(CONFIG_REGISTRY_PATH)) {
  console.error(
    `[regenerate-monitoring-mounts] Missing ${CONFIG_REGISTRY_PATH}`,
  );
  process.exit(1);
}

const { getRegistry, getUserConfig, regenerateMonitoringMounts } = await import(
  CONFIG_REGISTRY_PATH
);

try {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  await regenerateMonitoringMounts(registry, userConfig);
} catch (err) {
  console.error("[regenerate-monitoring-mounts] Failed:", err);
  process.exit(1);
}
