#!/usr/bin/env node

// Module system CLI helper for the do-it-self container platform.
// Manages module repos cloned into .modules/ and container installation.
//
// Usage: node module-helper.js <subcommand> [args...]
// Subcommands: add-source, remove-source, install, uninstall, update, list, regenerate-registry, dev-sync
//
// See docs/MODULES.md for the full design.

import { readFile, writeFile, access, mkdir, rm, cp, readdir, rename } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync, execFileSync } from "child_process";
import { createInterface } from "readline";
import YAML from "yaml";
import { PLATFORM_CONTAINERS, getContainerSource } from "./lib/container-source.js";

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
  return execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...opts }).trim();
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
    return { shared_variables: {}, containers: {} };
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
    const installedCheck = await readInstalledModules();
    const source = getContainerSource(containerName, installedCheck) || "unknown";
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

  // Resolve source from installed-modules.yaml (and the platform allowlist).
  const installed = await readInstalledModules();
  const source = getContainerSource(containerName, installed);

  if (!source) {
    console.error(`Error: Container "${containerName}" is not tracked in installed-modules.yaml.`);
    process.exit(1);
  }

  if (source === "personal" || source === "platform") {
    console.error(`Error: Container "${containerName}" has source: ${source}.`);
    console.error("Only module-sourced containers can be uninstalled via the module system.");
    console.error("Delete the directory manually if you want to remove it.");
    process.exit(1);
  }

  const registry = await readRegistry();
  if (registry.containers?.[containerName]?.protected === true) {
    console.error(`Error: "${containerName}" is marked protected: true in the registry.`);
    console.error("Edit the registry to remove the flag before uninstalling.");
    process.exit(1);
  }

  const moduleName = source;

  // Remove cron jobs before deleting the container directory
  const cronHelper = join(__dirname, "manage-cron-jobs.js");
  try {
    exec(`node "${cronHelper}" remove "${containerName}"`);
  } catch {
    // Cron removal is best-effort
  }

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

  // Update installed-modules.yaml (including setup_hooks state)
  const moduleEntry = installed.modules?.[moduleName];
  if (moduleEntry) {
    moduleEntry.installed_containers = (moduleEntry.installed_containers || [])
      .filter((c) => c !== containerName);
    if (moduleEntry.container_state?.[containerName]) {
      delete moduleEntry.container_state[containerName];
    }
    await writeInstalledModules(installed);
  }

  console.log(`Container "${containerName}" uninstalled.`);
  console.log("Volume data (~container-mounts/), credentials (~credentials/), and user-config.yaml entries are preserved.");
}

// Files/dirs to preserve in the target during update (never overwritten from module source).
// Note: tailscale-state is NOT here — it lives outside container dirs on the primary
// mount at <mount[0]>/tailscale-state/<container-name>/, managed via TS_STATE_DIR env var.
const PRESERVE_ON_UPDATE = [
  "config-personal",
  "compose.override.yaml",
  ".env",
  "icons",
  "images",
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
  const registry = await readRegistry();

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
      const stagingDir = `${targetDir}.new`;
      const oldDir = `${targetDir}.old`;

      // Recovery: handle state from a previous interrupted run of this
      // container. Order matters — restore targetDir first, before any
      // existence guards or sweeping, so a crash mid-swap self-heals here.
      if (!(await dirExists(targetDir)) && (await dirExists(oldDir))) {
        // Crashed between the two renames below. Roll back to the original.
        await rename(oldDir, targetDir);
      }
      if (!(await dirExists(targetDir)) && (await dirExists(stagingDir))) {
        // Original is gone but staging survives — promote it as last-ditch
        // recovery. Preserves from before the crash are lost, matching the
        // pre-refactor worst-case.
        await rename(stagingDir, targetDir);
      }
      // Any remaining staging/old dir is stale debris from a prior crash
      // and must be removed before we rebuild.
      if (await dirExists(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }
      if (await dirExists(oldDir)) {
        await rm(oldDir, { recursive: true, force: true });
      }

      if (!(await dirExists(sourceDir))) {
        console.error(`  Warning: ${containerName} no longer exists in module ${name}, skipping.`);
        continue;
      }

      if (!(await dirExists(targetDir))) {
        console.error(`  Warning: ${containerName} directory missing at platform root, skipping.`);
        continue;
      }

      // Copy module source into a staging dir. targetDir remains intact;
      // a crash before the atomic swap below leaves only stagingDir as
      // debris, which the recovery block above will sweep on the next run.
      await cp(sourceDir, stagingDir, {
        recursive: true,
        filter: (src) => !src.includes(".git"),
      });

      // Union the static preserve list with this container's git_repos
      // keys from container-registry.yaml. Keeps registry-declared clones
      // (homepage's dashboard-icons, tsidp, valheim, minecraft) in place
      // through module updates, instead of relying on the auto-clone in
      // all-containers.sh --start to recover them after the fact.
      const gitRepoDirs = Object.keys(
        registry?.containers?.[containerName]?.git_repos ?? {},
      );
      const preserveList = [...PRESERVE_ON_UPDATE, ...gitRepoDirs];

      // Copy preserved files from live targetDir into staging. cp (not
      // rename) keeps the original tree intact so we can abort by simply
      // rm'ing stagingDir if anything goes wrong. force:true handles the
      // merge-with-module-default case (e.g. icons/).
      for (const item of preserveList) {
        const src = join(targetDir, item);
        if (!(await fileExists(src))) continue;
        const dst = join(stagingDir, item);
        await cp(src, dst, { recursive: true, force: true });
      }

      // Apply .start-order in staging if specified in module.yaml.
      const containerDef = moduleYaml.containers?.[containerName];
      if (containerDef?.start_order) {
        await writeFile(join(stagingDir, ".start-order"), containerDef.start_order + "\n");
      }

      // Atomic swap. Between these two renames targetDir does not exist
      // but oldDir does — the recovery block at the top of the next run
      // restores it. Same-filesystem renames are atomic.
      await rename(targetDir, oldDir);
      await rename(stagingDir, targetDir);
      await rm(oldDir, { recursive: true, force: true });

      console.log(`  ${containerName}: updated.`);
    }

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
    for (const name of installed.personal_containers || []) {
      const desc = registry.containers?.[name]?.description || "";
      installedContainers.push({ name, module: "personal", description: desc });
    }
    for (const name of PLATFORM_CONTAINERS) {
      const desc = registry.containers?.[name]?.description || "";
      installedContainers.push({ name, module: "platform", description: desc });
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
    for (const c of installed.personal_containers || []) installedNames.add(c);
    for (const c of PLATFORM_CONTAINERS) installedNames.add(c);

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

// Maintainer-side tool. Rebuilds container-registry.yaml as a union of every
// container schema declared in any cloned .modules/*/module.yaml, plus any
// platform-container entries that were already in the registry (those are
// not module-sourced and have to persist). Preserves shared_variables.
//
// Downstream users do NOT run this. It exists so the platform maintainer can
// refresh the committed catalog after module repos change.
async function regenerateRegistry() {
  const registry = await readRegistry();

  const newRegistry = {
    shared_variables: registry.shared_variables || {},
    containers: {},
  };

  // Preserve platform containers verbatim from the existing registry.
  for (const name of PLATFORM_CONTAINERS) {
    const existing = registry.containers?.[name];
    if (existing) {
      // Drop any stale `source:` field from the legacy format.
      const { source: _drop, ...rest } = existing;
      newRegistry.containers[name] = rest;
    }
  }

  // Iterate EVERY cloned module, not just installed ones.
  const moduleNames = (await readdir(MODULES_DIR).catch(() => []))
    .filter((n) => !n.startsWith("."));

  let moduleCount = 0;
  for (const moduleName of moduleNames) {
    const modulePath = join(MODULES_DIR, moduleName);
    if (!(await dirExists(modulePath))) continue;
    const moduleYaml = await readYaml(join(modulePath, "module.yaml"));
    if (!moduleYaml?.containers) continue;
    moduleCount++;
    for (const [containerName, def] of Object.entries(moduleYaml.containers)) {
      // Overwrite any earlier entry; last-module-wins for duplicates.
      newRegistry.containers[containerName] = { ...def };
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
  console.log(`Registry rebuilt from module catalogs: ${total} containers from ${moduleCount} modules.`);
  console.log("This is a maintainer-side tool; commit the result to the platform repo.");
}

// --- Dev-sync ---

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function buildSyncExcludes(containerName, registry) {
  const excludes = [...PRESERVE_ON_UPDATE, "tailscale-state", ".git", "node_modules"];
  const containerDef = registry.containers?.[containerName];
  if (containerDef?.git_repos) {
    for (const subdir of Object.keys(containerDef.git_repos)) {
      excludes.push(subdir);
    }
  }
  return excludes.flatMap((e) => ["--exclude", e]);
}

async function syncOneContainer(containerName, moduleName, registry, yesFlag) {
  const sourceDir = join(CONTAINERS_DIR, containerName) + "/";
  const targetDir = join(MODULES_DIR, moduleName, containerName) + "/";

  if (!(await dirExists(join(CONTAINERS_DIR, containerName)))) {
    console.error(`Error: Container directory not found at ${containerName}/`);
    return false;
  }
  if (!(await dirExists(join(MODULES_DIR, moduleName, containerName)))) {
    console.error(`Error: Module source not found at .modules/${moduleName}/${containerName}/`);
    return false;
  }

  const excludeArgs = buildSyncExcludes(containerName, registry);
  const baseArgs = ["rsync", "--archive", "--checksum", "--delete", ...excludeArgs, sourceDir, targetDir];

  const rawPreview = exec(
    [...baseArgs, "--dry-run", "--itemize-changes"].map((a) => `"${a}"`).join(" "),
  );

  // Filter to only show real changes (not timestamp-only).
  // rsync itemize format: position 0 is '.' when nothing is transferred.
  // Lines starting with '*deleting' indicate removed files.
  const preview = rawPreview
    .split("\n")
    .filter((line) => line && !line.startsWith("."))
    .join("\n");

  if (!preview) {
    console.log(`  ${containerName}: no changes.`);
    return false;
  }

  console.log(`\nChanges for ${containerName}:`);
  console.log(preview);

  if (!yesFlag) {
    const answer = await ask(`\nSync ${containerName} to .modules/${moduleName}/${containerName}/? [y/N] `);
    if (answer !== "y" && answer !== "yes") {
      console.log(`  Skipped ${containerName}.`);
      return false;
    }
  }

  exec(baseArgs.map((a) => `"${a}"`).join(" "));
  console.log(`  ${containerName}: synced.`);
  return true;
}

async function devSync(args) {
  const yesFlag = args.includes("--yes") || args.includes("-y");
  const filteredArgs = args.filter((a) => a !== "--yes" && a !== "-y");

  if (filteredArgs.length === 0) {
    console.log("Usage: module.sh dev-sync [<module>] [<container>]");
    console.log("");
    console.log("  dev-sync <container>           Sync one container (auto-detect module)");
    console.log("  dev-sync <module>              Sync all installed containers from a module");
    console.log("  dev-sync <module> <container>  Sync one container from a specific module");
    console.log("");
    console.log("Options:");
    console.log("  --yes, -y  Skip confirmation prompts");
    return;
  }

  const installed = await readInstalledModules();
  const registry = await readRegistry();

  let moduleName;
  let containerNames;

  if (filteredArgs.length === 2) {
    moduleName = filteredArgs[0];
    containerNames = [filteredArgs[1]];
    if (!installed.modules?.[moduleName]) {
      console.error(`Error: Module "${moduleName}" not found in installed-modules.yaml.`);
      process.exit(1);
    }
  } else {
    const arg = filteredArgs[0];
    if (installed.modules?.[arg]) {
      moduleName = arg;
      containerNames = installed.modules[arg].installed_containers || [];
      if (containerNames.length === 0) {
        console.log(`No installed containers from module "${moduleName}".`);
        return;
      }
      console.log(`Syncing all ${containerNames.length} containers from ${moduleName}...`);
    } else {
      const containerDef = registry.containers?.[arg];
      if (!containerDef) {
        console.error(`Error: "${arg}" is not a known module or container name.`);
        process.exit(1);
      }
      const source = getContainerSource(arg, installed);
      if (!source || source === "personal" || source === "platform") {
        console.error(`Error: Container "${arg}" is not from a module (source: ${source || "unknown"}). dev-sync only works with module-sourced containers.`);
        process.exit(1);
      }
      moduleName = source;
      containerNames = [arg];
    }
  }

  const modulePath = join(MODULES_DIR, moduleName);
  if (!(await dirExists(modulePath))) {
    console.error(`Error: Module directory not found at .modules/${moduleName}/`);
    process.exit(1);
  }

  const syncedNames = [];
  for (const name of containerNames) {
    const synced = await syncOneContainer(name, moduleName, registry, yesFlag);
    if (synced) syncedNames.push(name);
  }

  if (syncedNames.length === 0) {
    console.log("\nNo changes to commit.");
    return;
  }

  const status = exec(`git -C "${modulePath}" status --porcelain`);
  if (!status) {
    console.log("\nNo changes to commit.");
    return;
  }

  console.log(`\nModule repo diff (.modules/${moduleName}/):`);
  try {
    const diff = exec(`git -C "${modulePath}" diff`);
    if (diff) console.log(diff);
    const untrackedDiff = exec(`git -C "${modulePath}" diff --cached`);
    if (untrackedDiff) console.log(untrackedDiff);
  } catch {
    // diff can fail on new untracked files, show status instead
    console.log(status);
  }

  if (!yesFlag) {
    const answer = await ask(`\nCommit changes to ${moduleName}? [y/N] `);
    if (answer !== "y" && answer !== "yes") {
      console.log("Changes synced but not committed.");
      return;
    }
  }

  const changedList = syncedNames.filter((name) => {
    try {
      const sub = exec(`git -C "${modulePath}" status --porcelain -- "${name}"`);
      return sub.length > 0;
    } catch { return false; }
  });
  const defaultMsg = `Update ${changedList.join(", ")}`;

  let commitMsg = defaultMsg;
  if (!yesFlag) {
    const input = await ask(`Commit message [${defaultMsg}]: `);
    if (input) commitMsg = input;
  }

  execFileSync("git", ["-C", modulePath, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", modulePath, "commit", "-m", commitMsg], {
    encoding: "utf8",
    stdio: "inherit",
  });
  console.log("Committed.");

  if (!yesFlag) {
    const answer = await ask("Push to remote? [y/N] ");
    if (answer !== "y" && answer !== "yes") {
      console.log("Committed locally. Run `git push` in the module repo when ready.");
      return;
    }
  }

  execFileSync("git", ["-C", modulePath, "push"], { encoding: "utf8", stdio: "inherit" });
  console.log("Pushed.");
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
  "dev-sync": devSync,
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
