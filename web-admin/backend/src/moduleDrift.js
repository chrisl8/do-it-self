import { readFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { getUserConfig } from "./configRegistry.js";

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
//
// A container gated by an unpinned `generation` (see module-helper.js's
// `update()`/`checkDrift()`) is EXPECTED to differ from its module source
// until the owner does the manual migration -- `module.sh update`
// deliberately skips re-rendering it. Without this check, that expected
// divergence lit the same "Module Drift" chip as an accidental edit that's
// actually about to be clobbered, which is a different, more urgent
// situation. Excluded here rather than merged into `drifted` so the two
// don't get conflated on the dashboard.
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

  let userConfig;
  try {
    userConfig = await getUserConfig();
  } catch (error) {
    console.error("[moduleDrift] Error reading user-config.yaml:", error);
    userConfig = { containers: {} };
  }

  for (const [moduleName, moduleEntry] of Object.entries(
    installed?.modules || {},
  )) {
    const moduleYamlPath = join(MODULES_DIR, moduleName, "module.yaml");
    let moduleYaml = null;
    if (await fileExists(moduleYamlPath)) {
      try {
        moduleYaml = parseYaml(await readFile(moduleYamlPath, "utf8"));
      } catch (error) {
        console.error(
          `[moduleDrift] Error reading module.yaml for ${moduleName}:`,
          error,
        );
      }
    }

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
        if (moduleText === rootText) continue;

        const currentGeneration =
          moduleYaml?.containers?.[containerName]?.generation;
        const pinnedGeneration =
          userConfig?.containers?.[containerName]?.pinned_generation;
        if (currentGeneration && pinnedGeneration !== currentGeneration) {
          continue; // expected divergence, not drift
        }

        drifted.add(containerName);
      } catch (error) {
        console.error(`[moduleDrift] Error diffing ${containerName}:`, error);
      }
    }
  }

  return drifted;
}

export { getDriftedContainers };
