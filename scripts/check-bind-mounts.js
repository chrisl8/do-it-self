#!/usr/bin/env node

// Pre-flight check for compose.yaml bind mounts. Catches the failure mode
// where a file bind mount points at a missing host source: Docker silently
// auto-creates an empty directory at the path, the container then crashloops
// when the application tries to read what it expects to be a file.
//
// Scope (intentionally narrow):
//   - Only relative bind mounts of the form "./X:Y[:flags]" where the source
//     resolves inside the container directory.
//   - Source paths that escape (../X), are absolute, or interpolate env vars
//     are skipped — they reference state outside this container's purview.
//
// File-vs-directory intent is heuristic: source/dest basenames with a
// known config-file extension or known extensionless config name (Caddyfile,
// Dockerfile, etc.) are treated as files. Anything else falls through to
// "unknown" and is not flagged — the goal is to catch the known bug class
// without false positives on dir mounts.
//
// Exit codes:
//   0  all bind mounts OK (or no relevant bind mounts in this compose.yaml)
//   1  one or more file bind mounts have a missing or directory source
//
// Usage:
//   node check-bind-mounts.js <container>

import { readFile, lstat, stat } from "fs/promises";
import { join, dirname, basename, resolve, relative } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");

const FILE_EXT = /\.[A-Za-z0-9]+$/;
const KNOWN_FILE_BASENAMES = new Set([
  "Caddyfile",
  "Dockerfile",
  "Makefile",
  "Procfile",
]);

function isLikelyFileBasename(name) {
  if (!name) return false;
  if (KNOWN_FILE_BASENAMES.has(name)) return true;
  // Avoid treating ".env" / ".gitignore" / etc as having an extension —
  // a leading dot is the entire name.
  if (name.startsWith(".")) return false;
  return FILE_EXT.test(name);
}

function looksLikeFile(src, dest) {
  return isLikelyFileBasename(basename(src)) || isLikelyFileBasename(basename(dest));
}

// Extract the source path from a compose volume entry, which may be either:
//   - "./src:/dest"           (string short form)
//   - "./src:/dest:ro"        (string short form with flags)
//   - { type, source, target }  (long form)
function extractMount(entry) {
  if (typeof entry === "string") {
    // Split on ":" but skip embedded windows-style paths (not used here).
    const parts = entry.split(":");
    if (parts.length < 2) return null;
    return { source: parts[0], target: parts[1] };
  }
  if (entry && typeof entry === "object" && entry.source && entry.target) {
    if (entry.type && entry.type !== "bind") return null;
    return { source: entry.source, target: entry.target };
  }
  return null;
}

async function pathKind(p) {
  try {
    // Use stat (follows symlinks) — Docker follows host-side symlinks when
    // resolving bind mounts, so the symlink target's kind is what matters.
    const s = await stat(p);
    if (s.isDirectory()) return "dir";
    if (s.isFile()) return "file";
    return "other";
  } catch (err) {
    if (err.code === "ENOENT") {
      // Source missing entirely. Could also be a broken symlink — check lstat.
      try {
        const ls = await lstat(p);
        if (ls.isSymbolicLink()) return "broken-link";
      } catch {
        // fallthrough to "missing"
      }
      return "missing";
    }
    throw err;
  }
}

async function main() {
  const containerName = process.argv[2];
  if (!containerName) {
    console.error("Usage: check-bind-mounts.js <container>");
    process.exit(2);
  }

  const containerDir = join(CONTAINERS_DIR, containerName);
  const composePath = join(containerDir, "compose.yaml");

  let composeText;
  try {
    composeText = await readFile(composePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return; // no compose.yaml — nothing to do
    throw err;
  }

  let parsed;
  try {
    parsed = YAML.parse(composeText);
  } catch (err) {
    console.error(`check-bind-mounts: ${containerName}: failed to parse compose.yaml: ${err.message}`);
    process.exit(2);
  }

  const services = parsed?.services || {};
  const errors = [];

  for (const [serviceName, service] of Object.entries(services)) {
    const volumes = service?.volumes || [];
    for (const entry of volumes) {
      const mount = extractMount(entry);
      if (!mount) continue;

      const { source, target } = mount;

      // Narrow scope: skip env-interpolated, absolute, or escaping sources.
      if (source.includes("$")) continue;
      if (!source.startsWith("./")) continue;

      const absSource = resolve(containerDir, source);
      const rel = relative(containerDir, absSource);
      if (rel.startsWith("..") || resolve(rel) === resolve("..")) continue;

      const kind = await pathKind(absSource);
      const expectFile = looksLikeFile(source, target);

      if (kind === "missing" && expectFile) {
        errors.push({
          service: serviceName,
          source,
          target,
          reason: "host source is missing — Docker will create an empty directory at this path and the container will crash trying to read it as a file",
        });
      } else if (kind === "broken-link") {
        errors.push({
          service: serviceName,
          source,
          target,
          reason: "host source is a symlink whose target does not exist",
        });
      } else if (kind === "dir" && expectFile) {
        errors.push({
          service: serviceName,
          source,
          target,
          reason: "host source is a directory, but the bind mount target looks like a file — most likely Docker auto-created an empty directory after the source went missing",
        });
      }
    }
  }

  if (errors.length === 0) return;

  console.error(`\n  Pre-flight bind-mount check failed for ${containerName}:`);
  for (const e of errors) {
    console.error(`    [${e.service}] ${e.source} -> ${e.target}`);
    console.error(`      ${e.reason}`);
  }
  console.error(
    `    Suggested fix: restore the file from config-personal/${basename(errors[0].source)},`,
  );
  console.error(
    `    config-defaults/${basename(errors[0].source)}, or the module source. After the file`,
  );
  console.error(
    `    exists, recreate the container with --stop --start so the bind mount re-resolves.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`check-bind-mounts: unexpected error: ${err.stack || err.message}`);
  process.exit(2);
});
