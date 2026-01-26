import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONTAINERS_DIR = join(os.homedir(), 'containers');
const BASE_ICON_DIR = join(CONTAINERS_DIR, 'homepage/dashboard-icons');
const FALLBACK_ICON_DIR = join(CONTAINERS_DIR, 'homepage/icons');

const ICON_DIRS = {
  svg: join(BASE_ICON_DIR, 'svg'),
  png: join(BASE_ICON_DIR, 'png'),
  webp: join(BASE_ICON_DIR, 'webp'),
};

const AVAILABLE_ICONS = {};

for (const [ext, dir] of Object.entries(ICON_DIRS)) {
  AVAILABLE_ICONS[ext] = (() => {
    try {
      if (existsSync(dir)) {
        return new Set(readdirSync(dir).filter((f) => f.endsWith(`.${ext}`)));
      }
      return new Set();
    } catch {
      return new Set();
    }
  })();
}

const FALLBACK_ICONS = (() => {
  try {
    if (existsSync(FALLBACK_ICON_DIR)) {
      return new Set(readdirSync(FALLBACK_ICON_DIR));
    }
    return new Set();
  } catch {
    return new Set();
  }
})();

const SUBSTITUTIONS = (() => {
  try {
    const configPath = join(
      os.homedir(),
      '.config',
      'Metatron',
      'iconSubstitutions.json5',
    );
    const configContent = readFileSync(configPath, 'utf-8');
    return JSON.parse(configContent);
  } catch {
    return {};
  }
})();

function applySubstitution(name) {
  for (const [pattern, replacement] of Object.entries(SUBSTITUTIONS)) {
    if (pattern.startsWith('-') || pattern.startsWith('_')) {
      if (name.endsWith(pattern)) {
        return replacement;
      }
    } else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (name.startsWith(prefix)) {
        const suffix = name.slice(prefix.length);
        return replacement.slice(0, -1) + suffix;
      }
    } else if (name === pattern) {
      return replacement;
    }
  }
  return name;
}

function getIconFilename(name) {
  for (const ext of ['svg', 'png', 'webp']) {
    const filename = `${name}.${ext}`;
    if (AVAILABLE_ICONS[ext].has(filename)) {
      return filename;
    }
  }

  if (FALLBACK_ICONS.size > 0) {
    for (const ext of ['svg', 'png', 'webp']) {
      const filename = `${name}.${ext}`;
      if (FALLBACK_ICONS.has(filename)) {
        return `fallback/${filename}`;
      }
    }
  }

  return null;
}

function anyIconsAvailable() {
  return (
    AVAILABLE_ICONS.svg.size > 0 ||
    AVAILABLE_ICONS.png.size > 0 ||
    AVAILABLE_ICONS.webp.size > 0 ||
    FALLBACK_ICONS.size > 0
  );
}

function getContainerIconFilename(containerName) {
  if (!anyIconsAvailable()) {
    return null;
  }

  const substitutedName = applySubstitution(containerName);
  const substitutedIcon = getIconFilename(substitutedName);
  if (substitutedName !== containerName && substitutedIcon) {
    return substitutedIcon;
  }

  const SUFFIX_PATTERN = /[-_][^-_]+$/;

  const attempts = [];

  if (containerName.includes('_')) {
    const rightSide = containerName.split('_').pop();
    const rightIcon = getIconFilename(rightSide);
    if (rightSide && rightIcon) {
      return rightIcon;
    }
  }

  const dashCount = (containerName.match(/-/g) || []).length;
  if (dashCount === 1) {
    const rightSide = containerName.split('-').pop();
    const rightIcon = getIconFilename(rightSide);
    if (rightSide && rightIcon) {
      return rightIcon;
    }
  }

  attempts.push(containerName);
  attempts.push(containerName.replace(SUFFIX_PATTERN, ''));
  attempts.push(containerName.replace(/_/g, '-'));

  if (containerName.includes('-')) {
    attempts.push(containerName.replace(/-/g, '_'));

    const segments = containerName.split('-');
    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = segments.slice(0, i).join('-');
      attempts.push(prefix);
    }
  }

  if (containerName.includes('_')) {
    attempts.push(containerName.replace(/_/g, '-'));
  }

  if (dashCount > 1) {
    const afterFirst = containerName.split('-').slice(1).join('-');
    attempts.push(afterFirst);
    attempts.push(afterFirst.replace(/_/g, '-'));
  }

  for (const name of attempts) {
    const icon = getIconFilename(name);
    if (icon) {
      return icon;
    }
  }

  return null;
}

function getStackIcon(stackName, containerIcons = []) {
  if (!anyIconsAvailable()) {
    return null;
  }

  const substitutedName = applySubstitution(stackName);
  const substitutedIcon = getIconFilename(substitutedName);
  if (substitutedName !== stackName && substitutedIcon) {
    return substitutedIcon;
  }

  const stackIcon = getIconFilename(stackName);
  if (stackIcon) {
    return stackIcon;
  }

  const underscoreReplaced = stackName.replace(/_/g, '-');
  const underscoreIcon = getIconFilename(underscoreReplaced);
  if (underscoreReplaced !== stackName && underscoreIcon) {
    return underscoreIcon;
  }

  if (stackName.includes('-')) {
    const segments = stackName.split('-');
    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = segments.slice(0, i).join('-');
      const prefixIcon = getIconFilename(prefix);
      if (prefixIcon) {
        return prefixIcon;
      }
    }
  }

  for (const icon of containerIcons) {
    if (icon && getIconFilename(icon.replace(/\.[^.]+$/, '').split('/').pop())) {
      const iconName = icon.replace(/\.[^.]+$/, '');
      const fullIcon = getIconFilename(iconName);
      if (fullIcon) {
        return fullIcon;
      }
    }
  }

  return null;
}

export { getContainerIconFilename, getStackIcon };
export default getContainerIconFilename;
