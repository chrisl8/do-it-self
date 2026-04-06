#!/usr/bin/env node

// Updates container-registry.yaml with volume data from registry-volumes.json.
// Removes mount_roots and obsolete shared_variables (DATA_ROOT, MEDIA_ROOT,
// CACHE_ROOT, MONITOR_ROOT), adds per-container volumes and monitor_all_mounts.
//
// Usage: node scripts/update-registry-volumes.js > new-registry.yaml

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const require = createRequire(import.meta.url);
const YAML = require(join(CONTAINERS_DIR, "web-admin/backend/node_modules/yaml"));

const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const VOLUMES_PATH = "/tmp/registry-volumes.json";

const SHARED_VARS_TO_REMOVE = new Set([
  "DATA_ROOT",
  "MEDIA_ROOT",
  "CACHE_ROOT",
  "MONITOR_ROOT",
]);

// Read inputs
const registryText = readFileSync(REGISTRY_PATH, "utf8");
const volumeData = JSON.parse(readFileSync(VOLUMES_PATH, "utf8"));

// Parse YAML, preserving comments and structure via the yaml library's Document API
const doc = YAML.parseDocument(registryText);

// --- Remove obsolete shared_variables ---
const sharedVars = doc.get("shared_variables");
if (sharedVars && YAML.isMap(sharedVars)) {
  for (const key of SHARED_VARS_TO_REMOVE) {
    sharedVars.delete(key);
  }
}

// --- Update each container ---
const containers = doc.get("containers");
if (containers && YAML.isMap(containers)) {
  for (const pair of containers.items) {
    const name = YAML.isScalar(pair.key) ? pair.key.value : String(pair.key);
    const containerMap = pair.value;
    if (!YAML.isMap(containerMap)) continue;

    // Remove mount_roots
    containerMap.delete("mount_roots");

    // Look up volume data for this container
    const volEntry = volumeData[name];
    if (!volEntry) continue;

    // Add monitor_all_mounts if true
    if (volEntry.monitorAllMounts) {
      // Insert before variables if present, otherwise at the end
      const existingMonitor = containerMap.get("monitor_all_mounts", true);
      if (existingMonitor === undefined || existingMonitor === null) {
        containerMap.set("monitor_all_mounts", true);
      }
    }

    // Build the volumes map
    if (volEntry.volumes && volEntry.volumes.length > 0) {
      const volMap = new YAML.YAMLMap();
      for (const v of volEntry.volumes) {
        const entry = new YAML.YAMLMap();
        entry.set("var", v.var);
        entry.set("host_subpath", v.host_subpath);
        entry.set("container_path", v.container_path);
        volMap.set(v.name, entry);
      }
      containerMap.set("volumes", volMap);
    }
  }
}

// Output the updated YAML
const output = doc.toString({
  lineWidth: 0, // Don't wrap lines
});
process.stdout.write(output);
