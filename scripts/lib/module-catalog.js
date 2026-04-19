// Shared helper for reconciling .modules/ with the platform's module-catalog.yaml.
// Used by both scripts/update-platform.js (post-pull reconciliation) and any
// unified update wrapper. Pure-ish: does IO (git, fs) but returns a structured
// report the caller renders however it likes.
//
// Policy (decided in the plan): only `required: true` catalog entries auto-clone.
// Optional entries, URL drift, removals, and user-added sources are reported but
// never auto-mutated.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import YAML from "yaml";

// Parse module-catalog.yaml and return `[{ name, url, required }, ...]`.
// Missing file returns []. Malformed YAML throws — caller decides severity.
export function readCatalog(catalogPath) {
  if (!existsSync(catalogPath)) return [];
  const parsed = YAML.parse(readFileSync(catalogPath, "utf8"));
  const entries = [];
  for (const [name, entry] of Object.entries(parsed?.catalogs || {})) {
    entries.push({
      name,
      url: entry?.url || "",
      required: entry?.required === true,
    });
  }
  return entries;
}

// Read installed-modules.yaml. Returns { modules: {...} } or an empty object
// if the file doesn't exist yet.
export function readInstalled(installedPath) {
  if (!existsSync(installedPath)) return { modules: {}, personal_containers: [] };
  return YAML.parse(readFileSync(installedPath, "utf8")) || { modules: {}, personal_containers: [] };
}

// Return the remote URL currently configured for a cloned module, or null.
function getLocalRemote(moduleDir) {
  try {
    return execSync(`git -C "${moduleDir}" remote get-url origin`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Given the catalog and the on-disk modules, produce a report the caller can
// print. Does not mutate the filesystem.
//
// Returns: {
//   toClone:      [{ name, url }]       — required, catalog-listed, not yet on disk
//   optional:     [{ name, url }]       — not required, not yet on disk
//   urlDrift:     [{ name, catalogUrl, localUrl }]  — same name, different remote
//   removed:      [ name, ... ]         — on disk but not in catalog (and not user-added)
//   userAdded:    [ name, ... ]         — on disk, not in catalog, but listed in installed-modules.yaml
// }
export function reconcileCatalog(catalog, modulesDir, installed) {
  const catalogByName = new Map(catalog.map((c) => [c.name, c]));
  const onDisk = new Set();
  if (existsSync(modulesDir)) {
    for (const name of readdirSync(modulesDir)) {
      const modPath = join(modulesDir, name);
      if (!statSync(modPath).isDirectory()) continue;
      onDisk.add(name);
    }
  }

  const installedNames = new Set(Object.keys(installed?.modules || {}));

  const toClone = [];
  const optional = [];
  const urlDrift = [];

  for (const entry of catalog) {
    if (onDisk.has(entry.name)) {
      const localUrl = getLocalRemote(join(modulesDir, entry.name));
      if (localUrl && entry.url && localUrl !== entry.url) {
        urlDrift.push({ name: entry.name, catalogUrl: entry.url, localUrl });
      }
      continue;
    }
    if (entry.required) toClone.push({ name: entry.name, url: entry.url });
    else optional.push({ name: entry.name, url: entry.url });
  }

  const removed = [];
  const userAdded = [];
  for (const name of onDisk) {
    if (catalogByName.has(name)) continue;
    if (installedNames.has(name)) userAdded.push(name);
    else removed.push(name);
  }

  return { toClone, optional, urlDrift, removed, userAdded };
}

// Clone the module at `url` into `modulesDir/name/`. Returns `{ ok, error }`.
// Never throws — caller decides fatality.
export function cloneModule(modulesDir, name, url) {
  try {
    execSync(`git clone "${url}" "${join(modulesDir, name)}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
