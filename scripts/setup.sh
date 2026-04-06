#!/bin/bash
# Self-hosted container platform setup.
# Installs all dependencies on a bare Ubuntu system and configures everything.
# Idempotent -- safe to run multiple times.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/chrisl8/do-it-self/main/scripts/setup.sh | bash
#   OR
#   git clone https://github.com/chrisl8/do-it-self.git ~/containers && ~/containers/scripts/setup.sh
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

REPO_URL="https://github.com/chrisl8/do-it-self.git"
CONTAINERS_DIR="${HOME}/containers"

# Avoid interactive prompts during apt installs (works in cloud-init contexts)
export DEBIAN_FRONTEND=noninteractive

step() {
  printf "\n${YELLOW}=== %s ===${NC}\n" "$1"
}

ok() {
  printf "${GREEN}  %s${NC}\n" "$1"
}

# ── Step 0: If running via curl|bash, clone the repo and re-exec ─────────

if [[ ! -d "${CONTAINERS_DIR}/scripts" ]]; then
  step "Cloning repository"

  # Need git to clone
  if ! command -v git &>/dev/null; then
    printf "${YELLOW}Installing git...${NC}\n"
    sudo apt-get update -qq
    sudo apt-get install -y -qq git
  fi

  git clone "${REPO_URL}" "${CONTAINERS_DIR}"
  ok "Cloned to ${CONTAINERS_DIR}"

  # Re-exec from the cloned copy so all relative paths work
  exec "${CONTAINERS_DIR}/scripts/setup.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "============================================"
echo "  Self-Hosted Container Platform Setup"
echo "============================================"

# ── Step 1: Base packages ────────────────────────────────────────────────
# Tools needed by later install steps. fnm needs unzip, Docker repo needs
# ca-certificates and curl, etc. Install everything up front so failures
# happen early and clearly.

step "Installing base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates unzip jq
ok "Base packages installed"

# ── Step 2: Docker ───────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  step "Installing Docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker installed"
else
  ok "Docker already installed"
fi

# Add current user to docker group if needed.
# Re-exec under `sg docker` so the new group membership applies to the rest
# of this script (group changes don't normally take effect mid-session).
if ! groups | grep -q '\bdocker\b'; then
  step "Adding $USER to docker group"
  sudo usermod -aG docker "$USER"
  ok "Added to docker group; re-executing with new group membership..."
  exec sg docker "$0 $*"
fi

# ── Step 3: Node.js (via fnm) ───────────────────────────────────────────

if ! command -v node &>/dev/null; then
  step "Installing Node.js via fnm"
  curl -fsSL https://fnm.vercel.app/install | bash
  # Source fnm into current shell
  FNM_DIR="${HOME}/.local/share/fnm"
  if [[ ! -d "$FNM_DIR" ]] || ! command -v "${FNM_DIR}/fnm" &>/dev/null; then
    printf "${RED}fnm install failed.${NC}\n"
    exit 1
  fi
  export PATH="${FNM_DIR}:${PATH}"
  eval "$(fnm env)"
  fnm install --lts
  fnm use lts-latest
  if ! command -v node &>/dev/null; then
    printf "${RED}node still not in PATH after fnm install.${NC}\n"
    exit 1
  fi

  # The fnm installer adds itself to ~/.bashrc, but that only loads for
  # interactive shells. Add it to ~/.profile too so login shells (like
  # ssh sessions and PM2 child processes) pick up node.
  PROFILE_FILE="${HOME}/.profile"
  if ! grep -q 'fnm env' "$PROFILE_FILE" 2>/dev/null; then
    cat >> "$PROFILE_FILE" << 'PROFILE'

# fnm
FNM_PATH="$HOME/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env)"
fi
PROFILE
  fi

  ok "Node.js $(node --version) installed"
else
  ok "Node.js $(node --version) already installed"
fi

# Ensure fnm is in PATH for this session even if already installed
FNM_DIR="${HOME}/.local/share/fnm"
if [[ -d "$FNM_DIR" ]] && command -v fnm &>/dev/null; then
  eval "$(fnm env)" 2>/dev/null || true
fi

# ── Step 4: PM2 ─────────────────────────────────────────────────────────

if ! command -v pm2 &>/dev/null; then
  step "Installing PM2"
  npm install -g pm2
  ok "PM2 installed"
else
  ok "PM2 already installed"
fi

# ── Step 5: Infisical CLI ───────────────────────────────────────────────

if ! command -v infisical &>/dev/null; then
  step "Installing Infisical CLI"
  curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo -E bash
  sudo apt-get update -qq
  sudo apt-get install -y -qq infisical
  ok "Infisical CLI installed"
else
  ok "Infisical CLI already installed"
fi

# ── Step 6: Tailscale ───────────────────────────────────────────────────

if ! command -v tailscale &>/dev/null; then
  step "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
  ok "Tailscale installed"
else
  ok "Tailscale already installed"
fi

# ── Step 7: User configuration ──────────────────────────────────────────

CONFIG_FILE="${SCRIPT_DIR}/user-config.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  step "Creating default user-config.yaml"
  DETECTED_HOSTNAME=$(hostname)
  DETECTED_DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3)
  DETECTED_DOCKER_GID=${DETECTED_DOCKER_GID:-985}
  ok "Detected hostname: ${DETECTED_HOSTNAME}"
  ok "Detected Docker GID: ${DETECTED_DOCKER_GID}"
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
  ok "Created ${CONFIG_FILE}"
else
  ok "user-config.yaml already exists, keeping it"
fi

# ── Step 8: Web-admin ───────────────────────────────────────────────────

step "Setting up web-admin"
cd "${SCRIPT_DIR}/web-admin"
npm run install:all 2>&1 | tail -1
npm run build 2>&1 | tail -1
ok "Web-admin built"

"${SCRIPT_DIR}/scripts/start-web-admin.sh" start
ok "Web-admin started"

# ── Step 9: Infisical secret manager ────────────────────────────────────

step "Setting up Infisical"
"${SCRIPT_DIR}/scripts/setup-infisical.sh"

# ── Done ─────────────────────────────────────────────────────────────────

WEB_ADMIN_PORT=$(grep "^PORT=" "${SCRIPT_DIR}/web-admin/backend/.env" 2>/dev/null | cut -d= -f2)
WEB_ADMIN_PORT=${WEB_ADMIN_PORT:-3333}

echo ""
echo "============================================"
printf "${GREEN}Setup Complete!${NC}\n"
echo "============================================"
echo ""
echo "Web admin: http://localhost:${WEB_ADMIN_PORT}"
echo ""
echo "Next steps:"
echo "  1. Open the web admin in your browser"
echo "  2. Go to the Configuration tab"
echo "  3. Set your storage mount paths"
echo "  4. Enter your Tailscale auth key (TS_AUTHKEY) and domain (TS_DOMAIN)"
echo "  5. Enable the containers you want"
echo "  6. Run: ~/containers/scripts/all-containers.sh --start"
echo ""
