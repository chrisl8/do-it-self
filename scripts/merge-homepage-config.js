#!/usr/bin/env node

// Merges homepage/config-defaults/ (in git, what every user gets) with
// homepage/config-personal/ (gitignored, per-host overrides) and writes
// the result to homepage/config/, which is what the homepage container
// actually mounts.
//
// Per-file rules:
//   services.yaml   -- top-level list, defaults concatenated with personal,
//                      then ${HOST_NAME} and ${TS_DOMAIN} substituted from
//                      user-config.yaml.shared
//   bookmarks.yaml  -- top-level list, concat (defaults first, personal after)
//   widgets.yaml    -- top-level list, concat (defaults first, personal after),
//                      then a dynamic storage widget appended that lists every
//                      mount in user-config.yaml.mounts (plus "/")
//   settings.yaml   -- top-level map, deep-merged (personal overrides defaults)
//   *.yaml (other)  -- top-level map, deep-merged
//   *.css / *.js    -- text, personal overrides default if present
//
// Run before `docker compose up` for homepage. Idempotent. The output dir
// is wiped and rewritten on every run, so editing files in homepage/config/
// directly is futile -- edit homepage/config-personal/ (or, for changes that
// should ship to all users, homepage/config-defaults/).

import { readFile, writeFile, readdir, mkdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HOMEPAGE_DIR = join(REPO_ROOT, "homepage");
const DEFAULTS_DIR = join(HOMEPAGE_DIR, "config-defaults");
const PERSONAL_DIR = join(HOMEPAGE_DIR, "config-personal");
const OUTPUT_DIR = join(HOMEPAGE_DIR, "config");
const USER_CONFIG_PATH = join(REPO_ROOT, "user-config.yaml");

const QUIET = process.argv.includes("--quiet");
function log(...args) {
  if (!QUIET) console.log(...args);
}

// Files where the top-level shape is a list (concatenate on merge).
const LIST_FILES = new Set([
  "services.yaml",
  "bookmarks.yaml",
  "widgets.yaml",
]);

async function readYaml(path) {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  if (!text.trim()) return null;
  try {
    return yaml.parse(text);
  } catch (err) {
    console.error(`[merge-homepage-config] Failed to parse ${path}: ${err.message}`);
    throw err;
  }
}

async function readUserConfig() {
  // Shared template variables (HOST_NAME, TS_DOMAIN) live in Infisical at
  // /shared, not in user-config.yaml. The caller (scripts/all-containers.sh)
  // is responsible for exporting them into the environment via
  // `infisical export --path=/shared` before running this script. We read
  // them from process.env here, falling back to user-config.yaml.shared for
  // backward compat with older deployments that still keep a `shared:` block.
  const sharedFromEnv = {};
  for (const key of ["HOST_NAME", "TS_DOMAIN"]) {
    if (process.env[key]) sharedFromEnv[key] = process.env[key];
  }
  if (!existsSync(USER_CONFIG_PATH)) {
    return { mounts: [], shared: sharedFromEnv };
  }
  const cfg = (await readYaml(USER_CONFIG_PATH)) || {};
  return {
    mounts: Array.isArray(cfg.mounts) ? cfg.mounts : [],
    shared: { ...(cfg.shared || {}), ...sharedFromEnv },
  };
}

// Deep-merge two plain objects. b wins on conflicts. Arrays are concatenated.
function deepMerge(a, b) {
  if (b === undefined || b === null) return a;
  if (a === undefined || a === null) return b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }
  return b;
}

// Substitute ${HOST_NAME} and ${TS_DOMAIN} in a YAML text using values from
// user-config.yaml's shared section. Done at the text level (before yaml.parse)
// so it works regardless of where in the YAML structure the placeholder lives.
function substituteTemplateVars(text, shared) {
  return text.replace(/\$\{(HOST_NAME|TS_DOMAIN)\}/g, (match, key) => {
    const value = shared[key];
    if (value === undefined || value === null || value === "") {
      // Leave the placeholder in place — clearer signal than rendering a half-URL.
      return match;
    }
    return String(value);
  });
}

// Build the dynamic storage widget from user-config mounts.
// Always includes "/" as the root filesystem; appends one disk per
// user-config mount using the IN-CONTAINER path (`/mnt/${label}`),
// because homepage's resources widget reads df stats from inside the
// container. The bind mounts in compose.override.yaml map each host
// `${path}/for-homepage` to `/mnt/${label}`, so querying `/mnt/${label}`
// returns stats for the underlying host filesystem.
function buildStorageWidget(mounts) {
  const disks = ["/"];
  for (const [i, m] of mounts.entries()) {
    if (!m) continue;
    const label = m.label || `mount_${i}`;
    const containerPath = `/mnt/${label}`;
    if (!disks.includes(containerPath)) disks.push(containerPath);
  }
  return {
    resources: {
      label: "Storage",
      expanded: true,
      refresh: 60000,
      disk: disks,
    },
  };
}

async function readListFile(name, shared) {
  const defaultsPath = join(DEFAULTS_DIR, name);
  const personalPath = join(PERSONAL_DIR, name);

  let defaultsText = "";
  if (existsSync(defaultsPath)) {
    defaultsText = await readFile(defaultsPath, "utf8");
  }
  // Template substitution applies to both files (mainly for services.yaml).
  defaultsText = substituteTemplateVars(defaultsText, shared);

  let personalText = "";
  if (existsSync(personalPath)) {
    personalText = await readFile(personalPath, "utf8");
  }
  personalText = substituteTemplateVars(personalText, shared);

  const defaultsParsed = defaultsText.trim() ? yaml.parse(defaultsText) : null;
  const personalParsed = personalText.trim() ? yaml.parse(personalText) : null;

  const defaultsList = Array.isArray(defaultsParsed) ? defaultsParsed : [];
  const personalList = Array.isArray(personalParsed) ? personalParsed : [];

  return [...defaultsList, ...personalList];
}

async function readMapFile(name) {
  const defaults = (await readYaml(join(DEFAULTS_DIR, name))) || {};
  const personal = (await readYaml(join(PERSONAL_DIR, name))) || {};
  return deepMerge(defaults, personal);
}

// For YAML files where neither defaults nor personal has any actual keys
// (typically comment-only templates like kubernetes.yaml), copying the raw
// defaults text preserves the helpful example comments. Otherwise the
// deep-merge path serializes `{}` and the comments are lost.
async function isEffectivelyEmptyMap(name) {
  const defaults = await readYaml(join(DEFAULTS_DIR, name));
  const personal = await readYaml(join(PERSONAL_DIR, name));
  const empty = (v) =>
    v === null || v === undefined ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  return empty(defaults) && empty(personal);
}

async function copyTextFile(name) {
  const personalPath = join(PERSONAL_DIR, name);
  const defaultsPath = join(DEFAULTS_DIR, name);
  const sourcePath = existsSync(personalPath) ? personalPath : defaultsPath;
  if (!existsSync(sourcePath)) return false;
  await copyFile(sourcePath, join(OUTPUT_DIR, name));
  return true;
}

// File extensions the merge script manages. Anything else in OUTPUT_DIR
// (notably homepage's runtime logs/ subdirectory, or an `images/` dir
// the user put there) is left alone.
const MANAGED_EXTENSIONS = [".yaml", ".yml", ".css", ".js"];

function isManaged(name) {
  return MANAGED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

async function main() {
  if (!existsSync(DEFAULTS_DIR)) {
    log(`[merge-homepage-config] No ${DEFAULTS_DIR} -- nothing to do.`);
    return;
  }

  const userConfig = await readUserConfig();
  const shared = userConfig.shared;
  const mounts = userConfig.mounts;

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Discover all files in either source directory
  const defaultsFiles = existsSync(DEFAULTS_DIR) ? await readdir(DEFAULTS_DIR) : [];
  const personalFiles = existsSync(PERSONAL_DIR) ? await readdir(PERSONAL_DIR) : [];
  const sourceFiles = new Set(
    [...defaultsFiles, ...personalFiles].filter(isManaged),
  );

  // Delete any managed files in OUTPUT_DIR that are NOT in sourceFiles (i.e.
  // they used to be in defaults or personal but have been removed). Leaves
  // non-managed files (like homepage's logs/ dir) untouched.
  const existingOutput = existsSync(OUTPUT_DIR) ? await readdir(OUTPUT_DIR) : [];
  for (const name of existingOutput) {
    if (!isManaged(name)) continue;
    if (!sourceFiles.has(name)) {
      try {
        await unlink(join(OUTPUT_DIR, name));
        log(`  removed stale ${name}`);
      } catch {
        // ignore
      }
    }
  }

  for (const name of sourceFiles) {
    const outPath = join(OUTPUT_DIR, name);
    const isYaml = name.endsWith(".yaml") || name.endsWith(".yml");

    if (!isYaml) {
      // text file (custom.css, custom.js) -- personal wins, else defaults
      const copied = await copyTextFile(name);
      if (copied) log(`  copied ${name}`);
      continue;
    }

    if (LIST_FILES.has(name)) {
      const list = await readListFile(name, shared);

      // widgets.yaml gets the dynamic storage widget appended
      if (name === "widgets.yaml") {
        list.push(buildStorageWidget(mounts));
      }

      const out = yaml.stringify(list);
      await writeFile(outPath, out, "utf8");
      log(`  merged ${name} (${list.length} item${list.length === 1 ? "" : "s"})`);
    } else if (await isEffectivelyEmptyMap(name)) {
      // comment-only template (kubernetes.yaml, proxmox.yaml, etc.) --
      // copy the defaults file verbatim so the example comments survive.
      const copied = await copyTextFile(name);
      if (copied) log(`  copied ${name} (comments preserved)`);
    } else {
      // map file with actual content -- deep merge
      const merged = await readMapFile(name);
      const out = yaml.stringify(merged);
      await writeFile(outPath, out, "utf8");
      log(`  merged ${name}`);
    }
  }

  log(`[merge-homepage-config] Wrote ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("[merge-homepage-config] Failed:", err);
  process.exit(1);
});
