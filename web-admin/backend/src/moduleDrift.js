import { readFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

const CONTAINERS_DIR = join(homedir(), "containers");
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

// Content-only drift check: does a container's root compose.yaml match its
// module source? Mirrors `scripts/module.sh check` but skips the git fetch
// (this runs on every dashboard poll -- keep it filesystem-only and fast).
// The scheduled health-check script covers the "module behind its remote"
// half of the picture; see docs/MODULES.md.
async function getDriftedContainers() {
  const drifted = new Set();

  let installed;
  try {
    if (!(await fileExists(INSTALLED_MODULES_PATH))) return drifted;
    installed = parseYaml(await readFile(INSTALLED_MODULES_PATH, "utf8"));
  } catch (error) {
    console.error("[moduleDrift] Error reading installed-modules.yaml:", error);
    return drifted;
  }

  for (const [moduleName, moduleEntry] of Object.entries(
    installed?.modules || {},
  )) {
    for (const containerName of moduleEntry.installed_containers || []) {
      const moduleCompose = join(
        MODULES_DIR,
        moduleName,
        containerName,
        "compose.yaml",
      );
      const rootCompose = join(CONTAINERS_DIR, containerName, "compose.yaml");
      if (
        !(await fileExists(moduleCompose)) ||
        !(await fileExists(rootCompose))
      )
        continue;
      try {
        const [moduleText, rootText] = await Promise.all([
          readFile(moduleCompose, "utf8"),
          readFile(rootCompose, "utf8"),
        ]);
        if (moduleText !== rootText) drifted.add(containerName);
      } catch (error) {
        console.error(`[moduleDrift] Error diffing ${containerName}:`, error);
      }
    }
  }

  return drifted;
}

export { getDriftedContainers };
