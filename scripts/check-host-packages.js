#!/usr/bin/env node

// Checks whether host packages declared by a container in container-registry.yaml
// are installed. Prints warnings with install commands for missing packages.
// Never blocks startup — exits 0 always.
//
// Usage:
//   node check-host-packages.js <container>

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");

async function main() {
  const containerName = process.argv[2];
  if (!containerName) {
    console.error("Usage: check-host-packages.js <container>");
    process.exit(1);
  }

  const registry = YAML.parse(await readFile(REGISTRY_PATH, "utf8")) || {};
  const def = registry.containers?.[containerName];
  if (!def?.host_packages?.length) return;

  const missing = [];
  for (const pkg of def.host_packages) {
    try {
      execSync(`dpkg -s "${pkg}" 2>/dev/null`, { encoding: "utf8" });
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length > 0) {
    console.warn(
      `  warning: ${containerName} needs host packages: ${missing.join(", ")}`,
    );
    console.warn(`    Install with: sudo apt-get install ${missing.join(" ")}`);
  }
}

main().catch(() => {});
