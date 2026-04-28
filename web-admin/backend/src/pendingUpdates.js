import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPendingUpdatesFilePath() {
  // Resolve the diun script volume path from its generated .env file.
  // The diun compose.yaml uses ${VOL_DIUN_SCRIPT}/container-mounts/diun/script:/script,
  // and VOL_DIUN_SCRIPT is set by scripts/generate-env.js based on container-registry.yaml.
  const envFilePath = path.join(
    process.env.HOME,
    "containers",
    "diun",
    ".env",
  );

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
  return path.join(base, "container-mounts/diun/script/pendingContainerUpdates.txt");
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

export { getPendingUpdates };
