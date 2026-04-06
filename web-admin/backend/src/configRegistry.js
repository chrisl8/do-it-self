import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const CONTAINERS_DIR = join(homedir(), "containers");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");

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
    return { shared: {}, containers: {} };
  }
  const content = await readFile(USER_CONFIG_PATH, "utf8");
  return parseYaml(content) || { shared: {}, containers: {} };
}

export async function saveUserConfig(config) {
  const content = stringifyYaml(config, { lineWidth: 0 });
  await writeFile(USER_CONFIG_PATH, content, "utf8");
}

function resolveSharedVarDefault(defaultVal, resolvedShared) {
  if (!defaultVal || typeof defaultVal !== "string") return defaultVal;
  return defaultVal.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return resolvedShared[varName] || "";
  });
}

function resolveHomePath(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveSharedValues(registry, userConfig) {
  const sharedDefs = registry.shared_variables || {};
  const sharedValues = userConfig?.shared || {};
  const resolved = {};

  for (const [name, def] of Object.entries(sharedDefs)) {
    let value = sharedValues[name];
    if (!value && def && def.default) {
      value = resolveSharedVarDefault(def.default, resolved);
    }
    if (value) {
      value = resolveHomePath(value);
    }
    resolved[name] = value || "";
  }

  return resolved;
}

export function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [], warnings: [] };

  const errors = [];
  const warnings = [];
  const env = {};
  const resolvedShared = resolveSharedValues(registry, userConfig);

  // Add shared path variables
  for (const name of [
    "DATA_ROOT",
    "MEDIA_ROOT",
    "CACHE_ROOT",
    "MONITOR_ROOT",
  ]) {
    if (resolvedShared[name]) {
      env[name] = resolvedShared[name];
    }
  }

  // Add DOCKER_GID if needed
  if (containerDef.uses_docker_gid && resolvedShared.DOCKER_GID) {
    env.DOCKER_GID = resolvedShared.DOCKER_GID;
  }

  // Add Tailscale vars if needed
  if (containerDef.uses_tailscale) {
    if (resolvedShared.TS_AUTHKEY) {
      env.TS_AUTHKEY = resolvedShared.TS_AUTHKEY;
    } else {
      errors.push("TS_AUTHKEY (shared variable)");
    }
    if (resolvedShared.TS_DOMAIN) {
      env.TS_DOMAIN = resolvedShared.TS_DOMAIN;
    } else {
      errors.push("TS_DOMAIN (shared variable)");
    }
  }

  // Add HOST_NAME if available
  if (resolvedShared.HOST_NAME) {
    env.HOST_NAME = resolvedShared.HOST_NAME;
  }

  // Add container-specific variables
  const containerVarDefs = containerDef.variables || {};
  const containerValues =
    userConfig?.containers?.[containerName]?.variables || {};

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
  const { env, errors } = buildEnvForContainer(
    registry,
    userConfig,
    containerName,
  );

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

    const { env, errors } = buildEnvForContainer(
      registry,
      userConfig,
      name,
    );

    const containerDir = join(CONTAINERS_DIR, name);
    if (await fileExists(join(containerDir, "compose.yaml"))) {
      const envPath = join(containerDir, ".env");
      const content = formatEnvFile(env);
      await writeFile(envPath, content, "utf8");
      results[name] = { written: Object.keys(env).length, missing: errors };
    }
  }

  return results;
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

  return { containers };
}

export function maskSecrets(registry, userConfig) {
  const masked = JSON.parse(JSON.stringify(userConfig));
  const sharedDefs = registry.shared_variables || {};

  // Mask shared secrets
  if (masked.shared) {
    for (const [name, def] of Object.entries(sharedDefs)) {
      if (def && def.type === "secret" && masked.shared[name]) {
        masked.shared[name] = "••••••••";
      }
    }
  }

  // Mask container-specific secrets
  if (masked.containers) {
    for (const [containerName, containerConfig] of Object.entries(
      masked.containers,
    )) {
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
