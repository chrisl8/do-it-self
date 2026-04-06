#!/usr/bin/env node

// One-time script to generate container-registry.yaml from existing repo structure.
// Scans 1password_credential_paths.env files, compose.yaml files, and metadata files.

import { readdir, readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getContainerDirs() {
  const entries = await readdir(CONTAINERS_DIR, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const composePath = join(CONTAINERS_DIR, entry.name, "compose.yaml");
    if (await fileExists(composePath)) {
      dirs.push(entry.name);
    }
  }
  return dirs.sort();
}

async function parse1PasswordEnv(containerName) {
  const envPath = join(
    CONTAINERS_DIR,
    containerName,
    "1password_credential_paths.env",
  );
  if (!(await fileExists(envPath))) return [];
  const content = await readFile(envPath, "utf8");
  const vars = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*):?="?op:\/\/([^"]*)"?$/);
    if (match) {
      vars.push({ name: match[1], opPath: match[2] });
    }
  }
  return vars;
}

async function parseComposeYaml(containerName) {
  const composePath = join(CONTAINERS_DIR, containerName, "compose.yaml");
  const content = await readFile(composePath, "utf8");

  // Extract homepage.group
  const groupMatch = content.match(/homepage\.group=(.+)/);
  const group = groupMatch ? groupMatch[1].trim() : null;

  // Detect Tailscale sidecar
  const usesTailscale = /TS_AUTHKEY/.test(content);

  // Detect GPU
  const usesGpu =
    /runtime:\s*nvidia/.test(content) ||
    /driver:\s*nvidia/.test(content);

  // Extract mount paths
  const mountRoots = new Set();
  const mountMatches = content.matchAll(
    /- (\/mnt\/[^/]+)\/[^:]+:/g,
  );
  for (const m of mountMatches) {
    mountRoots.add(m[1]);
  }

  // Check for hardcoded home directory paths in volumes
  const homeDir = homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasHomePaths = new RegExp(homeDir).test(content);

  // Extract docker group_add
  const gidMatch = content.match(/group_add:\s*\n\s*-\s*(\d+)/);
  const usesDockerGid = gidMatch ? gidMatch[1] : null;

  return {
    group,
    usesTailscale,
    usesGpu,
    mountRoots: [...mountRoots],
    hasHomePaths,
    usesDockerGid,
  };
}

async function getStartOrder(containerName) {
  const orderPath = join(CONTAINERS_DIR, containerName, ".start-order");
  if (!(await fileExists(orderPath))) return null;
  const content = await readFile(orderPath, "utf8");
  return content.trim();
}

async function isDisabled(containerName) {
  return fileExists(join(CONTAINERS_DIR, containerName, "_DISABLED_"));
}

// Map known shared variables that should not be per-container
const SHARED_VARS = new Set([
  "TS_AUTHKEY",
  "TS_DOMAIN",
  "HOST_NAME",
]);

// Infer variable type from name
function inferType(varName) {
  const lower = varName.toLowerCase();
  if (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("key") ||
    lower.includes("token")
  )
    return "secret";
  if (lower.includes("port") || lower.includes("gid")) return "number";
  if (lower.includes("url") || lower.includes("host") || lower.includes("email") || lower.includes("from") || lower.includes("user") || lower.includes("name"))
    return "string";
  return "string";
}

// Normalize homepage group to slug
function groupToSlug(group) {
  if (!group) return "uncategorized";
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mountRootToVar(mountRoot) {
  const map = {
    "/mnt/2000": "DATA_ROOT",
    "/mnt/22TB": "MEDIA_ROOT",
    "/mnt/250": "CACHE_ROOT",
    "/mnt/120": "MONITOR_ROOT",
  };
  return map[mountRoot] || "DATA_ROOT";
}

async function main() {
  const containers = await getContainerDirs();

  // Collect all categories
  const categories = new Map();

  // Build container entries
  const containerEntries = [];

  for (const name of containers) {
    const opVars = await parse1PasswordEnv(name);
    const compose = await parseComposeYaml(name);
    const startOrder = await getStartOrder(name);
    const disabled = await isDisabled(name);

    // Track category
    const slug = groupToSlug(compose.group);
    if (compose.group && !categories.has(slug)) {
      categories.set(slug, compose.group);
    }

    // Separate container-specific vars from shared vars
    const containerVars = opVars.filter((v) => !SHARED_VARS.has(v.name));

    containerEntries.push({
      name,
      description: "", // needs manual fill
      category: slug,
      usesTailscale: compose.usesTailscale,
      usesGpu: compose.usesGpu,
      usesDockerGid: compose.usesDockerGid,
      mountRoots: compose.mountRoots,
      startOrder,
      disabled,
      variables: containerVars,
    });
  }

  // Generate YAML output
  let yaml = "";

  // Shared variables
  yaml += `shared_variables:\n`;
  yaml += `  DATA_ROOT:\n`;
  yaml += `    type: path\n`;
  yaml += `    description: "Primary data storage root for container mounts"\n`;
  yaml += `    default: "~/container-data"\n`;
  yaml += `    required: true\n`;
  yaml += `  MEDIA_ROOT:\n`;
  yaml += `    type: path\n`;
  yaml += `    description: "Large media storage (movies, TV, downloads, backups)"\n`;
  yaml += `    default: "\${DATA_ROOT}"\n`;
  yaml += `  CACHE_ROOT:\n`;
  yaml += `    type: path\n`;
  yaml += `    description: "Fast storage for caches and temporary data"\n`;
  yaml += `    default: "\${DATA_ROOT}"\n`;
  yaml += `  MONITOR_ROOT:\n`;
  yaml += `    type: path\n`;
  yaml += `    description: "Monitored filesystem mount point"\n`;
  yaml += `    default: "\${DATA_ROOT}"\n`;
  yaml += `  TS_AUTHKEY:\n`;
  yaml += `    type: secret\n`;
  yaml += `    description: "Tailscale authentication key for container networking"\n`;
  yaml += `    required: true\n`;
  yaml += `  TS_DOMAIN:\n`;
  yaml += `    type: string\n`;
  yaml += `    description: "Your Tailscale domain (e.g. tail1234.ts.net)"\n`;
  yaml += `    required: true\n`;
  yaml += `  HOST_NAME:\n`;
  yaml += `    type: string\n`;
  yaml += `    description: "This server's hostname on the Tailnet"\n`;
  yaml += `    default: ""\n`;
  yaml += `  DOCKER_GID:\n`;
  yaml += `    type: number\n`;
  yaml += `    description: "GID of the docker group on the host (for socket access)"\n`;
  yaml += `    default: "985"\n`;
  yaml += `\n`;

  // Categories
  yaml += `categories:\n`;
  const sortedCategories = [...categories.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [slug, label] of sortedCategories) {
    yaml += `  ${slug}:\n`;
    yaml += `    label: "${label}"\n`;
  }
  yaml += `  uncategorized:\n`;
  yaml += `    label: "Uncategorized"\n`;
  yaml += `\n`;

  // Containers
  yaml += `containers:\n`;
  for (const c of containerEntries) {
    yaml += `  ${c.name}:\n`;
    yaml += `    description: ""\n`;
    yaml += `    category: ${c.category}\n`;
    if (c.usesTailscale) yaml += `    uses_tailscale: true\n`;
    if (c.usesGpu) yaml += `    requires_gpu: true\n`;
    if (c.usesDockerGid) yaml += `    uses_docker_gid: true\n`;
    if (c.startOrder) yaml += `    start_order: "${c.startOrder}"\n`;
    if (c.disabled) yaml += `    default_disabled: true\n`;

    // Mount roots used (for documentation)
    if (c.mountRoots.length > 0) {
      yaml += `    mount_roots:\n`;
      for (const root of c.mountRoots) {
        yaml += `      - ${mountRootToVar(root)}\n`;
      }
    }

    // Variables
    if (c.variables.length > 0) {
      yaml += `    variables:\n`;
      for (const v of c.variables) {
        yaml += `      ${v.name}:\n`;
        yaml += `        type: ${inferType(v.name)}\n`;
        yaml += `        required: true\n`;
        yaml += `        description: ""\n`;
      }
    }
  }

  process.stdout.write(yaml);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
