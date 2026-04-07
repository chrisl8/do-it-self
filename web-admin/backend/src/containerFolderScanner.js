import { readdir, access, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CONTAINERS_PATH = join(homedir(), 'containers');
const START_ORDER_FILE = '.start-order';
const COMPOSE_FILE = 'compose.yaml';
const DEFAULT_SORT_ORDER = 'a';

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getStartOrder(folderPath) {
  const startOrderPath = join(folderPath, START_ORDER_FILE);
  try {
    const content = await readFile(startOrderPath, 'utf8');
    return content.trim() || DEFAULT_SORT_ORDER;
  } catch {
    return DEFAULT_SORT_ORDER;
  }
}

async function scanContainerFolders() {
  const stacks = {};

  try {
    const entries = await readdir(CONTAINERS_PATH, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const folderPath = join(CONTAINERS_PATH, entry.name);
      const hasCompose = await fileExists(join(folderPath, COMPOSE_FILE));

      if (!hasCompose) {
        continue;
      }

      const sortOrder = await getStartOrder(folderPath);

      stacks[entry.name] = {
        sortOrder,
        // Whether a container is "enabled" is determined by user-config.yaml
        // and the registry, not by filesystem markers. The frontend reads
        // configReady/configMissing from the validation status instead.
        isDisabled: false,
        folderPath,
      };
    }
  } catch (error) {
    console.error('Error scanning container folders:', error);
  }

  return stacks;
}

export default scanContainerFolders;
