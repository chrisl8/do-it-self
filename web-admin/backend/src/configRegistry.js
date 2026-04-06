import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const CONTAINERS_DIR = join(homedir(), "containers");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");

const DEFAULT_MOUNT_PATH = join(homedir(), "container-data");

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getRegistry() {
  const content = await readFile(REGISTRY_PATH, "utf8");
  return parseYaml(content);
}

export async function getUserConfig() {
  if (!(await fileExists(USER_CONFIG_PATH))) {
    return { mounts: [{ path: DEFAULT_MOUNT_PATH, label: "Default" }], shared: {}, containers: {} };
  }
  const content = await readFile(USER_CONFIG_PATH, "utf8");
  const config = parseYaml(content) || {};
  if (!config.mounts || config.mounts.length === 0) {
    config.mounts = [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  }
  if (!config.shared) config.shared = {};
  if (!config.containers) config.containers = {};
  return config;
}

export async function saveUserConfig(config) {
  const content = stringifyYaml(config, { lineWidth: 0 });
  await writeFile(USER_CONFIG_PATH, content, "utf8");
}

function resolveHomePath(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function getMountPath(mounts, index) {
  const mount = mounts[index] || mounts[0];
  return mount ? resolveHomePath(mount.path) : DEFAULT_MOUNT_PATH;
}

export function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [], warnings: [] };

  const errors = [];
  const warnings = [];
  const env = {};
  const mounts = userConfig.mounts || [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  const sharedDefs = registry.shared_variables || {};
  const sharedValues = userConfig.shared || {};
  const containerConfig = userConfig.containers?.[containerName] || {};
  const volumeMounts = containerConfig.volume_mounts || {};

  // Add DOCKER_GID if needed
  if (containerDef.uses_docker_gid) {
    env.DOCKER_GID = sharedValues.DOCKER_GID || sharedDefs.DOCKER_GID?.default || "985";
  }

  // Add Tailscale vars if needed
  if (containerDef.uses_tailscale) {
    if (sharedValues.TS_AUTHKEY) {
      env.TS_AUTHKEY = sharedValues.TS_AUTHKEY;
    } else {
      errors.push("TS_AUTHKEY (shared variable)");
    }
    if (sharedValues.TS_DOMAIN) {
      env.TS_DOMAIN = sharedValues.TS_DOMAIN;
    } else {
      errors.push("TS_DOMAIN (shared variable)");
    }
  }

  // Add HOST_NAME if available
  if (sharedValues.HOST_NAME) {
    env.HOST_NAME = sharedValues.HOST_NAME;
  }

  // Add per-volume mount paths
  const volumes = containerDef.volumes || {};
  for (const [volName, volDef] of Object.entries(volumes)) {
    const mountIndex = volumeMounts[volName] ?? 0;
    env[volDef.var] = getMountPath(mounts, mountIndex);
  }

  // Add container-specific variables
  const containerVarDefs = containerDef.variables || {};
  const containerValues = containerConfig.variables || {};
  for (const [name, def] of Object.entries(containerVarDefs)) {
    const value = containerValues[name];
    if (value !== undefined && value !== null && value !== "") {
      env[name] = String(value);
    } else if (def && def.required) {
      errors.push(name);
    } else if (def && def.default) {
      env[name] = String(def.default);
    }
  }

  return { env, errors, warnings };
}

function formatEnvFile(env) {
  let content = "# Auto-generated from container-registry + user-config.\n";
  content += `# Generated: ${new Date().toISOString()}\n`;
  content += "# Do not edit manually — changes will be overwritten.\n\n";

  for (const [key, value] of Object.entries(env)) {
    if (/[\s#"'\\$]/.test(value)) {
      content += `${key}="${value.replace(/"/g, '\\"')}"\n`;
    } else {
      content += `${key}=${value}\n`;
    }
  }

  return content;
}

export async function writeContainerEnv(containerName) {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  const { env, errors } = buildEnvForContainer(registry, userConfig, containerName);

  const envPath = join(CONTAINERS_DIR, containerName, ".env");
  const content = formatEnvFile(env);
  await writeFile(envPath, content, "utf8");

  return { written: Object.keys(env).length, missing: errors };
}

export async function writeAllContainerEnvs() {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  const results = {};

  for (const name of Object.keys(registry.containers || {})) {
    const containerConfig = userConfig.containers?.[name];
    if (containerConfig?.enabled === false) continue;

    const containerDir = join(CONTAINERS_DIR, name);
    if (!(await fileExists(join(containerDir, "compose.yaml")))) continue;

    const { env, errors } = buildEnvForContainer(registry, userConfig, name);
    const envPath = join(containerDir, ".env");
    const content = formatEnvFile(env);
    await writeFile(envPath, content, "utf8");
    results[name] = { written: Object.keys(env).length, missing: errors };
  }

  // Regenerate homepage/beszel compose monitoring mounts
  await regenerateMonitoringMounts(registry, userConfig);

  return results;
}

export async function regenerateMonitoringMounts(registry, userConfig) {
  const mounts = userConfig.mounts || [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];

  for (const [name, def] of Object.entries(registry.containers || {})) {
    if (!def.monitor_all_mounts) continue;

    const composePath = join(CONTAINERS_DIR, name, "compose.yaml");
    if (!(await fileExists(composePath))) continue;

    const content = await readFile(composePath, "utf8");

    // Generate monitoring mount lines based on container type
    let monitorLines;
    if (name === "homepage") {
      monitorLines = mounts.map((m, i) => {
        const p = resolveHomePath(m.path);
        const label = m.label || `mount_${i}`;
        return `      - ${p}/for-homepage:/mnt/${label}`;
      });
    } else if (name === "beszel") {
      monitorLines = mounts.map((m, i) => {
        const p = resolveHomePath(m.path);
        const label = m.label || `mount_${i}`;
        return `      - ${p}/for-homepage:/extra-filesystems/${label}:ro`;
      });
    } else {
      continue;
    }

    // Replace the monitoring mount section
    // Look for lines containing "for-homepage" and replace them
    const lines = content.split("\n");
    const newLines = [];
    let skipMonitoring = false;
    let insertedMonitoring = false;

    for (const line of lines) {
      if (line.includes("for-homepage")) {
        if (!insertedMonitoring) {
          // Insert all new monitoring lines at the position of the first old one
          newLines.push("      # Auto-generated monitoring mounts (one per storage mount)");
          newLines.push(...monitorLines);
          insertedMonitoring = true;
        }
        skipMonitoring = true;
        continue;
      }
      skipMonitoring = false;
      newLines.push(line);
    }

    const newContent = newLines.join("\n");
    if (newContent !== content) {
      await writeFile(composePath, newContent, "utf8");
    }
  }
}

export function validateContainer(registry, userConfig, containerName) {
  const { errors } = buildEnvForContainer(registry, userConfig, containerName);
  return { ready: errors.length === 0, missing: errors };
}

export async function getConfigStatus() {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  const containers = {};

  for (const [name, def] of Object.entries(registry.containers || {})) {
    const containerConfig = userConfig.containers?.[name];
    const enabled = containerConfig?.enabled !== false;
    const { errors } = buildEnvForContainer(registry, userConfig, name);

    containers[name] = {
      ready: errors.length === 0,
      missing: errors,
      enabled,
      category: def.category,
      description: def.description,
    };
  }

  return { containers, mounts: userConfig.mounts };
}

export function maskSecrets(registry, userConfig) {
  const masked = JSON.parse(JSON.stringify(userConfig));
  const sharedDefs = registry.shared_variables || {};

  if (masked.shared) {
    for (const [name, def] of Object.entries(sharedDefs)) {
      if (def && def.type === "secret" && masked.shared[name]) {
        masked.shared[name] = "••••••••";
      }
    }
  }

  if (masked.containers) {
    for (const [containerName, containerConfig] of Object.entries(masked.containers)) {
      const containerDef = registry.containers?.[containerName];
      if (!containerDef?.variables || !containerConfig?.variables) continue;
      for (const [varName, def] of Object.entries(containerDef.variables)) {
        if (def && def.type === "secret" && containerConfig.variables[varName]) {
          containerConfig.variables[varName] = "••••••••";
        }
      }
    }
  }

  return masked;
}

export function resolveSharedValues(registry, userConfig) {
  // Kept for backward compat -- returns shared values
  return userConfig?.shared || {};
}
