#!/usr/bin/env node

// Generates .env files for containers by merging:
// - User-defined storage mounts with per-volume assignments
// - Shared variables (TS_AUTHKEY, TS_DOMAIN, etc.)
// - Container-specific variables
//
// Usage: node generate-env.js <container-name> [--all] [--validate-only] [--quiet]

import { readFile, writeFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");
const DEFAULT_MOUNT_PATH = join(homedir(), "container-data");

// Minimal YAML parser for our specific format
function parseYaml(text) {
  const result = {};
  const lines = text.split("\n");
  const stack = [{ indent: -1, obj: result }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (content.startsWith("- ")) {
      const val = content.slice(2).trim();
      // Remove quotes
      const unquoted = val.replace(/^["']|["']$/g, "");
      if (Array.isArray(parent)) {
        // Check if this is a map item (has colon)
        if (val.includes(": ")) {
          const obj = {};
          const pairs = val.match(/(\w+):\s*"?([^",]*)"?/g) || [];
          for (const pair of pairs) {
            const [k, ...v] = pair.split(": ");
            obj[k.trim()] = v.join(": ").trim().replace(/^["']|["']$/g, "");
          }
          parent.push(obj);
        } else {
          parent.push(unquoted);
        }
      } else {
        const keys = Object.keys(parent);
        const lastKey = keys[keys.length - 1];
        if (lastKey && parent[lastKey] === null) {
          parent[lastKey] = [unquoted];
          stack.push({ indent, obj: parent[lastKey] });
        }
      }
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    let value = content.slice(colonIdx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value === "" || value === null) {
      parent[key] = null;
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
      if (value === "true") value = true;
      else if (value === "false") value = false;
      parent[key] = value;
    }
  }

  return result;
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function loadRegistry() {
  return parseYaml(await readFile(REGISTRY_PATH, "utf8"));
}

async function loadUserConfig() {
  if (!(await fileExists(USER_CONFIG_PATH))) return null;
  const config = parseYaml(await readFile(USER_CONFIG_PATH, "utf8"));
  if (!config.mounts || config.mounts.length === 0) {
    config.mounts = [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  }
  return config;
}

function resolveHomePath(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function getMountPath(mounts, index) {
  const mount = mounts[index] || mounts[0];
  return mount ? resolveHomePath(mount.path || DEFAULT_MOUNT_PATH) : DEFAULT_MOUNT_PATH;
}

function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [] };

  const errors = [];
  const env = {};
  const mounts = userConfig.mounts || [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  const sharedDefs = registry.shared_variables || {};
  const sharedValues = userConfig.shared || {};
  const containerConfig = userConfig.containers?.[containerName] || {};
  const volumeMounts = containerConfig.volume_mounts || {};

  // DOCKER_GID
  if (containerDef.uses_docker_gid) {
    env.DOCKER_GID = sharedValues.DOCKER_GID || sharedDefs.DOCKER_GID?.default || "985";
  }

  // Tailscale
  if (containerDef.uses_tailscale) {
    if (sharedValues.TS_AUTHKEY) env.TS_AUTHKEY = sharedValues.TS_AUTHKEY;
    else errors.push("TS_AUTHKEY (shared variable)");
    if (sharedValues.TS_DOMAIN) env.TS_DOMAIN = sharedValues.TS_DOMAIN;
    else errors.push("TS_DOMAIN (shared variable)");
  }

  if (sharedValues.HOST_NAME) env.HOST_NAME = sharedValues.HOST_NAME;

  // Per-volume mount paths
  const volumes = containerDef.volumes || {};
  for (const [volName, volDef] of Object.entries(volumes)) {
    if (!volDef || !volDef.var) continue;
    const mountIndex = volumeMounts[volName] ?? 0;
    env[volDef.var] = getMountPath(mounts, mountIndex);
  }

  // Container-specific variables
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

  return { env, errors };
}

function formatEnvFile(env) {
  let content = "# Auto-generated from container-registry + user-config.\n";
  content += `# Generated: ${new Date().toISOString()}\n`;
  content += "# Do not edit manually — changes will be overwritten.\n\n";
  for (const [key, rawValue] of Object.entries(env)) {
    const value = String(rawValue ?? "");
    if (/[\s#"'\\$]/.test(value)) {
      content += `${key}="${value.replace(/"/g, '\\"')}"\n`;
    } else {
      content += `${key}=${value}\n`;
    }
  }
  return content;
}

async function generateForContainer(registry, userConfig, containerName, opts = {}) {
  const { validateOnly = false, quiet = false } = opts;
  const { env, errors } = buildEnvForContainer(registry, userConfig, containerName);

  if (errors.length > 0 && !quiet) {
    console.error(`${containerName}: missing required variables:`);
    for (const err of errors) console.error(`  - ${err}`);
  }

  if (!validateOnly) {
    const envPath = join(CONTAINERS_DIR, containerName, ".env");
    await writeFile(envPath, formatEnvFile(env), "utf8");
    if (!quiet) console.log(`${containerName}: wrote .env (${Object.keys(env).length} variables)`);
  }

  return { valid: errors.length === 0, missing: errors };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const positional = args.filter(a => !a.startsWith("--"));
  const validateOnly = flags.has("--validate-only");
  const quiet = flags.has("--quiet");
  const all = flags.has("--all");

  if (!all && positional.length === 0) {
    console.error("Usage: generate-env.js <container-name> [--all] [--validate-only] [--quiet]");
    process.exit(1);
  }

  const registry = await loadRegistry();
  const userConfig = await loadUserConfig();
  if (!userConfig) {
    if (!quiet) console.error("No user-config.yaml found.");
    process.exit(1);
  }

  let hasErrors = false;

  if (all) {
    for (const [name, def] of Object.entries(registry.containers || {})) {
      const cc = userConfig.containers?.[name];
      // Respect user config if set, otherwise check registry default_disabled
      const enabled = cc?.enabled !== undefined ? cc.enabled : !def.default_disabled;
      if (!enabled) continue;
      const r = await generateForContainer(registry, userConfig, name, { validateOnly, quiet });
      if (!r.valid) hasErrors = true;
    }
  } else {
    const r = await generateForContainer(registry, userConfig, positional[0], { validateOnly, quiet });
    if (!r.valid) hasErrors = true;
  }

  if (hasErrors) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
