// Shared helper for resolving a container's "source" (which module installed it)
// from installed-modules.yaml. Replaces the previous container-registry.yaml
// `source:` field, which was dropped because it conflated upstream catalog data
// with per-host install state.

export const PLATFORM_CONTAINERS = new Set(["web-admin"]);

// Given a container name and the parsed installed-modules.yaml, return:
//   - module name (string) if installed from a module
//   - "personal" if listed in personal_containers
//   - "platform" if in PLATFORM_CONTAINERS
//   - null if not installed on this host
export function getContainerSource(containerName, installed) {
  if (PLATFORM_CONTAINERS.has(containerName)) return "platform";
  for (const [modName, entry] of Object.entries(installed?.modules || {})) {
    if ((entry?.installed_containers || []).includes(containerName)) return modName;
  }
  if ((installed?.personal_containers || []).includes(containerName)) return "personal";
  return null;
}

// Returns the set of container names that are installed on this host.
export function installedContainerSet(installed) {
  const set = new Set(PLATFORM_CONTAINERS);
  for (const entry of Object.values(installed?.modules || {})) {
    for (const c of entry?.installed_containers || []) set.add(c);
  }
  for (const c of installed?.personal_containers || []) set.add(c);
  return set;
}
