#!/usr/bin/env node

// Runs one-time setup hooks declared by a container in container-registry.yaml.
// Tracks completion in installed-modules.yaml so hooks only run once.
// Failed hooks are NOT marked completed and will retry on next start.
//
// Usage:
//   node run-setup-hooks.js <container>

import { readFile, writeFile, access, constants } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import YAML from "yaml";
import { getContainerSource } from "./lib/container-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readYaml(path) {
  if (!(await fileExists(path))) return null;
  return YAML.parse(await readFile(path, "utf8"));
}

async function writeYaml(path, data) {
  await writeFile(path, YAML.stringify(data, { lineWidth: 0 }));
}

async function main() {
  const containerName = process.argv[2];
  if (!containerName) {
    console.error("Usage: run-setup-hooks.js <container>");
    process.exit(1);
  }

  const registry = (await readYaml(REGISTRY_PATH)) || {};
  const def = registry.containers?.[containerName];
  if (!def?.setup_hooks?.length) return;

  const installed = (await readYaml(INSTALLED_MODULES_PATH)) || {};
  const moduleName = getContainerSource(containerName, installed);
  if (!moduleName || moduleName === "personal" || moduleName === "platform") {
    return;
  }

  const moduleEntry = installed.modules?.[moduleName];
  if (!moduleEntry) return;

  if (!moduleEntry.container_state) {
    moduleEntry.container_state = {};
  }
  if (!moduleEntry.container_state[containerName]) {
    moduleEntry.container_state[containerName] = {};
  }
  const state = moduleEntry.container_state[containerName];
  const completed = state.setup_hooks_completed || [];

  let changed = false;
  let failed = false;

  for (const hook of def.setup_hooks) {
    if (completed.includes(hook)) continue;

    const hookPath = join(CONTAINERS_DIR, containerName, hook);
    try {
      await access(hookPath, constants.X_OK);
    } catch {
      console.warn(`  warning: setup hook not found or not executable: ${hookPath}`);
      continue;
    }

    console.log(`  setup: running ${hook} for ${containerName}...`);
    try {
      execSync(hookPath, {
        cwd: join(CONTAINERS_DIR, containerName),
        stdio: "inherit",
        timeout: 300_000,
      });
      completed.push(hook);
      changed = true;
      console.log(`  setup: ${hook} completed`);
    } catch (e) {
      console.error(`  setup: ${hook} failed`);
      failed = true;
    }
  }

  if (changed) {
    state.setup_hooks_completed = completed;
    await writeYaml(INSTALLED_MODULES_PATH, installed);
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
