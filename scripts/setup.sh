#!/bin/bash
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "=== Container Configuration Setup ==="
echo ""

# 1. Check prerequisites
MISSING=false

check_prereq() {
  if ! command -v "$1" &>/dev/null; then
    printf "${RED}MISSING: %s${NC}\n" "$1"
    MISSING=true
    return 1
  fi
  printf "${GREEN}  Found: %s${NC}\n" "$1"
  return 0
}

echo "Checking prerequisites..."
check_prereq docker || true
check_prereq node || true
check_prereq npm || true

if [[ "$MISSING" == true ]]; then
  echo ""
  echo "Please install missing prerequisites before continuing."
  echo "  Docker: https://docs.docker.com/engine/install/"
  echo "  Node.js: https://nodejs.org/ (recommend using fnm or n)"
  exit 1
fi

echo ""

# 2. Install PM2 if missing
if ! command -v pm2 &>/dev/null; then
  printf "${YELLOW}Installing PM2 globally...${NC}\n"
  npm install -g pm2
fi

# 3. Create user-config.yaml with defaults if it doesn't exist
CONFIG_FILE="${SCRIPT_DIR}/user-config.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  printf "${YELLOW}Creating default user-config.yaml...${NC}\n"
  DETECTED_HOSTNAME=$(hostname)
  DETECTED_DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3)
  DETECTED_DOCKER_GID=${DETECTED_DOCKER_GID:-985}
  printf "${GREEN}  Detected hostname: %s${NC}\n" "$DETECTED_HOSTNAME"
  printf "${GREEN}  Detected Docker GID: %s${NC}\n" "$DETECTED_DOCKER_GID"
  cat > "$CONFIG_FILE" << YAML
# Container Configuration
# Edit these values here or use the web-admin UI.
#
# Storage mounts: define one per disk or directory.
# All container volumes default to the first mount.

mounts:
  - path: "~/container-data"
    label: "Default"

shared:
  TS_AUTHKEY: ""
  TS_DOMAIN: ""
  HOST_NAME: "${DETECTED_HOSTNAME}"
  DOCKER_GID: "${DETECTED_DOCKER_GID}"

containers: {}
YAML
  printf "${GREEN}Created %s${NC}\n" "$CONFIG_FILE"
else
  printf "${GREEN}user-config.yaml already exists, keeping it.${NC}\n"
fi

echo ""

# 4. Install web-admin dependencies and build
printf "${YELLOW}Setting up web-admin...${NC}\n"
cd "${SCRIPT_DIR}/web-admin"
npm run install:all
npm run build

echo ""

# 5. Start web-admin via PM2
printf "${YELLOW}Starting web-admin...${NC}\n"
"${SCRIPT_DIR}/scripts/start-web-admin.sh" start

# 6. Determine web-admin port
WEB_ADMIN_PORT=$(grep "^PORT=" "${SCRIPT_DIR}/web-admin/backend/.env" 2>/dev/null | cut -d= -f2)
WEB_ADMIN_PORT=${WEB_ADMIN_PORT:-3333}

echo ""
echo "============================================"
printf "${GREEN}Setup Complete!${NC}\n"
echo "============================================"
echo ""
echo "Web admin is running at: http://localhost:${WEB_ADMIN_PORT}"
echo ""
echo "Next steps:"
echo "  1. Open the web admin URL in your browser"
echo "  2. Go to the Configuration tab"
echo "  3. Set your shared variables (DATA_ROOT, TS_AUTHKEY, TS_DOMAIN)"
echo "  4. Enable the containers you want to run"
echo "  5. Set required variables for each enabled container"
echo "  6. Click 'Generate All .env Files'"
echo "  7. Run: scripts/all-containers.sh --start"
echo ""
