#!/bin/bash
set -e

# Migrate an existing installation to the module system.
# Called by setup.sh. Idempotent — safe to re-run.
#
# Detection: if installed-modules.yaml exists, we're already migrated.
# If container directories exist at the platform root without
# installed-modules.yaml, this is a legacy install that needs migration.
#
# For new installs (no containers present), this script clones the default
# module sources so containers are available to install via the web admin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLED_MODULES="${CONTAINERS_DIR}/installed-modules.yaml"
MODULE_CATALOG="${CONTAINERS_DIR}/module-catalog.yaml"
MODULES_DIR="${CONTAINERS_DIR}/.modules"

# Colors (inherit from setup.sh if available, else set them)
RED="${RED:-\033[0;31m}"
GREEN="${GREEN:-\033[0;32m}"
YELLOW="${YELLOW:-\033[0;33m}"
NC="${NC:-\033[0m}"

step() { printf "${YELLOW}  %s${NC}\n" "$1"; }
ok()   { printf "${GREEN}  ✓ %s${NC}\n" "$1"; }
warn() { printf "${YELLOW}  ⚠ %s${NC}\n" "$1"; }

# Run node from scripts/ dir so it can find scripts/node_modules/yaml
run_node() {
  (cd "${SCRIPT_DIR}" && node "$@")
}

# ── Already migrated? ──────────────────────────────────────────────────
if [[ -f "${INSTALLED_MODULES}" ]]; then
  ok "Module system already initialized (installed-modules.yaml exists)"
  exit 0
fi

# ── Clone default module sources ──────────────────────────────────────
# Parse module-catalog.yaml to get URLs. Uses node + yaml package.
if [[ ! -f "${MODULE_CATALOG}" ]]; then
  printf "${RED}  Error: module-catalog.yaml not found at ${MODULE_CATALOG}${NC}\n"
  exit 1
fi

step "Setting up module system"
mkdir -p "${MODULES_DIR}"

# Get catalog entries as tab-separated: name<TAB>url
CATALOG_ENTRIES=$(run_node -e '
import { readFileSync } from "fs";
import YAML from "yaml";
const catalog = YAML.parse(readFileSync(process.argv[1], "utf8"));
for (const [name, entry] of Object.entries(catalog.catalogs || {})) {
  console.log(name + "\t" + entry.url);
}
' "${MODULE_CATALOG}" 2>/dev/null) || true

if [[ -z "${CATALOG_ENTRIES}" ]]; then
  warn "No catalog entries found in module-catalog.yaml"
  exit 0
fi

# Clone each module source
while IFS=$'\t' read -r MODULE_NAME MODULE_URL; do
  if [[ -d "${MODULES_DIR}/${MODULE_NAME}" ]]; then
    ok "Module ${MODULE_NAME} already cloned"
    continue
  fi
  step "Cloning module: ${MODULE_NAME}"
  if git clone "${MODULE_URL}" "${MODULES_DIR}/${MODULE_NAME}" 2>/dev/null; then
    ok "Cloned ${MODULE_NAME}"
  else
    warn "Failed to clone ${MODULE_NAME} from ${MODULE_URL} — skipping"
  fi
done <<< "${CATALOG_ENTRIES}"

# ── Detect legacy install ─────────────────────────────────────────────
# Check if any container directories exist at the platform root
# (directories with a compose.yaml that aren't platform dirs)
PLATFORM_DIRS="scripts web-admin docs actual-budget-sync borgbackup .modules .git .vscode"
EXISTING_CONTAINERS=()

for DIR in "${CONTAINERS_DIR}"/*/; do
  DIR_NAME="$(basename "${DIR}")"

  # Skip platform directories
  SKIP=false
  for PD in ${PLATFORM_DIRS}; do
    if [[ "${DIR_NAME}" == "${PD}" ]]; then
      SKIP=true
      break
    fi
  done
  [[ "${SKIP}" == "true" ]] && continue

  # Must have a compose.yaml to be a container
  if [[ -f "${DIR}/compose.yaml" ]]; then
    EXISTING_CONTAINERS+=("${DIR_NAME}")
  fi
done

if [[ ${#EXISTING_CONTAINERS[@]} -eq 0 ]]; then
  # New install — just record the module sources, no containers to migrate
  step "New install detected — recording module sources"

  # Create minimal installed-modules.yaml with no installed containers
  run_node -e '
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import YAML from "yaml";

const modulesDir = process.argv[1];
const outPath = process.argv[2];
const modules = {};

for (const name of readdirSync(modulesDir)) {
  const modPath = join(modulesDir, name);
  if (!statSync(modPath).isDirectory()) continue;
  const yamlPath = join(modPath, "module.yaml");
  try {
    const meta = YAML.parse(readFileSync(yamlPath, "utf8"));
    const commit = execSync(`git -C "${modPath}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    modules[name] = {
      url: meta.url || "",
      commit,
      added: new Date().toISOString(),
      updated: new Date().toISOString(),
      installed_containers: [],
    };
  } catch { /* skip modules without valid module.yaml */ }
}

writeFileSync(outPath, YAML.stringify({ modules }, { lineWidth: 0 }));
console.log(`Recorded ${Object.keys(modules).length} module sources`);
' "${MODULES_DIR}" "${INSTALLED_MODULES}" 2>/dev/null

  ok "Module system initialized for new install"
  exit 0
fi

# ── Legacy install — match existing containers to modules ─────────────
step "Legacy install detected — migrating ${#EXISTING_CONTAINERS[*]} containers"

run_node -e '
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import YAML from "yaml";

const modulesDir = process.argv[1];
const registryPath = process.argv[2];
const installedPath = process.argv[3];
const existingContainers = process.argv.slice(4);

// Load all module.yaml files to build a container->module map
const containerToModule = new Map();
const modules = {};

for (const name of readdirSync(modulesDir)) {
  const modPath = join(modulesDir, name);
  if (!statSync(modPath).isDirectory()) continue;
  const yamlPath = join(modPath, "module.yaml");
  if (!existsSync(yamlPath)) continue;

  try {
    const meta = YAML.parse(readFileSync(yamlPath, "utf8"));
    const commit = execSync(`git -C "${modPath}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    modules[name] = {
      url: meta.url || "",
      commit,
      added: new Date().toISOString(),
      updated: new Date().toISOString(),
      installed_containers: [],
    };
    for (const containerName of Object.keys(meta.containers || {})) {
      containerToModule.set(containerName, name);
    }
  } catch { /* skip invalid modules */ }
}

// Match existing containers to modules
let matched = 0, personal = 0;
const registry = YAML.parse(readFileSync(registryPath, "utf8"));

for (const containerName of existingContainers) {
  const moduleName = containerToModule.get(containerName);
  if (moduleName && modules[moduleName]) {
    // Container found in a module — record as installed from that module
    modules[moduleName].installed_containers.push(containerName);
    if (registry.containers?.[containerName]) {
      registry.containers[containerName].source = moduleName;
    }
    matched++;
  } else {
    // Container not found in any module — mark as personal
    if (registry.containers?.[containerName]) {
      registry.containers[containerName].source = "personal";
    }
    personal++;
  }
}

// Sort installed_containers lists
for (const mod of Object.values(modules)) {
  mod.installed_containers.sort();
}

writeFileSync(installedPath, YAML.stringify({ modules }, { lineWidth: 0 }));
writeFileSync(registryPath, YAML.stringify(registry, { lineWidth: 0 }));

console.log(`Matched ${matched} containers to modules, ${personal} marked as personal`);
' "${MODULES_DIR}" "${CONTAINERS_DIR}/container-registry.yaml" "${INSTALLED_MODULES}" "${EXISTING_CONTAINERS[@]}" 2>/dev/null

ok "Migration complete — ${#EXISTING_CONTAINERS[*]} containers recorded"
