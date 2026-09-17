import fs from "fs";
import path from "path";

// Resolve the diun script volume base directory from its generated .env file.
// The diun compose.yaml uses ${VOL_DIUN_SCRIPT}/container-mounts/diun/script:/script,
// and VOL_DIUN_SCRIPT is set by scripts/generate-env.js based on container-registry.yaml.
function getDiunScriptDir() {
  const envFilePath = path.join(process.env.HOME, "containers", "diun", ".env");

  if (!fs.existsSync(envFilePath)) {
    console.error("DIUN .env file not found:", envFilePath);
    return null;
  }

  let volDiunScript;
  for (const line of fs.readFileSync(envFilePath, "utf8").split("\n")) {
    const match = line.match(/^\s*VOL_DIUN_SCRIPT\s*=\s*(.*?)\s*$/);
    if (match) {
      volDiunScript = match[1].replace(/^["']|["']$/g, "");
      break;
    }
  }

  const base = volDiunScript || path.join(process.env.HOME, "container-data");
  return path.join(base, "container-mounts/diun/script");
}

function getPendingUpdatesFilePath() {
  const dir = getDiunScriptDir();
  return dir ? path.join(dir, "pendingContainerUpdates.txt") : null;
}

function getPendingUpdateDetailsFilePath() {
  const dir = getDiunScriptDir();
  return dir ? path.join(dir, "pendingContainerUpdateDetails.jsonl") : null;
}

function getPendingUpdates() {
  const filePath = getPendingUpdatesFilePath();

  if (!filePath) {
    console.log("[pendingUpdates] No file path found, returning empty Set");
    return new Set();
  }

  try {
    if (!fs.existsSync(filePath)) {
      console.log("[pendingUpdates] File does not exist, returning empty Set");
      return new Set();
    }

    const content = fs.readFileSync(filePath, "utf8");

    const pendingSet = new Set(
      content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    return pendingSet;
  } catch (error) {
    console.error(
      "[pendingUpdates] Error reading pending updates file:",
      error,
    );
    return new Set();
  }
}

// Purely informational: which specific image(s) triggered each stack's
// pending-update flag, e.g. { "minecraft-java": ["minecraft-server:latest"] }.
// Independent of getPendingUpdates() -- never used to decide what to update,
// only to explain the "Update" badge in the UI.
function getPendingUpdateDetails() {
  const filePath = getPendingUpdateDetailsFilePath();
  const details = new Map();

  if (!filePath || !fs.existsSync(filePath)) {
    return details;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const { stack, image } = JSON.parse(trimmed);
        if (!stack || !image) continue;
        if (!details.has(stack)) {
          details.set(stack, []);
        }
        const images = details.get(stack);
        if (!images.includes(image)) {
          images.push(image);
        }
      } catch {
        console.warn(
          "[pendingUpdates] Skipping malformed detail line:",
          trimmed,
        );
      }
    }
  } catch (error) {
    console.error(
      "[pendingUpdates] Error reading pending update details file:",
      error,
    );
  }

  return details;
}

// Self-healing counterpart to the invalidPendingUpdates check in
// dockerStatus.js: rewrites pendingContainerUpdates.txt (and the details
// jsonl) to drop any stack name that isn't in the current set of container
// folders. Covers every flavor of stale entry -- an uninstalled container
// (module-helper.js's prunePendingUpdates only catches this going forward,
// on uninstall), a stack rename, or diunUpdate.sh falling back to a raw
// image name that was never a real stack (e.g. "nginx-unprivileged" instead
// of the folder that used it) -- without requiring anyone to hand-edit the
// file. Best-effort: errors are logged, never thrown.
function pruneInvalidPendingUpdates(validStackNames) {
  const filePath = getPendingUpdatesFilePath();
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const trimmedLines = lines.map((line) => line.trim());
    const removed = [
      ...new Set(
        trimmedLines.filter(
          (line) => line.length > 0 && !validStackNames.has(line),
        ),
      ),
    ];
    if (removed.length === 0) return [];

    const kept = trimmedLines.filter(
      (line) => line.length === 0 || validStackNames.has(line),
    );
    fs.writeFileSync(filePath, kept.join("\n"));
    console.log(
      "[pendingUpdates] Pruned invalid stack names from updates file:",
      removed,
    );

    const detailsFilePath = getPendingUpdateDetailsFilePath();
    if (detailsFilePath && fs.existsSync(detailsFilePath)) {
      const detailLines = fs.readFileSync(detailsFilePath, "utf8").split("\n");
      const keptDetails = detailLines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        try {
          const { stack } = JSON.parse(trimmed);
          return !stack || validStackNames.has(stack);
        } catch {
          return true;
        }
      });
      if (keptDetails.length !== detailLines.length) {
        fs.writeFileSync(detailsFilePath, keptDetails.join("\n"));
      }
    }

    return removed;
  } catch (error) {
    console.error(
      "[pendingUpdates] Error pruning invalid pending updates:",
      error,
    );
    return [];
  }
}

// Clears one stack's entry from pendingContainerUpdates.txt (and its
// pendingUpdateDetails.jsonl lines) after a web-admin-triggered upgrade
// succeeds. Without this, the DIUN-sourced "Update" badge stays stuck
// forever on any host where scripts/update-containers-from-diun-list.sh
// (the only other code path that clears these files) isn't in the
// crontab -- diunUpdate.sh only ever appends, and the versionDrift "Recheck
// versions" button is a completely separate signal (registry tag lookups),
// so it can never clear a stale DIUN flag either. Best-effort: errors are
// logged, never thrown.
function clearPendingUpdate(stackName) {
  const filePath = getPendingUpdatesFilePath();
  if (!filePath || !fs.existsSync(filePath)) return;

  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const kept = lines.filter((line) => line.trim() !== stackName);
    if (kept.length !== lines.length) {
      fs.writeFileSync(filePath, kept.join("\n"));
      console.log(`[pendingUpdates] Cleared ${stackName} from updates file`);
    }

    const detailsFilePath = getPendingUpdateDetailsFilePath();
    if (detailsFilePath && fs.existsSync(detailsFilePath)) {
      const detailLines = fs.readFileSync(detailsFilePath, "utf8").split("\n");
      const keptDetails = detailLines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        try {
          const { stack } = JSON.parse(trimmed);
          return stack !== stackName;
        } catch {
          return true;
        }
      });
      if (keptDetails.length !== detailLines.length) {
        fs.writeFileSync(detailsFilePath, keptDetails.join("\n"));
      }
    }
  } catch (error) {
    console.error(
      `[pendingUpdates] Error clearing pending update for ${stackName}:`,
      error,
    );
  }
}

export {
  getPendingUpdates,
  getPendingUpdateDetails,
  pruneInvalidPendingUpdates,
  clearPendingUpdate,
};
