#!/usr/bin/env node

// Generates a .env file for a container by merging:
// - shared variables from user-config.yaml
// - container-specific variables from user-config.yaml
// - defaults from container-registry.yaml
//
// Usage: node generate-env.js <container-name> [--all] [--validate-only] [--quiet]
//   <container-name>  Generate .env for a single container
//   --all             Generate .env for all enabled containers
//   --validate-only   Check config completeness without writing files
//   --quiet           Suppress output (exit code only)

import { readFile, writeFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");

// Minimal YAML parser for the flat structures we use.
// Handles our specific registry and config format without external dependencies.
function parseYaml(text) {
  const result = {};
  const lines = text.split("\n");
  const stack = [{ indent: -1, obj: result }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    // Array item
    if (content.startsWith("- ")) {
      const val = content.slice(2).trim();
      if (!Array.isArray(parent)) {
        // Find the key that should hold this array
        const keys = Object.keys(parent);
        const lastKey = keys[keys.length - 1];
        if (lastKey && parent[lastKey] === null) {
          parent[lastKey] = [val];
          stack.push({ indent, obj: parent[lastKey] });
        }
      } else {
        parent.push(val);
      }
      continue;
    }

    // Key-value pair
    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    let value = content.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value === "" || value === null) {
      // Nested object or array follows
      parent[key] = null;
      // Peek ahead to see if next non-empty line is an array
      let nextContent = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].trim().startsWith("#")) {
          nextContent = lines[j].trim();
          break;
        }
      }
      if (nextContent.startsWith("- ")) {
        parent[key] = [];
        stack.push({ indent, obj: parent[key] });
      } else {
        parent[key] = {};
        stack.push({ indent, obj: parent[key] });
      }
    } else {
      // Convert booleans
      if (value === "true") value = true;
      else if (value === "false") value = false;
      parent[key] = value;
    }
  }

  return result;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadRegistry() {
  const content = await readFile(REGISTRY_PATH, "utf8");
  return parseYaml(content);
}

async function loadUserConfig() {
  if (!(await fileExists(USER_CONFIG_PATH))) return null;
  const content = await readFile(USER_CONFIG_PATH, "utf8");
  return parseYaml(content);
}

function resolveSharedVarDefault(defaultVal, sharedValues) {
  if (!defaultVal || typeof defaultVal !== "string") return defaultVal;
  return defaultVal.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return sharedValues[varName] || "";
  });
}

function resolveHomePath(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [], warnings: [] };

  const errors = [];
  const warnings = [];
  const env = {};
  const sharedDefs = registry.shared_variables || {};
  const sharedValues = userConfig?.shared || {};

  // Resolve shared variable values with defaults
  const resolvedShared = {};
  for (const [name, def] of Object.entries(sharedDefs)) {
    let value = sharedValues[name];
    if (!value && def.default) {
      value = resolveSharedVarDefault(def.default, resolvedShared);
    }
    if (value) {
      value = resolveHomePath(value);
    }
    resolvedShared[name] = value || "";
  }

  // Add shared path variables to env
  for (const name of ["DATA_ROOT", "MEDIA_ROOT", "CACHE_ROOT", "MONITOR_ROOT"]) {
    if (resolvedShared[name]) {
      env[name] = resolvedShared[name];
    }
  }

  // Add DOCKER_GID if container uses it
  if (containerDef.uses_docker_gid && resolvedShared.DOCKER_GID) {
    env.DOCKER_GID = resolvedShared.DOCKER_GID;
  }

  // Add Tailscale vars if container uses them
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

  // Add HOST_NAME if used
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
    } else if (def.required) {
      errors.push(name);
    } else if (def.default) {
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
    // Quote values that contain spaces or special characters
    if (/[\s#"'\\$]/.test(value)) {
      content += `${key}="${value.replace(/"/g, '\\"')}"\n`;
    } else {
      content += `${key}=${value}\n`;
    }
  }

  return content;
}

async function generateForContainer(
  registry,
  userConfig,
  containerName,
  { validateOnly = false, quiet = false } = {},
) {
  const { env, errors } = buildEnvForContainer(
    registry,
    userConfig,
    containerName,
  );

  if (errors.length > 0) {
    if (!quiet) {
      console.error(`${containerName}: missing required variables:`);
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
    }
    if (validateOnly) return { valid: false, missing: errors };
    // Still write what we have, but return failure
  }

  if (!validateOnly) {
    const envPath = join(CONTAINERS_DIR, containerName, ".env");
    const content = formatEnvFile(env);
    await writeFile(envPath, content, "utf8");
    if (!quiet) {
      console.log(`${containerName}: wrote .env (${Object.keys(env).length} variables)`);
    }
  }

  return { valid: errors.length === 0, missing: errors };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));

  const validateOnly = flags.has("--validate-only");
  const quiet = flags.has("--quiet");
  const all = flags.has("--all");

  if (!all && positional.length === 0) {
    console.error(
      "Usage: generate-env.js <container-name> [--all] [--validate-only] [--quiet]",
    );
    process.exit(1);
  }

  const registry = await loadRegistry();
  const userConfig = await loadUserConfig();

  if (!userConfig) {
    if (!quiet) {
      console.error(
        "No user-config.yaml found. Run the setup script or create one manually.",
      );
    }
    process.exit(1);
  }

  let hasErrors = false;

  if (all) {
    // Generate for all enabled containers
    for (const [name, def] of Object.entries(registry.containers || {})) {
      const containerConfig = userConfig.containers?.[name];
      const isEnabled = containerConfig?.enabled !== false;
      // Skip disabled containers unless they're explicitly in user config as enabled
      if (!isEnabled) continue;

      const result = await generateForContainer(registry, userConfig, name, {
        validateOnly,
        quiet,
      });
      if (!result.valid) hasErrors = true;
    }
  } else {
    const containerName = positional[0];
    const result = await generateForContainer(
      registry,
      userConfig,
      containerName,
      { validateOnly, quiet },
    );
    if (!result.valid) hasErrors = true;
  }

  if (hasErrors) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
