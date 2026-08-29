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

export { getPendingUpdates, getPendingUpdateDetails };
