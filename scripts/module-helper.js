#!/usr/bin/env node

// Module system CLI helper for the do-it-self container platform.
// Manages module repos cloned into .modules/ and container installation.
//
// Usage: node module-helper.js <subcommand> [args...]
// Subcommands: add-source, remove-source, install, uninstall, update, list, regenerate-registry
//
// See docs/MODULES.md for the full design.

import { readFile, writeFile, access, mkdir, rm, cp, readdir, rename } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const MODULES_DIR = join(CONTAINERS_DIR, ".modules");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");

// --- Utility helpers ---

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function dirExists(path) {
  try {
    const stat = await import("fs").then((m) => m.promises.stat(path));
    return stat.isDirectory();
  } catch { return false; }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts }).trim();
}

async function ensureModulesDir() {
  if (!(await dirExists(MODULES_DIR))) {
    await mkdir(MODULES_DIR, { recursive: true });
  }
}

async function readYaml(path) {
  if (!(await fileExists(path))) return null;
  const text = await readFile(path, "utf8");
  return YAML.parse(text);
}

async function readYamlDoc(path) {
  if (!(await fileExists(path))) return null;
  const text = await readFile(path, "utf8");
  return YAML.parseDocument(text);
}

async function writeYaml(path, data) {
  const text = YAML.stringify(data, { lineWidth: 0 });
  await writeFile(path, text);
}

async function atomicWriteYaml(path, data) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  const text = YAML.stringify(data, { lineWidth: 0 });
  // Validate by re-parsing
  YAML.parse(text);
  await writeFile(tmp, text);
  if (await fileExists(path)) {
    await rename(path, bak);
  }
  await rename(tmp, path);
}

// Read the registry, preserving the Document for comment-safe writes when possible.
async function readRegistry() {
  if (!(await fileExists(REGISTRY_PATH))) {
    return { shared_variables: {}, categories: {}, containers: {} };
  }
  return await readYaml(REGISTRY_PATH);
}

async function writeRegistry(data) {
  await atomicWriteYaml(REGISTRY_PATH, data);
}

async function readInstalledModules() {
  const data = await readYaml(INSTALLED_MODULES_PATH);
  return data || { modules: {} };
}

async function writeInstalledModules(data) {
  await writeYaml(INSTALLED_MODULES_PATH, data);
}

async function readModuleYaml(moduleName) {
  const modulePath = join(MODULES_DIR, moduleName, "module.yaml");
  const data = await readYaml(modulePath);
  if (!data) {
    console.error(`Error: module.yaml not found in .modules/${moduleName}/`);
    process.exit(1);
  }
  return data;
}

function deriveModuleName(url) {
  // Extract last path component, strip .git suffix
  const parts = url.replace(/\/$/, "").split("/");
  return basename(parts[parts.length - 1], ".git");
}

// --- Subcommands ---

async function addSource(args) {
  if (args.length < 1) {
    console.error("Usage: module.sh add-source <url> [--name <name>]");
    process.exit(1);
  }

  const url = args[0];
  let name = deriveModuleName(url);

  const nameIdx = args.indexOf("--name");
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    name = args[nameIdx + 1];
  }

  await ensureModulesDir();

  const modulePath = join(MODULES_DIR, name);
  if (await dirExists(modulePath)) {
    console.error(`Error: Module "${name}" already exists at .modules/${name}/`);
    console.error("Use 'module.sh update' to update it, or 'module.sh remove-source' first.");
    process.exit(1);
  }

  console.log(`Cloning ${url} into .modules/${name}/...`);
  try {
    exec(`git clone "${url}" "${modulePath}"`);
  } catch (e) {
    console.error(`Error: Failed to clone ${url}`);
    console.error(e.message);
    process.exit(1);
  }

  const moduleYamlPath = join(modulePath, "module.yaml");
  if (!(await fileExists(moduleYamlPath))) {
    console.error(`Error: Cloned repo does not contain a module.yaml file.`);
    await rm(modulePath, { recursive: true, force: true });
    process.exit(1);
  }

  const moduleYaml = await readYaml(moduleYamlPath);
  const commit = exec(`git -C "${modulePath}" rev-parse HEAD`);

  const installed = await readInstalledModules();
  installed.modules[name] = {
    url,
    commit,
    added: new Date().toISOString(),
    updated: new Date().toISOString(),
    installed_containers: [],
  };
  await writeInstalledModules(installed);

  const containerNames = Object.keys(moduleYaml.containers || {});
  console.log(`Module "${name}" added successfully.`);
  if (containerNames.length > 0) {
    console.log(`Available containers (${containerNames.length}):`);
    for (const c of containerNames.sort()) {
      const desc = moduleYaml.containers[c].description || "";
      console.log(`  ${c} — ${desc}`);
    }
  }
}

async function removeSource(args) {
  if (args.length < 1) {
    console.error("Usage: module.sh remove-source <name>");
    process.exit(1);
  }

  const name = args[0];
  const modulePath = join(MODULES_DIR, name);

  if (!(await dirExists(modulePath))) {
    console.error(`Error: Module "${name}" not found at .modules/${name}/`);
    process.exit(1);
  }

  const installed = await readInstalledModules();
  const moduleEntry = installed.modules[name];
  if (moduleEntry && moduleEntry.installed_containers && moduleEntry.installed_containers.length > 0) {
    console.error(`Error: Cannot remove module "${name}" — the following containers are still installed:`);
    for (const c of moduleEntry.installed_containers) {
      console.error(`  - ${c}`);
    }
    console.error("Uninstall these containers first with 'module.sh uninstall <container>'.");
    process.exit(1);
  }

  await rm(modulePath, { recursive: true, force: true });
  if (installed.modules[name]) {
    delete installed.modules[name];
    await writeInstalledModules(installed);
  }

  console.log(`Module "${name}" removed.`);
}

async function installContainer(args) {
  if (args.length < 2) {
    console.error("Usage: module.sh install <module-name> <container-name>");
    process.exit(1);
  }

  const [moduleName, containerName] = args;
  const modulePath = join(MODULES_DIR, moduleName);
  const sourceDir = join(modulePath, containerName);
  const targetDir = join(CONTAINERS_DIR, containerName);

  // Validate module exists
  if (!(await dirExists(modulePath))) {
    console.error(`Error: Module "${moduleName}" not found. Run 'module.sh add-source' first.`);
    process.exit(1);
  }

  // Validate container exists in module
  if (!(await dirExists(sourceDir))) {
    const moduleYaml = await readModuleYaml(moduleName);
    const available = Object.keys(moduleYaml.containers || {});
    console.error(`Error: Container "${containerName}" not found in module "${moduleName}".`);
    if (available.length > 0) {
      console.error(`Available containers: ${available.join(", ")}`);
    }
    process.exit(1);
  }

  // Check target doesn't already exist
  if (await dirExists(targetDir)) {
    const registry = await readRegistry();
    const existing = registry.containers?.[containerName];
    const source = existing?.source || "unknown";
    console.error(`Error: Container "${containerName}" already exists at ${targetDir}`);
    console.error(`  Current source: ${source}`);
    process.exit(1);
  }

  // Read module.yaml for this container's registry entry
  const moduleYaml = await readModuleYaml(moduleName);
  const containerDef = moduleYaml.containers?.[containerName];
  if (!containerDef) {
    console.error(`Error: Container "${containerName}" has a directory in the module but no entry in module.yaml.`);
    process.exit(1);
  }

  // Copy container directory
  console.log(`Installing ${containerName} from ${moduleName}...`);
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !src.includes(".git"),
  });

  // Write .start-order if specified
  if (containerDef.start_order) {
    await writeFile(join(targetDir, ".start-order"), containerDef.start_order + "\n");
  }

  // Update container-registry.yaml
  const registry = await readRegistry();
  registry.containers = registry.containers || {};
  registry.containers[containerName] = { source: moduleName, ...containerDef };

  // Merge categories from module
  if (moduleYaml.categories) {
    registry.categories = registry.categories || {};
    for (const [key, val] of Object.entries(moduleYaml.categories)) {
      if (!registry.categories[key]) {
        registry.categories[key] = val;
      }
    }
  }

  // Sort containers alphabetically
  const sorted = {};
  for (const key of Object.keys(registry.containers).sort()) {
    sorted[key] = registry.containers[key];
  }
  registry.containers = sorted;

  await writeRegistry(registry);

  // Update installed-modules.yaml
  const installed = await readInstalledModules();
  if (!installed.modules[moduleName]) {
    // Module was cloned but not tracked (shouldn't happen, but be safe)
    const commit = exec(`git -C "${modulePath}" rev-parse HEAD`);
    installed.modules[moduleName] = {
      url: moduleYaml.url || "",
      commit,
      added: new Date().toISOString(),
      updated: new Date().toISOString(),
      installed_containers: [],
    };
  }
  if (!installed.modules[moduleName].installed_containers.includes(containerName)) {
    installed.modules[moduleName].installed_containers.push(containerName);
    installed.modules[moduleName].installed_containers.sort();
  }
  await writeInstalledModules(installed);

  console.log(`Container "${containerName}" installed from module "${moduleName}".`);
  console.log(`Enable it via the web admin or user-config.yaml, then run all-containers.sh --start.`);
}

async function uninstallContainer(args) {
  if (args.length < 1) {
    console.error("Usage: module.sh uninstall <container-name>");
    process.exit(1);
  }

  const containerName = args[0];
  const targetDir = join(CONTAINERS_DIR, containerName);

  // Read registry to find source
  const registry = await readRegistry();
  const containerDef = registry.containers?.[containerName];

  if (!containerDef) {
    console.error(`Error: Container "${containerName}" not found in container-registry.yaml.`);
    process.exit(1);
  }

  if (containerDef.source === "personal" || containerDef.source === "platform") {
    console.error(`Error: Container "${containerName}" has source: ${containerDef.source}.`);
    console.error("Only module-sourced containers can be uninstalled via the module system.");
    console.error("Delete the directory manually if you want to remove it.");
    process.exit(1);
  }

  const moduleName = containerDef.source;

  // Stop container if running
  if (await dirExists(targetDir)) {
    try {
      const ps = exec(`docker compose ps -q 2>/dev/null`, { cwd: targetDir });
      if (ps) {
        console.log(`Stopping ${containerName}...`);
        exec(`docker compose down`, { cwd: targetDir });
      }
    } catch {
      // Container not running or docker not available — fine
    }

    // Remove container directory
    await rm(targetDir, { recursive: true, force: true });
  }

  // Remove from registry
  delete registry.containers[containerName];
  await writeRegistry(registry);

  // Update installed-modules.yaml
  if (moduleName) {
    const installed = await readInstalledModules();
    const moduleEntry = installed.modules[moduleName];
    if (moduleEntry) {
      moduleEntry.installed_containers = (moduleEntry.installed_containers || [])
        .filter((c) => c !== containerName);
      await writeInstalledModules(installed);
    }
  }

  console.log(`Container "${containerName}" uninstalled.`);
  console.log("Volume data (~container-mounts/), credentials (~credentials/), and user-config.yaml entries are preserved.");
}

// Files/dirs to preserve in the target during update (never overwritten from module source)
const PRESERVE_ON_UPDATE = [
  "config-personal",
  "compose.override.yaml",
  ".env",
  "tailscale-state",
];

async function updateModules(args) {
  const specificModule = args[0] || null;
  const installed = await readInstalledModules();
  const moduleNames = specificModule
    ? [specificModule]
    : Object.keys(installed.modules);

  if (moduleNames.length === 0) {
    console.log("No modules installed. Use 'module.sh add-source' to add one.");
    return;
  }

  let anyUpdated = false;

  for (const name of moduleNames) {
    const moduleEntry = installed.modules[name];
    if (!moduleEntry) {
      console.error(`Warning: Module "${name}" not found in installed-modules.yaml, skipping.`);
      continue;
    }

    const modulePath = join(MODULES_DIR, name);
    if (!(await dirExists(modulePath))) {
      console.error(`Warning: Module "${name}" directory missing at .modules/${name}/, skipping.`);
      continue;
    }

    // Pull latest
    console.log(`Updating ${name}...`);
    try {
      exec(`git -C "${modulePath}" pull`);
    } catch (e) {
      console.error(`Warning: git pull failed for ${name}: ${e.message}`);
      continue;
    }

    const newCommit = exec(`git -C "${modulePath}" rev-parse HEAD`);
    if (newCommit === moduleEntry.commit) {
      console.log(`  ${name}: already up to date.`);
      continue;
    }

    anyUpdated = true;
    const moduleYaml = await readModuleYaml(name);
    const containerList = moduleEntry.installed_containers || [];

    for (const containerName of containerList) {
      const sourceDir = join(modulePath, containerName);
      const targetDir = join(CONTAINERS_DIR, containerName);

      if (!(await dirExists(sourceDir))) {
        console.error(`  Warning: ${containerName} no longer exists in module ${name}, skipping.`);
        continue;
      }

      if (!(await dirExists(targetDir))) {
        console.error(`  Warning: ${containerName} directory missing at platform root, skipping.`);
        continue;
      }

      // Collect preserved files/dirs that exist in the target
      const preserved = new Map();
      for (const item of PRESERVE_ON_UPDATE) {
        const itemPath = join(targetDir, item);
        if (await fileExists(itemPath)) {
          const tmpPath = join(CONTAINERS_DIR, `.preserve-${containerName}-${item.replace(/\//g, "-")}`);
          // Move to temp location
          await rename(itemPath, tmpPath);
          preserved.set(item, tmpPath);
        }
      }

      // Remove old and copy fresh
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourceDir, targetDir, {
        recursive: true,
        filter: (src) => !src.includes(".git"),
      });

      // Restore preserved files
      for (const [item, tmpPath] of preserved) {
        await rename(tmpPath, join(targetDir, item));
      }

      // Update .start-order if specified in module.yaml
      const containerDef = moduleYaml.containers?.[containerName];
      if (containerDef?.start_order) {
        await writeFile(join(targetDir, ".start-order"), containerDef.start_order + "\n");
      }

      console.log(`  ${containerName}: updated.`);
    }

    // Update registry entries for installed containers
    const registry = await readRegistry();
    for (const containerName of containerList) {
      const containerDef = moduleYaml.containers?.[containerName];
      if (containerDef) {
        registry.containers[containerName] = { source: name, ...containerDef };
      }
    }

    // Sort containers alphabetically
    const sorted = {};
    for (const key of Object.keys(registry.containers).sort()) {
      sorted[key] = registry.containers[key];
    }
    registry.containers = sorted;

    await writeRegistry(registry);

    // Update tracking
    moduleEntry.commit = newCommit;
    moduleEntry.updated = new Date().toISOString();
  }

  await writeInstalledModules(installed);

  if (anyUpdated) {
    console.log("Update complete. Restart affected containers with all-containers.sh --start.");
  } else {
    console.log("All modules are up to date.");
  }
}

async function listContainers(args) {
  const mode = args[0] || "--installed";
  const installed = await readInstalledModules();
  const registry = await readRegistry();

  if (mode === "--installed" || mode === "--all") {
    const installedContainers = [];
    for (const [moduleName, entry] of Object.entries(installed.modules)) {
      for (const c of entry.installed_containers || []) {
        const desc = registry.containers?.[c]?.description || "";
        installedContainers.push({ name: c, module: moduleName, description: desc });
      }
    }

    // Also include personal and platform containers
    for (const [name, def] of Object.entries(registry.containers || {})) {
      if (def.source === "personal" || def.source === "platform") {
        installedContainers.push({ name, module: def.source, description: def.description || "" });
      }
    }

    installedContainers.sort((a, b) => a.name.localeCompare(b.name));

    if (mode === "--installed" || installedContainers.length > 0) {
      console.log("Installed containers:");
      if (installedContainers.length === 0) {
        console.log("  (none from modules)");
      } else {
        for (const c of installedContainers) {
          console.log(`  ${c.name} [${c.module}] — ${c.description}`);
        }
      }
    }
  }

  if (mode === "--available" || mode === "--all") {
    if (mode === "--all") console.log("");

    // Collect all installed container names
    const installedNames = new Set();
    for (const entry of Object.values(installed.modules)) {
      for (const c of entry.installed_containers || []) {
        installedNames.add(c);
      }
    }
    // Also count personal and platform containers as installed
    for (const [name, def] of Object.entries(registry.containers || {})) {
      if (def.source === "personal" || def.source === "platform") {
        installedNames.add(name);
      }
    }

    const availableContainers = [];
    for (const [moduleName, _entry] of Object.entries(installed.modules)) {
      const modulePath = join(MODULES_DIR, moduleName);
      if (!(await dirExists(modulePath))) continue;

      const moduleYaml = await readYaml(join(modulePath, "module.yaml"));
      if (!moduleYaml?.containers) continue;

      for (const [name, def] of Object.entries(moduleYaml.containers)) {
        if (!installedNames.has(name)) {
          availableContainers.push({ name, module: moduleName, description: def.description || "" });
        }
      }
    }

    availableContainers.sort((a, b) => a.name.localeCompare(b.name));

    console.log("Available containers (not installed):");
    if (availableContainers.length === 0) {
      console.log("  (none)");
    } else {
      for (const c of availableContainers) {
        console.log(`  ${c.name} [${c.module}] — ${c.description}`);
      }
    }
  }

  if (!["--installed", "--available", "--all"].includes(mode)) {
    console.error(`Unknown list mode: ${mode}`);
    console.error("Usage: module.sh list [--available | --installed | --all]");
    process.exit(1);
  }
}

async function regenerateRegistry() {
  const installed = await readInstalledModules();
  const registry = await readRegistry();

  // Preserve shared_variables and personal containers
  const newRegistry = {
    shared_variables: registry.shared_variables || {},
    categories: { ...(registry.categories || {}) },
    containers: {},
  };

  // Keep personal and platform containers
  for (const [name, def] of Object.entries(registry.containers || {})) {
    if (def.source === "personal" || def.source === "platform") {
      newRegistry.containers[name] = def;
    }
  }

  // Merge module containers
  for (const [moduleName, entry] of Object.entries(installed.modules)) {
    const modulePath = join(MODULES_DIR, moduleName);
    if (!(await dirExists(modulePath))) continue;

    const moduleYaml = await readYaml(join(modulePath, "module.yaml"));
    if (!moduleYaml) continue;

    // Merge categories
    if (moduleYaml.categories) {
      for (const [key, val] of Object.entries(moduleYaml.categories)) {
        if (!newRegistry.categories[key]) {
          newRegistry.categories[key] = val;
        }
      }
    }

    // Add installed containers from this module
    for (const containerName of entry.installed_containers || []) {
      const containerDef = moduleYaml.containers?.[containerName];
      if (containerDef) {
        newRegistry.containers[containerName] = { source: moduleName, ...containerDef };
      }
    }
  }

  // Sort containers alphabetically
  const sorted = {};
  for (const key of Object.keys(newRegistry.containers).sort()) {
    sorted[key] = newRegistry.containers[key];
  }
  newRegistry.containers = sorted;

  await writeRegistry(newRegistry);
  const total = Object.keys(newRegistry.containers).length;
  const personal = Object.values(newRegistry.containers).filter((d) => d.source === "personal").length;
  console.log(`Registry regenerated: ${total} containers (${personal} personal, ${total - personal} from modules).`);
}

// --- Main ---

const subcommands = {
  "add-source": addSource,
  "remove-source": removeSource,
  install: installContainer,
  uninstall: uninstallContainer,
  update: updateModules,
  list: listContainers,
  "regenerate-registry": regenerateRegistry,
};

const [subcommand, ...args] = process.argv.slice(2);

if (!subcommand || !subcommands[subcommand]) {
  console.error(`Unknown subcommand: ${subcommand || "(none)"}`);
  console.error(`Available: ${Object.keys(subcommands).join(", ")}`);
  process.exit(1);
}

subcommands[subcommand](args).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
