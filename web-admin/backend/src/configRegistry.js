import { readFile, writeFile, appendFile, access, mkdir, rename } from "fs/promises";
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
    return { mounts: [{ path: DEFAULT_MOUNT_PATH, label: "Default" }], containers: {} };
  }
  const content = await readFile(USER_CONFIG_PATH, "utf8");
  const config = parseYaml(content) || {};
  if (!config.mounts || config.mounts.length === 0) {
    config.mounts = [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  }
  if (!config.containers) config.containers = {};
  // NOTE: `shared` is intentionally NOT initialized here. Shared variables
  // (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) live in Infisical at
  // /shared only. Endpoints that need them merge from Infisical on demand
  // (see validateContainer / getConfigStatus / GET /api/config/raw).
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

function isContainerEnabled(containerDef, containerConfig) {
  // User config takes precedence if explicitly set
  if (containerConfig?.enabled !== undefined) return containerConfig.enabled;
  // Otherwise check registry default
  if (containerDef?.default_disabled) return false;
  return true;
}

// Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) are
// intentionally NOT written into per-container .env files. They live in
// Infisical at /shared and are injected into the shell env at container
// start time by scripts/all-containers.sh via `infisical export
// --path=/shared`. Docker Compose then substitutes ${VAR} references in
// compose.yaml from that shell env. This keeps Infisical as the single
// source of truth for shared vars and avoids drift between disk and the
// secret store.
export function buildEnvForContainer(registry, userConfig, containerName) {
  const containerDef = registry.containers?.[containerName];
  if (!containerDef) return { env: {}, errors: [], warnings: [] };

  const errors = [];
  const warnings = [];
  const env = {};
  const mounts = userConfig.mounts || [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];
  const containerConfig = userConfig.containers?.[containerName] || {};
  const volumeMounts = containerConfig.volume_mounts || {};

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
}

export async function writeContainerEnv(containerName) {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  const { env, errors } = buildEnvForContainer(registry, userConfig, containerName);

  const envPath = join(CONTAINERS_DIR, containerName, ".env");
  const content = formatEnvFile(env);
  await writeFile(envPath, content, "utf8");
  await appendInfisicalBootstrapSecrets(envPath, containerName);

  return { written: Object.keys(env).length, missing: errors };
}

export async function writeAllContainerEnvs() {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();
  const results = {};

  for (const name of Object.keys(registry.containers || {})) {
    const containerDef = registry.containers[name];
    if (containerDef.system_service) continue;
    const containerConfig = userConfig.containers?.[name];
    if (!isContainerEnabled(containerDef, containerConfig)) continue;

    const containerDir = join(CONTAINERS_DIR, name);
    if (!(await fileExists(join(containerDir, "compose.yaml")))) continue;

    const { env, errors } = buildEnvForContainer(registry, userConfig, name);
    const envPath = join(containerDir, ".env");
    const content = formatEnvFile(env);
    await writeFile(envPath, content, "utf8");
    await appendInfisicalBootstrapSecrets(envPath, name);
    results[name] = { written: Object.keys(env).length, missing: errors };
  }

  // Regenerate homepage/beszel compose monitoring mounts
  await regenerateMonitoringMounts(registry, userConfig);

  return results;
}

// For each container with `monitor_all_mounts: true` in the registry
// (homepage and beszel today), writes a `compose.override.yaml` alongside
// its `compose.yaml` containing one bind mount per entry in userConfig.mounts.
// Docker Compose auto-loads compose.override.yaml and appends its volumes
// to the base file's volumes list, so the committed compose.yaml stays
// generic and portable (no maintainer-specific paths).
//
// Also `mkdir -p`s each host source path so Docker doesn't auto-create them
// as root:root on first run.
//
// The override files are gitignored. This function is the sole writer of
// those files — users should never edit them directly.
export async function regenerateMonitoringMounts(registry, userConfig) {
  const mounts =
    userConfig.mounts && userConfig.mounts.length > 0
      ? userConfig.mounts
      : [{ path: DEFAULT_MOUNT_PATH, label: "Default" }];

  // Ensure each host source path exists. Without this Docker auto-creates
  // them as root:root on first run, then the container (running as
  // 1000:1000) can't read them.
  for (const m of mounts) {
    const sourcePath = join(resolveHomePath(m.path), "for-homepage");
    try {
      await mkdir(sourcePath, { recursive: true });
    } catch (err) {
      if (err.code !== "EEXIST") {
        console.warn(
          `[regenerateMonitoringMounts] Could not mkdir ${sourcePath}: ${err.message}`,
        );
      }
    }
  }

  for (const [name, def] of Object.entries(registry.containers || {})) {
    if (!def.monitor_all_mounts) continue;

    const containerDir = join(CONTAINERS_DIR, name);
    const composePath = join(containerDir, "compose.yaml");
    if (!(await fileExists(composePath))) continue;

    // Figure out which service key inside the compose file receives the
    // monitoring mounts, and what path/mode format to use. This is the
    // per-container policy — extend if more monitor_all_mounts containers
    // are added.
    let serviceKey;
    let buildEntry;
    if (name === "homepage") {
      serviceKey = "homepage";
      buildEntry = (p, label) => `${p}/for-homepage:/mnt/${label}`;
    } else if (name === "beszel") {
      // beszel's service key is `beszel-agent` (not `beszel`), since the
      // agent is the one that reads the filesystem metrics.
      serviceKey = "beszel-agent";
      buildEntry = (p, label) =>
        `${p}/for-homepage:/extra-filesystems/${label}:ro`;
    } else {
      continue;
    }

    const volumes = mounts.map((m, i) => {
      const p = resolveHomePath(m.path);
      const label = m.label || `mount_${i}`;
      return buildEntry(p, label);
    });

    // Build the override document. Keep it minimal — just the service's
    // volumes list, which Compose appends to the base file's volumes.
    const overrideDoc = {
      services: {
        [serviceKey]: {
          volumes,
        },
      },
    };

    const header =
      "# AUTO-GENERATED by scripts/regenerate-monitoring-mounts.js\n" +
      "# Do not edit. This file is rewritten every time homepage or beszel\n" +
      "# starts, based on user-config.yaml's `mounts:` list.\n\n";
    const newContent = header + stringifyYaml(overrideDoc, { lineWidth: 0 });

    const overridePath = join(containerDir, "compose.override.yaml");
    let existingContent = "";
    if (await fileExists(overridePath)) {
      existingContent = await readFile(overridePath, "utf8");
    }
    if (newContent !== existingContent) {
      await writeFile(overridePath, newContent, "utf8");
    }
  }
}

export async function validateContainer(registry, userConfig, containerName) {
  // LOAD-BEARING: Merge Infisical /shared into userConfig.shared so the
  // TS_AUTHKEY check below sees what's actually in Infisical. After the
  // shared-vars consolidation, Infisical is the *only* store for shared
  // variables -- user-config.yaml no longer has a `shared:` block -- so
  // this merge is the only path the validation code can learn about
  // shared variable values. Do not remove.
  try {
    const { isAvailable, listSecrets } = await import("./infisicalClient.js");
    if (await isAvailable()) {
      const sharedSecrets = await listSecrets("/shared").catch(() => []);
      for (const s of sharedSecrets) {
        if (!userConfig.shared) userConfig.shared = {};
        userConfig.shared[s.key] = s.value;
      }
    }
  } catch {
    // Infisical not available -- TS_AUTHKEY check below will flag it as missing
  }

  const { errors } = buildEnvForContainer(registry, userConfig, containerName);

  const containerDef = registry.containers?.[containerName];
  if (containerDef?.uses_tailscale && !userConfig.shared?.TS_AUTHKEY) {
    errors.push("TS_AUTHKEY (Infisical)");
  }

  return { ready: errors.length === 0, missing: errors };
}

export async function generateMissingSecrets(containerName) {
  const { randomBytes } = await import("crypto");
  const { isAvailable, getSecret, setSecret, createFolder } =
    await import("./infisicalClient.js");

  if (!(await isAvailable())) return { generated: 0 };

  const registry = await getRegistry();
  const containerDef = registry.containers?.[containerName];
  if (!containerDef?.variables) return { generated: 0 };

  await createFolder(containerName, "/");

  let generated = 0;
  for (const [varName, varDef] of Object.entries(containerDef.variables)) {
    if (!varDef.auto_generate) continue;

    // Check if it already has a value in Infisical
    const existing = await getSecret(varName, `/${containerName}`);
    if (existing) continue;

    // Generate a random 32-char hex string
    const value = randomBytes(16).toString("hex");
    await setSecret(varName, value, `/${containerName}`);
    generated++;
  }

  return { generated };
}

export async function getConfigStatus() {
  const registry = await getRegistry();
  const userConfig = await getUserConfig();

  // LOAD-BEARING: Merge Infisical secrets so validation accounts for them.
  // After the shared-vars consolidation, Infisical is the *only* store for
  // shared variables -- user-config.yaml no longer has a `shared:` block --
  // so this /shared merge is the only path the TS_AUTHKEY check below can
  // learn about shared variable values. The /<container> merges that follow
  // are the equivalent path for per-container secrets. Do not remove.
  let infisicalMerged = false;
  try {
    const { isAvailable, listSecrets } = await import("./infisicalClient.js");
    if (await isAvailable()) {
      const sharedSecrets = await listSecrets("/shared").catch(() => []);
      for (const s of sharedSecrets) {
        if (!userConfig.shared) userConfig.shared = {};
        userConfig.shared[s.key] = s.value;
      }
      for (const name of Object.keys(registry.containers || {})) {
        const containerSecrets = await listSecrets(`/${name}`).catch(() => []);
        if (containerSecrets.length > 0) {
          if (!userConfig.containers) userConfig.containers = {};
          if (!userConfig.containers[name]) userConfig.containers[name] = {};
          if (!userConfig.containers[name].variables) userConfig.containers[name].variables = {};
          for (const s of containerSecrets) {
            userConfig.containers[name].variables[s.key] = s.value;
          }
        }
      }
      infisicalMerged = true;
    }
  } catch {
    // Infisical not available, validate with what we have
  }

  const containers = {};

  for (const [name, def] of Object.entries(registry.containers || {})) {
    const containerConfig = userConfig.containers?.[name];
    const enabled = def.system_service ? true : isContainerEnabled(def, containerConfig);
    const { errors } = buildEnvForContainer(registry, userConfig, name);

    if (def.uses_tailscale && !userConfig.shared?.TS_AUTHKEY) {
      errors.push("TS_AUTHKEY (Infisical)");
    }

    containers[name] = {
      ready: errors.length === 0,
      missing: errors,
      enabled,
      homepage_group: def.homepage_group,
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

// ─── Borg backup configuration ─────────────────────────────────────
//
// scripts/borg-backup.conf is a generated artifact, parallel to the per-
// container .env files. The source of truth is user-config.yaml:borg,
// with secrets (BORG_PASSPHRASE, BORG_REMOTE_PASSPHRASE) separately in
// Infisical at /borgbackup. Users edit the borg block through the web
// admin's Backups page; writeBorgConf() re-emits the .conf on save.
//
// BORG_CONTAINER_MOUNT_DIRS is always derived from userConfig.mounts —
// it's a lookup index for SQLite database discovery in borg-db-dump.sh,
// so it has no business being user-tunable (a stale entry there silently
// breaks DB dumps).

const BORG_CONF_PATH = join(CONTAINERS_DIR, "scripts", "borg-backup.conf");

const BORG_DEFAULTS = {
  compression: "lz4",
  remote_compression: "zstd,3",
  remote_ratelimit_kbps: 0,
  retention: {
    local: { daily: 7, weekly: 4, monthly: 6, yearly: 2 },
    remote: { daily: 3, weekly: 4, monthly: 12, yearly: 5 },
  },
  restore_test_sample_path: "etc/hostname",
  rsh: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
};

function autoSeededBackupPaths(mounts, dumpDir) {
  const paths = [];
  for (const m of mounts) {
    const p = resolveHomePath(m.path);
    paths.push({ path: `${p}/container-mounts/`, enabled: true });
  }
  if (dumpDir) {
    paths.push({ path: `${dumpDir.replace(/\/?$/, "/")}`, enabled: true });
  }
  paths.push({ path: `${homedir()}/`, enabled: true });
  paths.push({ path: "/etc/", enabled: true });
  return paths;
}

// Computes the default dump directory from a repo path — same mount,
// sibling directory. So /mnt/22TB/borg-repo -> /mnt/22TB/borg-db-dumps.
function defaultDumpDirFor(repoPath) {
  if (!repoPath) return "";
  const parent = repoPath.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return `${parent}/borg-db-dumps`;
}

export function getBorgConfig(userConfig) {
  const borg = userConfig?.borg || {};
  const mounts = userConfig?.mounts || [];
  const repoPath = borg.repo_path || "";
  const dumpDir = borg.dump_dir || (repoPath ? defaultDumpDirFor(repoPath) : "");
  const backupPaths = Array.isArray(borg.backup_paths) && borg.backup_paths.length > 0
    ? borg.backup_paths
    : autoSeededBackupPaths(mounts, dumpDir);
  return {
    repo_path: repoPath,
    dump_dir: dumpDir,
    backup_paths: backupPaths,
    remote_repo: borg.remote_repo || "",
    remote_ratelimit_kbps: borg.remote_ratelimit_kbps ?? BORG_DEFAULTS.remote_ratelimit_kbps,
    compression: borg.compression || BORG_DEFAULTS.compression,
    remote_compression: borg.remote_compression || BORG_DEFAULTS.remote_compression,
    retention: {
      local: { ...BORG_DEFAULTS.retention.local, ...(borg.retention?.local || {}) },
      remote: { ...BORG_DEFAULTS.retention.remote, ...(borg.retention?.remote || {}) },
    },
    restore_test_sample_path: borg.restore_test_sample_path || BORG_DEFAULTS.restore_test_sample_path,
    rsh: borg.rsh || BORG_DEFAULTS.rsh,
  };
}

// Returns mount paths that have no enabled backup_path starting with them.
// Used by the UI to flag "this mount is not in the backup" so a user can't
// accidentally leave a whole drive out.
export function mountsNotInBackup(userConfig) {
  const cfg = getBorgConfig(userConfig);
  const enabled = (cfg.backup_paths || [])
    .filter((p) => p.enabled)
    .map((p) => resolveHomePath(p.path));
  const uncovered = [];
  for (const m of userConfig?.mounts || []) {
    const mp = resolveHomePath(m.path).replace(/\/+$/, "");
    const hit = enabled.some((ep) => ep.startsWith(mp + "/") || ep === mp || ep === mp + "/");
    if (!hit) uncovered.push(m.path);
  }
  return uncovered;
}

function formatBorgBashLine(key, value) {
  // Wrap in double quotes unless it's a bare number. Escape embedded
  // double quotes. Values that reference shell variables like ${HOME}
  // must not be escaped — our callers never emit untrusted user data
  // into those specific slots.
  if (typeof value === "number") return `${key}=${value}`;
  const escaped = String(value).replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

function formatBorgArray(key, values) {
  if (!values || values.length === 0) return `${key}=()`;
  const quoted = values.map((v) => `    "${String(v).replace(/"/g, '\\"')}"`);
  return `${key}=(\n${quoted.join("\n")}\n)`;
}

export function renderBorgConf(userConfig) {
  const cfg = getBorgConfig(userConfig);
  const mounts = userConfig?.mounts || [];
  const enabledPaths = (cfg.backup_paths || [])
    .filter((p) => p.enabled && p.path)
    .map((p) => p.path);
  const containerMountDirs = mounts.map((m) =>
    `${resolveHomePath(m.path).replace(/\/+$/, "")}/container-mounts`,
  );

  const lines = [
    "# AUTO-GENERATED by web-admin from user-config.yaml:borg",
    "# Do not edit manually — changes will be overwritten on next save.",
    `# Generated: ${new Date().toISOString()}`,
    "",
    "# ── Local repository ────────────────────────────────────────────",
    formatBorgBashLine("BORG_REPO", cfg.repo_path),
    formatBorgBashLine("BORG_COMPRESSION", cfg.compression),
    formatBorgBashLine("BORG_REMOTE_COMPRESSION", cfg.remote_compression),
    "",
    "# ── Database dumps ──────────────────────────────────────────────",
    formatBorgBashLine("BORG_DB_DUMP_DIR", cfg.dump_dir),
    "",
    "# ── Exclusion patterns ──────────────────────────────────────────",
    'BORG_EXCLUDE_FILE="${HOME}/containers/borgbackup/exclude-patterns.txt"',
    "",
    "# ── Status & logging ───────────────────────────────────────────",
    'BORG_STATUS_DIR="${HOME}/containers/homepage/images"',
    'BORG_STATUS_FILE="${BORG_STATUS_DIR}/borg-status.json"',
    "",
    "# Web admin URL — populated at run time by borg-backup.sh once TS_DOMAIN is known.",
    'BORG_WEB_ADMIN_URL=""',
    "",
    'BORG_LOCK_FILE="/tmp/borg-backup.lock"',
    'BORG_LOG_FILE="${HOME}/logs/borg-backup.log"',
    "",
    "# ── Retention policy ───────────────────────────────────────────",
    formatBorgBashLine("BORG_KEEP_DAILY", cfg.retention.local.daily),
    formatBorgBashLine("BORG_KEEP_WEEKLY", cfg.retention.local.weekly),
    formatBorgBashLine("BORG_KEEP_MONTHLY", cfg.retention.local.monthly),
    formatBorgBashLine("BORG_KEEP_YEARLY", cfg.retention.local.yearly),
    "",
    "# ── Paths to back up ──────────────────────────────────────────",
    formatBorgArray("BORG_BACKUP_PATHS", enabledPaths),
    "",
    "# ── Container mount directories (derived from user-config mounts) ─",
    formatBorgArray("BORG_CONTAINER_MOUNT_DIRS", containerMountDirs),
    "",
    "# ── Restore test ───────────────────────────────────────────────",
    formatBorgBashLine("BORG_RESTORE_TEST_SAMPLE_PATH", cfg.restore_test_sample_path),
    "",
    "# ── Remote (offsite) backup ────────────────────────────────────",
    "# Leave BORG_REMOTE_REPO empty to disable remote backup.",
    formatBorgBashLine("BORG_REMOTE_REPO", cfg.remote_repo),
    "",
    formatBorgBashLine("BORG_REMOTE_KEEP_DAILY", cfg.retention.remote.daily),
    formatBorgBashLine("BORG_REMOTE_KEEP_WEEKLY", cfg.retention.remote.weekly),
    formatBorgBashLine("BORG_REMOTE_KEEP_MONTHLY", cfg.retention.remote.monthly),
    formatBorgBashLine("BORG_REMOTE_KEEP_YEARLY", cfg.retention.remote.yearly),
    "",
    formatBorgBashLine("BORG_REMOTE_RATELIMIT", cfg.remote_ratelimit_kbps),
    "",
    formatBorgBashLine("BORG_RSH", cfg.rsh),
    "",
  ];
  return lines.join("\n");
}

export async function writeBorgConf(userConfig) {
  if (!userConfig) userConfig = await getUserConfig();
  const content = renderBorgConf(userConfig);
  const tmpPath = `${BORG_CONF_PATH}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, BORG_CONF_PATH);
  return { path: BORG_CONF_PATH, bytes: content.length };
}
