import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPendingUpdatesFilePath() {
  const composeFilePath = path.join(
    process.env.HOME,
    "containers",
    "diun",
    "compose.yaml",
  );

  if (!fs.existsSync(composeFilePath)) {
    console.error("DIUN compose file not found:", composeFilePath);
    return null;
  }

  const content = fs.readFileSync(composeFilePath, "utf8");
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*-\s*(\/[^:]+):\/script.*/);
    if (match) {
      return path.join(match[1], "pendingContainerUpdates.txt");
    }
  }

  console.error("Could not find script volume mapping in DIUN compose file");
  return null;
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
