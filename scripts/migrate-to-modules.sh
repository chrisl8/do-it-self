#!/bin/bash
set -e

# Initialize the module system on a fresh install.
# Called by setup.sh. Idempotent — safe to re-run.
#
# On first run: clones every module listed in module-catalog.yaml into
# .modules/, then installs the containers marked enabled-by-default in
# container-registry.yaml (those without `default_disabled: true`). All
# other containers stay under .modules/ until the user installs them
# via the web admin Browse page or `scripts/module.sh install`.
#
# Detection: if installed-modules.yaml exists, the module system is
# already initialized and this script is a no-op.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLED_MODULES="${CONTAINERS_DIR}/installed-modules.yaml"
MODULE_CATALOG="${CONTAINERS_DIR}/module-catalog.yaml"
REGISTRY_PATH="${CONTAINERS_DIR}/container-registry.yaml"
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

# ── Already initialized? ──────────────────────────────────────────────
if [[ -f "${INSTALLED_MODULES}" ]]; then
  ok "Module system already initialized (installed-modules.yaml exists)"
  exit 0
fi

# ── Clone module sources ─────────────────────────────────────────────
if [[ ! -f "${MODULE_CATALOG}" ]]; then
  printf "${RED}  Error: module-catalog.yaml not found at ${MODULE_CATALOG}${NC}\n"
  exit 1
fi

step "Setting up module system"
mkdir -p "${MODULES_DIR}"

# Get catalog entries as tab-separated: name<TAB>url<TAB>required
# `required: true` entries auto-clone; others are logged as optional for
# the user to opt into via `scripts/module.sh add-source`.
CATALOG_ENTRIES=$(run_node -e '
import { readFileSync } from "fs";
import YAML from "yaml";
const catalog = YAML.parse(readFileSync(process.argv[1], "utf8"));
for (const [name, entry] of Object.entries(catalog.catalogs || {})) {
  console.log(name + "\t" + entry.url + "\t" + (entry.required === true ? "true" : "false"));
}
' "${MODULE_CATALOG}" 2>/dev/null) || true

if [[ -z "${CATALOG_ENTRIES}" ]]; then
  warn "No catalog entries found in module-catalog.yaml"
  exit 0
fi

while IFS=$'\t' read -r MODULE_NAME MODULE_URL MODULE_REQUIRED; do
  if [[ -d "${MODULES_DIR}/${MODULE_NAME}" ]]; then
    ok "Module ${MODULE_NAME} already cloned"
    continue
  fi
  if [[ "${MODULE_REQUIRED}" != "true" ]]; then
    ok "Optional module available: ${MODULE_NAME} — run 'scripts/module.sh add-source ${MODULE_URL}' to clone"
    continue
  fi
  step "Cloning module: ${MODULE_NAME}"
  if git clone "${MODULE_URL}" "${MODULES_DIR}/${MODULE_NAME}" 2>/dev/null; then
    ok "Cloned ${MODULE_NAME}"
  else
    warn "Failed to clone ${MODULE_NAME} from ${MODULE_URL} — skipping"
  fi
done <<< "${CATALOG_ENTRIES}"

# ── Install default-enabled containers ───────────────────────────────
# For each container in a cloned module, install it only when the
# registry entry does NOT set default_disabled: true. Invariant:
# install-by-default == enable-by-default. The rest of the catalog
# stays under .modules/ until the user picks it via the web admin
# Browse page or `scripts/module.sh install`.
step "Installing default-enabled containers"

DEFAULTS=$(run_node -e '
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

const [registryPath, modulesDir] = process.argv.slice(1);
const registry = YAML.parse(readFileSync(registryPath, "utf8"));
const regDefs = registry.containers || {};

for (const name of readdirSync(modulesDir)) {
  const modPath = join(modulesDir, name);
  if (!statSync(modPath).isDirectory()) continue;
  const yamlPath = join(modPath, "module.yaml");
  if (!existsSync(yamlPath)) continue;
  const meta = YAML.parse(readFileSync(yamlPath, "utf8"));
  for (const containerName of Object.keys(meta.containers || {})) {
    const reg = regDefs[containerName] || {};
    if (reg.default_disabled === true) continue;
    console.log(name + "\t" + containerName);
  }
}
' "${REGISTRY_PATH}" "${MODULES_DIR}" 2>/dev/null) || true

if [[ -z "${DEFAULTS}" ]]; then
  warn "No default-enabled containers found in any module"
else
  while IFS=$'\t' read -r MODULE_NAME CONTAINER_NAME; do
    [[ -z "${MODULE_NAME}" || -z "${CONTAINER_NAME}" ]] && continue
    step "Installing ${CONTAINER_NAME} from ${MODULE_NAME}"
    run_node "${SCRIPT_DIR}/module-helper.js" install "${MODULE_NAME}" "${CONTAINER_NAME}" 2>/dev/null || \
      warn "Failed to install ${CONTAINER_NAME}"
  done <<< "${DEFAULTS}"
fi

ok "Fresh install complete — use the web admin Browse page (or scripts/module.sh install) to add more"
