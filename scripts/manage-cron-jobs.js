#!/usr/bin/env node

// Manages cron jobs declared by module containers in container-registry.yaml.
// Each managed cron entry is tagged with a comment for reliable identification.
//
// Usage:
//   node manage-cron-jobs.js sync <container>   # install/update cron entries
//   node manage-cron-jobs.js remove <container>  # remove all cron entries
//   node manage-cron-jobs.js list                # show managed entries

import { readFile, access, constants } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const TAG_PREFIX = "# do-it-self:";

async function readRegistry() {
  const text = await readFile(REGISTRY_PATH, "utf8");
  return YAML.parse(text) || {};
}

function getCurrentCrontab() {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return "";
  }
}

function setCrontab(content) {
  execSync("crontab -", { input: content, encoding: "utf8" });
}

function makeTag(containerName, scriptName) {
  return `${TAG_PREFIX}${containerName}:${scriptName}`;
}

function parseTagLine(line) {
  if (!line.startsWith(TAG_PREFIX)) return null;
  const rest = line.slice(TAG_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    container: rest.slice(0, colonIdx),
    script: rest.slice(colonIdx + 1),
  };
}

function removeManagedEntries(crontabLines, containerName) {
  const result = [];
  for (let i = 0; i < crontabLines.length; i++) {
    const parsed = parseTagLine(crontabLines[i]);
    if (parsed && parsed.container === containerName) {
      // Skip the tag line and the following command line
      if (i + 1 < crontabLines.length && !crontabLines[i + 1].startsWith("#")) {
        i++;
      }
      continue;
    }
    result.push(crontabLines[i]);
  }
  return result;
}

function removeLegacyEntries(crontabLines, scriptBasename) {
  const legacyPath = join(CONTAINERS_DIR, "scripts", scriptBasename);
  return crontabLines.filter((line) => {
    if (line.startsWith("#")) return true;
    return !line.includes(legacyPath);
  });
}

async function fileIsExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncContainer(containerName) {
  const registry = await readRegistry();
  const def = registry.containers?.[containerName];
  if (!def?.cron_jobs?.length) return;

  let lines = getCurrentCrontab().split("\n");

  // Remove existing managed entries for this container (will re-add current ones)
  lines = removeManagedEntries(lines, containerName);

  for (const job of def.cron_jobs) {
    const scriptPath = join(CONTAINERS_DIR, containerName, job.script);

    if (!(await fileIsExecutable(scriptPath))) {
      console.warn(
        `  warning: cron script not found or not executable: ${scriptPath}`,
      );
      console.warn(`    Run: chmod +x ${scriptPath}`);
      continue;
    }

    // Remove legacy entries (old scripts/ path) for this script
    lines = removeLegacyEntries(lines, basename(job.script));

    const tag = makeTag(containerName, job.script);
    const command = `${job.schedule} ${scriptPath}`;
    lines.push(tag);
    lines.push(command);
  }

  // Clean up trailing blank lines, ensure single trailing newline
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  lines.push("");

  setCrontab(lines.join("\n"));

  for (const job of def.cron_jobs) {
    console.log(`  cron: ${job.description || job.script} (${job.schedule})`);
  }
}

async function removeContainer(containerName) {
  const crontab = getCurrentCrontab();
  if (!crontab) return;

  let lines = crontab.split("\n");
  const before = lines.length;
  lines = removeManagedEntries(lines, containerName);

  if (lines.length < before) {
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    lines.push("");
    setCrontab(lines.join("\n"));
    console.log(`  cron: removed entries for ${containerName}`);
  }
}

async function listManaged() {
  const crontab = getCurrentCrontab();
  if (!crontab) {
    console.log("No crontab entries.");
    return;
  }

  const lines = crontab.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseTagLine(lines[i]);
    if (parsed && i + 1 < lines.length) {
      console.log(`${parsed.container}: ${lines[i + 1]}`);
      found = true;
      i++;
    }
  }

  if (!found) {
    console.log("No module-managed cron entries.");
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "sync":
      if (!args[0]) {
        console.error("Usage: manage-cron-jobs.js sync <container>");
        process.exit(1);
      }
      await syncContainer(args[0]);
      break;
    case "remove":
      if (!args[0]) {
        console.error("Usage: manage-cron-jobs.js remove <container>");
        process.exit(1);
      }
      await removeContainer(args[0]);
      break;
    case "list":
      await listManaged();
      break;
    default:
      console.error("Usage: manage-cron-jobs.js <sync|remove|list> [container]");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
