#!/usr/bin/env node

// Rewrites compose files to use per-volume variables (VOL_CONTAINER_VOLUME)
// instead of the shared ROOT variables (DATA_ROOT, MEDIA_ROOT, etc.).
// Monitoring mounts in homepage/beszel are left as-is (handled by compose regeneration).
// Also outputs registry volume declarations to stdout.

import { readdir, readFile, writeFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const DEFAULT_MOUNT = "~/container-data";

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function toVarName(containerName, volumeName) {
  const c = containerName.replace(/-/g, "_").toUpperCase();
  const v = volumeName.replace(/-/g, "_").toUpperCase();
  return `VOL_${c}_${v}`;
}

function deriveVolumeName(hostSubpath, containerName) {
  const parts = hostSubpath.split("/").filter(Boolean);
  if (parts.includes("for-homepage")) return null;

  const cmIdx = parts.indexOf("container-mounts");
  if (cmIdx >= 0) {
    const afterCm = parts.slice(cmIdx + 1);
    if (afterCm.length > 0) {
      const first = afterCm[0];
      const containerVariants = [
        containerName,
        containerName.replace(/-/g, ""),
      ];
      if (containerVariants.includes(first) || first === containerName.split("-").pop()) {
        afterCm.shift();
      }
    }
    if (afterCm.length === 0) return "data";
    return afterCm.join("_").replace(/-/g, "_");
  }

  return parts[parts.length - 1].replace(/-/g, "_");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const entries = await readdir(CONTAINERS_DIR, { withFileTypes: true });
  const registryVolumes = {};
  let filesModified = 0;
  let volumesTotal = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const composePath = join(CONTAINERS_DIR, entry.name, "compose.yaml");
    if (!(await fileExists(composePath))) continue;

    let content = await readFile(composePath, "utf8");
    const regex = /\$\{([A-Z_]+):-([^}]+)\}\/([^:]+):([^\s]+)/g;

    // First pass: build dedup map
    const uniqueVolumes = new Map();
    let match;
    while ((match = regex.exec(content)) !== null) {
      const currentVar = match[1];
      const hostSubpath = match[3];
      const containerPath = match[4];
      const volumeName = deriveVolumeName(hostSubpath, entry.name);
      if (volumeName === null) continue; // monitoring mount

      const dedupeKey = `${currentVar}/${hostSubpath}`;
      if (!uniqueVolumes.has(dedupeKey)) {
        uniqueVolumes.set(dedupeKey, { volumeName, hostSubpath, containerPath, currentVar });
      }
    }

    // Ensure unique names
    const nameCount = {};
    for (const vol of uniqueVolumes.values()) {
      if (nameCount[vol.volumeName]) {
        nameCount[vol.volumeName]++;
        vol.volumeName = `${vol.volumeName}_${nameCount[vol.volumeName]}`;
      } else {
        nameCount[vol.volumeName] = 1;
      }
      vol.newVar = toVarName(entry.name, vol.volumeName);
    }

    if (uniqueVolumes.size === 0) {
      // Check if this is a monitor-only container (homepage/beszel with only for-homepage mounts)
      const hasMonitoring = /for-homepage/.test(content);
      if (!hasMonitoring) continue;
      // Monitor-only: still record in registry but no volume rewrites needed
      registryVolumes[entry.name] = { monitorAllMounts: true, volumes: [] };
      continue;
    }

    // Save registry data
    const hasMonitoring = /for-homepage/.test(content);
    registryVolumes[entry.name] = {
      monitorAllMounts: hasMonitoring,
      volumes: [...uniqueVolumes.values()].map(v => ({
        name: v.volumeName,
        var: v.newVar,
        host_subpath: v.hostSubpath,
        container_path: v.containerPath,
      })),
    };
    volumesTotal += uniqueVolumes.size;

    // Second pass: rewrite compose file
    let modified = content;
    for (const [dedupeKey, vol] of uniqueVolumes) {
      const [currentVar] = dedupeKey.split("/");
      // Escape regex special chars in the paths
      const escaped = vol.hostSubpath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `\\$\\{${currentVar}:-[^}]+\\}/${escaped}`,
        "g"
      );
      const replacement = `\${${vol.newVar}:-${DEFAULT_MOUNT}}/${vol.hostSubpath}`;
      modified = modified.replace(pattern, replacement);
    }

    if (modified !== content) {
      if (!dryRun) {
        await writeFile(composePath, modified, "utf8");
      }
      filesModified++;
    }
  }

  // Output registry volume data as YAML-ish for easy consumption
  if (process.argv.includes("--registry-json")) {
    console.log(JSON.stringify(registryVolumes, null, 2));
  } else {
    console.error(`Modified ${filesModified} compose files, ${volumesTotal} unique volumes`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
