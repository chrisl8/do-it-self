#!/usr/bin/env node

// Generates .env files for containers by merging:
// - User-defined storage mounts with per-volume assignments
// - Container-specific variables
//
// Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) are
// intentionally NOT handled here. They live in Infisical at /shared and
// are injected into the shell env by all-containers.sh via `infisical
// export --path=/shared` right before `docker compose up -d`. This keeps
// Infisical as the single source of truth for shared vars.
//
// Usage: node generate-env.js <container-name> [--all] [--validate-only] [--quiet]

import { readFile, writeFile, appendFile, access, chmod } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");
const INFISICAL_CRED_PATH = join(homedir(), "credentials", "infisical.env");
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

    let wasQuoted = false;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      wasQuoted = true;
    }

    if (!wasQuoted && (value === "" || value === null)) {
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

// Per-container secrets that live in Infisical rather than user-config.yaml.
// Equivalent to the merge configRegistry.js does for the web admin and the
// runtime export scripts/all-containers.sh does right before `docker compose
// up`. Populated lazily via fetchInfisicalSecrets; empty object if Infisical
// is unavailable or has no values at /<container>.
const infisicalSecretsCache = new Map();

function loadInfisicalCreds() {
  try {
    if (!existsSync(INFISICAL_CRED_PATH)) return null;
    const raw = readFileSync(INFISICAL_CRED_PATH, "utf8");
    const creds = {};
    for (const line of raw.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      creds[key] = val;
    }
    if (!creds.INFISICAL_TOKEN || !creds.INFISICAL_PROJECT_ID || !creds.INFISICAL_API_URL) {
      return null;
    }
    return creds;
  } catch {
    return null;
  }
}

function isInfisicalRunning() {
  const r = spawnSync(
    "docker",
    ["ps", "--filter", "name=infisical", "--filter", "status=running", "-q"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return r.status === 0 && r.stdout.trim().length > 0;
}

// Parse dotenv output from `infisical export --format=dotenv`.
// Lines look like: KEY='value' (single-quoted; values may contain anything
// except unescaped single quotes, which Infisical emits as '\''). Unknown
// lines (e.g., release-notice noise if it ever leaks to stdout) are ignored.
function parseDotenv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/'\\''/g, "'");
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    out[m[1]] = value;
  }
  return out;
}

let infisicalAvailability = null;
function getInfisicalCreds() {
  if (infisicalAvailability !== null) return infisicalAvailability;
  const creds = loadInfisicalCreds();
  if (!creds) { infisicalAvailability = null; return null; }
  if (!isInfisicalRunning()) { infisicalAvailability = null; return null; }
  infisicalAvailability = creds;
  return creds;
}

function fetchInfisicalSecrets(containerName) {
  if (infisicalSecretsCache.has(containerName)) {
    return infisicalSecretsCache.get(containerName);
  }
  const creds = getInfisicalCreds();
  if (!creds) {
    infisicalSecretsCache.set(containerName, {});
    return {};
  }
  const r = spawnSync(
    "infisical",
    [
      "export",
      `--token=${creds.INFISICAL_TOKEN}`,
      `--projectId=${creds.INFISICAL_PROJECT_ID}`,
      "--env=prod",
      `--domain=${creds.INFISICAL_API_URL}`,
      `--path=/${containerName}`,
      "--format=dotenv",
      "--silent",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const secrets = r.status === 0 ? parseDotenv(r.stdout || "") : {};
  infisicalSecretsCache.set(containerName, secrets);
  return secrets;
}

// Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) are
// intentionally NOT written into per-container .env files. They live in
// Infisical at /shared and are injected into the shell env at container
// start time by scripts/all-containers.sh via `infisical export
// --path=/shared`. Docker Compose then substitutes ${VAR} references in
// compose.yaml from that shell env. This keeps Infisical as the single
// source of truth for shared vars and avoids drift between disk and the
// secret store.
//
// Per-container required variables that live in Infisical at /<container>
// are satisfied but NOT written to the .env file, for the same reason: the
// runtime export path is the single source of truth; the .env file should
// not carry copies of secrets held in Infisical.
function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [] };

  const errors = [];
  const env = {};
  const mounts = userConfig.mounts || [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  const containerConfig = userConfig.containers?.[containerName] || {};
  const volumeMounts = containerConfig.volume_mounts || {};

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
  const infisicalValues = fetchInfisicalSecrets(containerName);
  for (const [name, def] of Object.entries(containerVarDefs)) {
    const value = containerValues[name];
    if (value !== undefined && value !== null && value !== "") {
      env[name] = String(value);
    } else if (infisicalValues[name] !== undefined && infisicalValues[name] !== "") {
      // Supplied by Infisical at runtime via `infisical export
      // --path=/<container>` in scripts/all-containers.sh. Don't copy into
      // .env — the runtime export is the source of truth.
      continue;
    } else if (def && def.required) {
      errors.push(name);
    } else if (def && def.default) {
      env[name] = String(def.default);
    }
  }

  // Homepage group for dashboard organization — injected so compose.yaml
  // can use homepage.group=${HOMEPAGE_GROUP} instead of hardcoding it.
  if (containerDef.homepage_group) {
    env.HOMEPAGE_GROUP = containerDef.homepage_group;
  }

  // Tailscale state directory — keeps node identity out of the ephemeral
  // container directory by placing it on the primary mount at
  // <mount[0]>/tailscale-state/<container-name>/.
  if (containerDef.uses_tailscale) {
    const basePath = getMountPath(mounts, 0);
    env.TS_STATE_HOST_DIR = join(basePath, "tailscale-state", containerName);
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

// Infisical is a chicken-and-egg case: every other container can pull its secrets
// from Infisical at start time, but Infisical itself cannot. Its bootstrap secrets
// (AUTH_SECRET, ENCRYPTION_KEY, DB_PASSWORD) live in infisical/infisical-secrets.env
// and must be appended to .env after generation, or Infisical will refuse to boot.
async function appendInfisicalBootstrapSecrets(envPath, containerName) {
  if (containerName !== "infisical") return;
  const secretsPath = join(CONTAINERS_DIR, "infisical", "infisical-secrets.env");
  if (!(await fileExists(secretsPath))) return;
  const raw = await readFile(secretsPath, "utf8");
  const lines = raw
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (lines.length === 0) return;
  await appendFile(envPath, `\n# Infisical internal secrets\n${lines.join("\n")}\n`, "utf8");
  await chmod(envPath, 0o600);
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
    await writeFile(envPath, formatEnvFile(env), { encoding: "utf8", mode: 0o600 });
    await appendInfisicalBootstrapSecrets(envPath, containerName);
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
      // Skip containers whose compose.yaml has been deleted but whose
      // user-config or registry entry still lingers — matches the
      // web admin's writeAllContainerEnvs behavior in
      // web-admin/backend/src/configRegistry.js:166. Without this check
      // a stale entry crashes the whole --all run.
      if (!(await fileExists(join(CONTAINERS_DIR, name, "compose.yaml")))) continue;
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
