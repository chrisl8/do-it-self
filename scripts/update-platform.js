#!/usr/bin/env node

// Safe platform update flow. Pulls the platform repo from its upstream branch
// (fast-forward only), re-runs setup hooks for installed containers, and
// validates every enabled container's .env requirements. Fail-loudly: on a
// post-pull validation failure the system is left at the new HEAD with a clear
// diagnostic — no rollback.
//
// Structured exit codes:
//   0  ok (up to date or pulled + validated clean)
//   1  generic error
//   2  precondition failed (uncommitted changes, no upstream, diverged) — no mutation
//   3  post-pull validation failed — system is at new HEAD
//   4  pre-backup failed — no mutation
//
// Usage:
//   node update-platform.js [--pre-backup] [--yes] [--ignore-hooks] [--remote <name>] [--branch <name>]

import { readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";
import { createInterface } from "readline";
import os from "os";
import YAML from "yaml";
import { readCatalog, readInstalled, reconcileCatalog, cloneModule } from "./lib/module-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = join(__dirname, "..");
const MODULES_DIR = join(CONTAINERS_DIR, ".modules");
const REGISTRY_PATH = join(CONTAINERS_DIR, "container-registry.yaml");
const INSTALLED_MODULES_PATH = join(CONTAINERS_DIR, "installed-modules.yaml");
const MODULE_CATALOG_PATH = join(CONTAINERS_DIR, "module-catalog.yaml");
const USER_CONFIG_PATH = join(CONTAINERS_DIR, "user-config.yaml");
const BORG_BACKUP_SH = join(__dirname, "borg-backup.sh");

// --- ANSI helpers ---
const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
};

function section(title) {
  console.log(`\n${c.bold}${c.cyan}── ${title} ──${c.reset}`);
}
function ok(msg) { console.log(`  ${c.green}OK${c.reset}   ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}WARN${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}FAIL${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }

// --- Utility ---

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readYaml(p) {
  if (!(await fileExists(p))) return null;
  return YAML.parse(await readFile(p, "utf8"));
}

function git(args, opts = {}) {
  return execSync(`git ${args}`, {
    cwd: CONTAINERS_DIR,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    ...opts,
  }).trim();
}

function gitSafe(args) {
  try { return { ok: true, out: git(args) }; }
  catch (e) { return { ok: false, err: e.message, out: (e.stdout || "") + (e.stderr || "") }; }
}

function parseFlags(argv) {
  const flags = { preBackup: false, yes: false, ignoreHooks: false, remote: "origin", branch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pre-backup") flags.preBackup = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--ignore-hooks") flags.ignoreHooks = true;
    else if (a === "--remote") flags.remote = argv[++i];
    else if (a === "--branch") flags.branch = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: update-platform.js [--pre-backup] [--yes] [--ignore-hooks] [--remote <name>] [--branch <name>]");
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return flags;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// --- Steps ---

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  // Refuse to run as root. borg-backup.sh self-re-execs with sudo; the rest
  // of this flow writes user-owned state (installed-modules.yaml) and should
  // not be run as root.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error(`${c.red}Refusing to run as root.${c.reset} Run as the platform user; borg-backup.sh will elevate itself when --pre-backup is passed.`);
    process.exit(1);
  }

  const branch = flags.branch || gitSafe("rev-parse --abbrev-ref HEAD").out;
  if (!branch || branch === "HEAD") {
    section("Preconditions");
    fail(`Not on a branch (detached HEAD). Check out a branch first.`);
    process.exit(2);
  }

  section("Preconditions");

  // Step 1: working tree clean
  const statusOut = gitSafe("status --porcelain").out;
  if (statusOut) {
    fail("Platform repo has uncommitted changes:");
    for (const line of statusOut.split("\n").slice(0, 20)) info(`    ${line}`);
    console.log(`  ${c.dim}Commit or stash changes before updating. Do not use --force.${c.reset}`);
    process.exit(2);
  }
  ok("working tree clean");

  // Step 2: branch has upstream
  const upstreamProbe = gitSafe(`rev-parse --abbrev-ref --symbolic-full-name ${branch}@{u}`);
  if (!upstreamProbe.ok) {
    fail(`Branch ${branch} has no upstream.`);
    info(`  Set one with: git branch --set-upstream-to=${flags.remote}/${branch} ${branch}`);
    process.exit(2);
  }
  const upstream = upstreamProbe.out;
  ok(`on ${branch} tracking ${upstream}`);

  // Step 3: warn on dirty module clones
  const installed = (await readYaml(INSTALLED_MODULES_PATH)) || { modules: {} };
  const dirtyModules = [];
  for (const mod of Object.keys(installed.modules || {})) {
    const modPath = join(MODULES_DIR, mod);
    if (!(await fileExists(modPath))) continue;
    try {
      const out = execSync("git status --porcelain", { cwd: modPath, encoding: "utf8" }).trim();
      if (out) dirtyModules.push(mod);
    } catch {
      // ignore — missing clone isn't blocking here
    }
  }
  if (dirtyModules.length) {
    warn(`dirty module clones (not blocking): ${dirtyModules.join(", ")}`);
    info(`  Commit/sync with: scripts/module.sh dev-sync <module>`);
  } else {
    ok("module clones clean");
  }

  // Step 4: fetch + classify
  section("Fetch");
  info(`fetching ${flags.remote}/${branch}...`);
  const fetchResult = gitSafe(`fetch --quiet ${flags.remote} ${branch}`);
  if (!fetchResult.ok) {
    fail(`git fetch failed:`);
    info(`  ${fetchResult.err}`);
    process.exit(1);
  }

  const countOut = gitSafe(`rev-list --left-right --count ${upstream}...HEAD`).out;
  const [behindStr, aheadStr] = countOut.split(/\s+/);
  const behind = parseInt(behindStr, 10) || 0;
  const ahead = parseInt(aheadStr, 10) || 0;

  if (ahead > 0) {
    fail(`Local branch has ${ahead} commit(s) not in ${upstream} (and is ${behind} behind).`);
    info("  This updater only fast-forwards; it will not push or merge.");
    info(`  Either push/PR your commits upstream, or reset with:`);
    info(`    git reset --hard ${upstream}   # WARNING: discards local commits`);
    process.exit(2);
  }

  if (behind === 0) {
    ok("already up to date");
  } else {
    ok(`${behind} commit(s) behind — fast-forward possible`);
  }

  // Interactive confirmation unless --yes
  if (behind > 0 && !flags.yes) {
    const range = gitSafe(`log --oneline HEAD..${upstream}`).out || "(no summary)";
    info("");
    info("Incoming commits:");
    for (const line of range.split("\n").slice(0, 20)) info(`    ${line}`);
    if (!(await confirm("\n  Proceed with platform update?"))) {
      info("  Aborted by user.");
      process.exit(0);
    }
  }

  // Step 5: optional pre-backup
  if (flags.preBackup) {
    section("Pre-backup");
    if (!(await fileExists(join(__dirname, "borg-backup.conf")))) {
      fail("borg-backup.conf not found.");
      info(`  borg is not configured on this host. See ${c.cyan}scripts/borg-backup.conf.example${c.reset}`);
      info("  Re-run without --pre-backup, or set up borg first.");
      process.exit(4);
    }
    info("running borg-backup.sh --skip-dumps --remote-only (may take a while)...");
    const r = spawnSync("bash", [BORG_BACKUP_SH, "--skip-dumps", "--remote-only"], {
      stdio: "inherit",
    });
    if (r.status !== 0) {
      fail(`pre-backup failed (exit ${r.status}).`);
      info("  System was NOT updated. Resolve backup issue or retry without --pre-backup.");
      process.exit(4);
    }
    ok("pre-backup complete");
  }

  // Step 6+7: capture OLD_HEAD, read OLD registry, fast-forward
  section("Pull");
  const OLD_HEAD = gitSafe("rev-parse HEAD").out;
  const OLD_HEAD_SHORT = OLD_HEAD.slice(0, 10);

  let oldRegistry = null;
  try {
    const oldRegText = git(`show ${OLD_HEAD}:container-registry.yaml`, { maxBuffer: 10 * 1024 * 1024 });
    oldRegistry = YAML.parse(oldRegText);
  } catch {
    // If old registry missing (fresh repo, untracked earlier, etc.), skip the diff.
  }

  if (behind > 0) {
    const ffResult = gitSafe(`merge --ff-only ${upstream}`);
    if (!ffResult.ok) {
      fail("Unexpected non-fast-forward after precondition check.");
      info(`  ${ffResult.err}`);
      info("  System unchanged at " + OLD_HEAD_SHORT);
      process.exit(1);
    }
  }
  const NEW_HEAD = gitSafe("rev-parse HEAD").out;
  const NEW_HEAD_SHORT = NEW_HEAD.slice(0, 10);
  if (OLD_HEAD === NEW_HEAD) {
    info(`HEAD unchanged at ${NEW_HEAD_SHORT}`);
  } else {
    ok(`fast-forwarded ${OLD_HEAD_SHORT} → ${NEW_HEAD_SHORT}`);
  }

  // Step 7: registry diff — collect added/removed containers
  const newRegistry = (await readYaml(REGISTRY_PATH)) || { containers: {} };
  const newContainers = new Set(Object.keys(newRegistry.containers || {}));
  const oldContainers = new Set(Object.keys(oldRegistry?.containers || {}));
  const added = [...newContainers].filter((n) => !oldContainers.has(n));
  const removed = [...oldContainers].filter((n) => !newContainers.has(n));

  const userConfig = (await readYaml(USER_CONFIG_PATH)) || { containers: {} };
  const orphanedEnabled = removed.filter((name) => {
    const uc = userConfig.containers?.[name];
    if (uc && uc.enabled !== undefined) return uc.enabled === true || uc.enabled === "true";
    return false; // if no user override, it was using the default — removed means it's gone
  });

  // Step 7b: module catalog sync — reconcile .modules/ with the (newly pulled)
  // module-catalog.yaml. Required entries auto-clone; optional ones, URL drift,
  // removals, and user-added sources are reported but never auto-mutated. A
  // clone failure for one entry is a warning, not a fatal error.
  section("Module catalog sync");
  const catalogSyncAdded = [];
  const catalogSyncFailed = [];
  try {
    const catalog = readCatalog(MODULE_CATALOG_PATH);
    const installedForCatalog = readInstalled(INSTALLED_MODULES_PATH);
    const report = reconcileCatalog(catalog, MODULES_DIR, installedForCatalog);

    for (const entry of report.toClone) {
      info(`cloning ${entry.name} (required) from ${entry.url}`);
      const { ok: cloneOk, error } = cloneModule(MODULES_DIR, entry.name, entry.url);
      if (cloneOk) {
        ok(`ADDED ${entry.name}`);
        catalogSyncAdded.push(entry.name);
      } else {
        warn(`failed to clone ${entry.name}: ${error?.trim?.() || error}`);
        catalogSyncFailed.push(entry.name);
      }
    }
    for (const entry of report.optional) {
      info(`OPTIONAL AVAILABLE ${entry.name} — run 'scripts/module.sh add-source ${entry.url}' to clone`);
    }
    for (const drift of report.urlDrift) {
      warn(`URL CHANGED ${drift.name}: catalog says ${drift.catalogUrl}, local remote is ${drift.localUrl} (not rewriting)`);
    }
    for (const name of report.removed) {
      warn(`REMOVED FROM CATALOG ${name} — still on disk at .modules/${name} (not deleting)`);
    }
    // User-added sources in installed-modules.yaml that aren't in the catalog
    // are the expected custom-source case — no output.
    if (
      report.toClone.length === 0 &&
      report.optional.length === 0 &&
      report.urlDrift.length === 0 &&
      report.removed.length === 0
    ) {
      ok("catalog in sync");
    }
  } catch (e) {
    warn(`catalog sync skipped: ${e.message}`);
  }

  // Step 8: run setup hooks for every installed container
  section("Setup hooks");
  const hookFailures = [];
  const hookContainers = [];
  for (const entry of Object.values(installed.modules || {})) {
    for (const containerName of entry.installed_containers || []) {
      hookContainers.push(containerName);
    }
  }
  if (hookContainers.length === 0) {
    info("no installed containers — skipping");
  } else {
    for (const containerName of hookContainers) {
      const r = spawnSync("node", [join(__dirname, "run-setup-hooks.js"), containerName], {
        stdio: "pipe",
        encoding: "utf8",
      });
      const out = (r.stdout || "") + (r.stderr || "");
      if (out.trim()) process.stdout.write(out);
      if (r.status !== 0) hookFailures.push(containerName);
    }
    if (hookFailures.length === 0) {
      ok(`all hooks ok (${hookContainers.length} container(s))`);
    } else if (flags.ignoreHooks) {
      warn(`${hookFailures.length} container(s) had hook failures: ${hookFailures.join(", ")} (--ignore-hooks)`);
    } else {
      fail(`${hookFailures.length} container(s) had hook failures: ${hookFailures.join(", ")}`);
      info("");
      info(`  ${c.bold}System is now at ${NEW_HEAD_SHORT}.${c.reset} Fix the failing hook(s) and re-run:`);
      for (const n of hookFailures) info(`    node scripts/run-setup-hooks.js ${n}`);
      info(`  Or re-run with ${c.cyan}--ignore-hooks${c.reset} to downgrade to a warning.`);
      printSummary({ OLD_HEAD_SHORT, NEW_HEAD_SHORT, added, removed, orphanedEnabled, hookFailures, pkgWarnings: [], dirtyModules, validationFailed: false, hookFailed: true });
      process.exit(3);
    }
  }

  // Step 9: host package advisory (never fails)
  section("Host packages");
  const pkgWarnings = [];
  for (const name of newContainers) {
    const def = newRegistry.containers[name];
    if (!def?.host_packages?.length) continue;
    const r = spawnSync("node", [join(__dirname, "check-host-packages.js"), name], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    if (out) pkgWarnings.push(out);
  }
  if (pkgWarnings.length === 0) {
    ok("no missing host packages");
  } else {
    for (const w of pkgWarnings) console.log(w);
  }

  // Step 10: env validation — THE load-bearing gate
  section("Env validation");
  const validate = spawnSync("node", [join(__dirname, "generate-env.js"), "--all", "--validate-only"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  const validateOut = (validate.stdout || "") + (validate.stderr || "");
  if (validate.status !== 0) {
    fail("env validation failed");
    if (validateOut.trim()) {
      for (const line of validateOut.trim().split("\n")) info(`  ${line}`);
    }
    info("");
    info(`  ${c.bold}System is now at ${NEW_HEAD_SHORT}.${c.reset} Fix the missing variables above and re-run:`);
    info(`    node scripts/generate-env.js --all --validate-only`);
    printSummary({ OLD_HEAD_SHORT, NEW_HEAD_SHORT, added, removed, orphanedEnabled, hookFailures, pkgWarnings, dirtyModules, validationFailed: true });
    process.exit(3);
  }
  ok("all enabled containers have required variables");

  // Step 11b: if anything under web-admin/ changed in this pull, schedule a
  // rebuild + PM2 restart. Detached with a short delay so this script's
  // response returns to the caller (CLI or the web admin's /api/platform/update
  // endpoint) before PM2 tears the backend down. The browser user will see
  // the success response, then a disconnect, then the new UI on reload.
  maybeRebuildWebAdmin(OLD_HEAD, NEW_HEAD);

  // Step 12: summary
  printSummary({ OLD_HEAD_SHORT, NEW_HEAD_SHORT, added, removed, orphanedEnabled, hookFailures, pkgWarnings, dirtyModules, validationFailed: false });
  process.exit(0);
}

function maybeRebuildWebAdmin(OLD_HEAD, NEW_HEAD) {
  if (!OLD_HEAD || !NEW_HEAD || OLD_HEAD === NEW_HEAD) return;
  let changed = false;
  try {
    const diff = git(`diff --name-only ${OLD_HEAD} ${NEW_HEAD}`, { maxBuffer: 4 * 1024 * 1024 });
    changed = diff.split("\n").some((f) => f.startsWith("web-admin/"));
  } catch (e) {
    warn(`web-admin diff check failed: ${e.message}`);
    return;
  }
  if (!changed) return;
  section("Web admin rebuild");
  info("web-admin/ changed — scheduling `start-web-admin.sh rebuild` in 5s (detached)");
  info("the web admin will rebuild the frontend and restart PM2 shortly");
  const script = join(__dirname, "start-web-admin.sh");
  const logFile = join(os.homedir(), "logs/web-admin-rebuild.log");
  try {
    // Double-forked via the bash subshell so the grandchild survives after
    // spawnSync returns. Output goes to a log file so "did it actually run?"
    // is answerable after the fact.
    spawnSync("bash", [
      "-c",
      `(sleep 5 && "${script}" rebuild) >> "${logFile}" 2>&1 </dev/null &`,
    ], { stdio: "ignore", detached: true });
    ok(`rebuild scheduled (log: ${logFile})`);
  } catch (e) {
    warn(`could not schedule web-admin rebuild: ${e.message}`);
  }
}

function printSummary({ OLD_HEAD_SHORT, NEW_HEAD_SHORT, added, removed, orphanedEnabled, hookFailures, pkgWarnings, dirtyModules, validationFailed, hookFailed }) {
  section("Summary");
  info(`${OLD_HEAD_SHORT} → ${NEW_HEAD_SHORT}`);
  if (added.length) info(`Added containers: ${added.join(", ")}`);
  if (removed.length) info(`Removed containers: ${removed.join(", ")}`);
  if (orphanedEnabled.length) {
    warn(`these enabled containers no longer exist upstream: ${orphanedEnabled.join(", ")}`);
    for (const name of orphanedEnabled) {
      info(`  Stop with: cd ${name} && docker compose down && scripts/module.sh uninstall ${name}`);
    }
  }
  if (hookFailures.length) {
    if (hookFailed) fail(`setup hook failures: ${hookFailures.join(", ")}`);
    else warn(`setup hook failures: ${hookFailures.join(", ")} (ignored via --ignore-hooks)`);
  }
  if (pkgWarnings.length) warn(`${pkgWarnings.length} container(s) need host packages (see above)`);
  if (dirtyModules.length) warn(`dirty module clones: ${dirtyModules.join(", ")}`);

  if (!validationFailed && !hookFailed) {
    info("");
    info(`${c.bold}Next step:${c.reset} run ${c.cyan}scripts/all-containers.sh --stop --start${c.reset} (or click "Restart All" in the web admin) to pick up compose changes.`);
  }
}

main().catch((e) => {
  console.error(`${c.red}update-platform.js crashed:${c.reset} ${e.stack || e.message}`);
  process.exit(1);
});
