import { readFile, access, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

const CONTAINERS_DIR = join(homedir(), "containers");
const CATALOG_PATH = join(CONTAINERS_DIR, "module-catalog.yaml");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");
const MODULES_DIR = join(CONTAINERS_DIR, ".modules");

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readYaml(path, fallback) {
  if (!(await fileExists(path))) return fallback;
  const text = await readFile(path, "utf8");
  return parseYaml(text) || fallback;
}

export async function getModuleCatalog() {
  return await readYaml(CATALOG_PATH, { catalogs: {} });
}

export async function getInstalledModules() {
  const data = await readYaml(INSTALLED_MODULES_PATH, { modules: {} });
  // Annotate each entry with commit_short for display
  for (const entry of Object.values(data.modules || {})) {
    if (entry.commit) entry.commit_short = entry.commit.slice(0, 7);
  }
  return data;
}

export async function getModuleYaml(moduleName) {
  const path = join(MODULES_DIR, moduleName, "module.yaml");
  return await readYaml(path, null);
}

// Walks each cloned module in .modules/, reads its module.yaml, and returns
// container entries that exist in the module but are NOT in that module's
// installed_containers list. Each entry includes the source_module name and
// the fields the Browse page needs to render a card.
export async function getAvailableContainers() {
  const installed = await getInstalledModules();
  const containers = [];

  if (!(await dirExists(MODULES_DIR))) return { containers };

  for (const [moduleName, moduleEntry] of Object.entries(installed.modules || {})) {
    const modulePath = join(MODULES_DIR, moduleName);
    if (!(await dirExists(modulePath))) continue;

    const moduleYaml = await getModuleYaml(moduleName);
    if (!moduleYaml?.containers) continue;

    const installedSet = new Set(moduleEntry.installed_containers || []);

    for (const [name, def] of Object.entries(moduleYaml.containers)) {
      if (installedSet.has(name)) continue;
      containers.push({
        name,
        source_module: moduleName,
        description: def.description || "",
        homepage_group: def.homepage_group || "Other",
        tags: def.tags || [],
        default_disabled: def.default_disabled || false,
        uses_tailscale: def.uses_tailscale || false,
        variables: def.variables || {},
        volumes: def.volumes || {},
        required_accounts: def.required_accounts || [],
      });
    }
  }

  containers.sort((a, b) => a.name.localeCompare(b.name));
  return { containers };
}
