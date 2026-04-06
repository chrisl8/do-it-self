#!/usr/bin/env node

// Scans all compose files and extracts parameterized volume mounts.
// Deduplicates by host path within each container.
// Outputs JSON for registry generation and compose file rewriting.

import { readdir, readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");

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

  if (parts.includes("for-homepage")) return null; // monitoring mount, handled specially

  const cmIdx = parts.indexOf("container-mounts");
  if (cmIdx >= 0) {
    const afterCm = parts.slice(cmIdx + 1);
    // Strip container name prefix (exact match or close variant)
    if (afterCm.length > 0) {
      const first = afterCm[0];
      const containerVariants = [
        containerName,
        containerName.replace(/-/g, ""),
        // Handle cases like "actual-api" for "actual-budget-api"
      ];
      if (containerVariants.includes(first) || first === containerName.split("-").pop()) {
        afterCm.shift();
      }
    }
    if (afterCm.length === 0) return "data";
    return afterCm.join("_").replace(/-/g, "_");
  }

  // Non container-mounts paths (e.g. borg-repo, samba)
  return parts[parts.length - 1].replace(/-/g, "_");
}

async function main() {
  const entries = await readdir(CONTAINERS_DIR, { withFileTypes: true });
  const results = {};

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const composePath = join(CONTAINERS_DIR, entry.name, "compose.yaml");
    if (!(await fileExists(composePath))) continue;

    const content = await readFile(composePath, "utf8");

    // Match parameterized volume lines
    const regex = /^(\s*-\s*)\$\{([A-Z_]+):-([^}]+)\}\/([^:]+):([^\s]+)/gm;
    const rawMatches = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      rawMatches.push({
        indent: match[1],
        currentVar: match[2],
        defaultPath: match[3],
        hostSubpath: match[4],
        containerPath: match[5],
        fullMatch: match[0],
        index: match.index,
      });
    }

    if (rawMatches.length === 0) continue;

    // Group by unique (currentVar + hostSubpath) to deduplicate same host path
    const uniqueVolumes = new Map();
    const allLines = [];

    for (const m of rawMatches) {
      const volumeName = deriveVolumeName(m.hostSubpath, entry.name);
      if (volumeName === null) {
        // Monitoring mount - mark for special handling
        allLines.push({ ...m, isMonitoring: true, volumeName: null, newVar: null });
        continue;
      }

      const dedupeKey = `${m.currentVar}/${m.hostSubpath}`;
      if (!uniqueVolumes.has(dedupeKey)) {
        uniqueVolumes.set(dedupeKey, {
          volumeName,
          currentVar: m.currentVar,
          defaultPath: m.defaultPath,
          hostSubpath: m.hostSubpath,
          containerPath: m.containerPath,
          newVar: null, // assigned after dedup
        });
      }
      allLines.push({ ...m, dedupeKey, isMonitoring: false });
    }

    // Ensure unique volume names
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

    // Map lines to their deduplicated variable
    for (const line of allLines) {
      if (line.isMonitoring) continue;
      const vol = uniqueVolumes.get(line.dedupeKey);
      line.volumeName = vol.volumeName;
      line.newVar = vol.newVar;
    }

    const isMonitorContainer = allLines.some(l => l.isMonitoring);

    results[entry.name] = {
      monitorAllMounts: isMonitorContainer,
      volumes: [...uniqueVolumes.values()],
      lines: allLines.map(l => ({
        fullMatch: l.fullMatch,
        newVar: l.newVar,
        isMonitoring: l.isMonitoring,
        currentVar: l.currentVar,
        defaultPath: l.defaultPath,
        hostSubpath: l.hostSubpath,
        containerPath: l.containerPath,
      })),
    };
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
