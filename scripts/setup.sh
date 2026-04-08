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

# If TS_AUTHKEY env var is set (e.g. from cloud-init for testing), join Tailscale now.
# Then auto-detect TS_DOMAIN from `tailscale status`.
if [[ -n "${TS_AUTHKEY:-}" ]]; then
  if ! tailscale status &>/dev/null || ! tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then
    step "Joining Tailscale via provided TS_AUTHKEY"
    sudo tailscale up --authkey="$TS_AUTHKEY" --hostname="$(hostname)" --ssh --accept-routes 2>&1 | tail -3
    ok "Joined Tailscale"
  fi
  # Auto-detect TS_DOMAIN if not already provided
  if [[ -z "${TS_DOMAIN:-}" ]]; then
    DETECTED_DOMAIN=$(tailscale status --json 2>/dev/null | grep -oP '"MagicDNSSuffix":\s*"\K[^"]+' | head -1)
    if [[ -n "$DETECTED_DOMAIN" ]]; then
      TS_DOMAIN="$DETECTED_DOMAIN"
      ok "Detected Tailscale domain: ${TS_DOMAIN}"
    fi
  fi
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
  TS_AUTHKEY: "${TS_AUTHKEY:-}"
  TS_DOMAIN: "${TS_DOMAIN:-}"
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

# Create the backend .env file if missing (PM2 ecosystem config requires it).
# WEB_ADMIN_BIND_HOST is an optional env var passed in by hetzner-test.sh's
# cloud-init to lock the test VM down to localhost-only. When unset, the
# .env omits HOST and server.js falls back to 0.0.0.0 (current default for
# real installs -- see PORTABILITY_ISSUES.md "Security" for the broader
# discussion of what the default should be for new installs).
WEB_ADMIN_ENV="${SCRIPT_DIR}/web-admin/backend/.env"
if [[ ! -f "$WEB_ADMIN_ENV" ]]; then
  cat > "$WEB_ADMIN_ENV" << WEBENV
# Server configuration
PORT=3333
${WEB_ADMIN_BIND_HOST:+HOST=${WEB_ADMIN_BIND_HOST}}

# Docker configuration
DOCKER_SOCKET_PATH=/var/run/docker.sock
CONTAINERS_DIR=~/containers
ICONS_BASE_DIR=~/containers/homepage/dashboard-icons
WEBENV
  ok "Created ${WEB_ADMIN_ENV}"
  if [[ -n "${WEB_ADMIN_BIND_HOST:-}" ]]; then
    ok "Web admin bound to ${WEB_ADMIN_BIND_HOST} (test mode)"
  fi
fi

cd "${SCRIPT_DIR}/web-admin"
npm run install:all 2>&1 | tail -1
npm run build 2>&1 | tail -1
ok "Web-admin built"

"${SCRIPT_DIR}/scripts/start-web-admin.sh" start
ok "Web-admin started"

# ── Step 9: Scripts dependencies ────────────────────────────────────────
# A handful of scripts in scripts/ need npm packages (currently just the
# `yaml` parser used by merge-homepage-config.js). Install them into
# scripts/node_modules/ so those scripts can run from a fresh clone.

step "Installing scripts dependencies"
if [[ -f "${SCRIPT_DIR}/scripts/package.json" ]]; then
  (cd "${SCRIPT_DIR}/scripts" && npm install --silent 2>&1 | tail -1)
  ok "scripts/node_modules ready"
else
  ok "scripts/package.json not found, skipping"
fi

# ── Step 10: Homepage dashboard-icons library ───────────────────────────
# The homepage dashboard uses icons from homarr-labs/dashboard-icons for
# the container tiles (referenced in compose.yaml labels as
# homepage.icon=/dashboard-icons/...). Cloned shallow so it's smaller than
# the full 2GB repo. Updated on subsequent runs via
# `scripts/all-containers.sh --update-git-repos`.

DASHBOARD_ICONS_DIR="${SCRIPT_DIR}/homepage/dashboard-icons"
if [[ ! -d "${DASHBOARD_ICONS_DIR}/.git" ]]; then
  step "Cloning dashboard-icons (for homepage)"
  git clone --depth 1 https://github.com/homarr-labs/dashboard-icons.git "${DASHBOARD_ICONS_DIR}" 2>&1 | tail -2
  ok "dashboard-icons cloned to ${DASHBOARD_ICONS_DIR}"
else
  ok "dashboard-icons already present"
fi

# ── Step 11: Infisical secret manager ───────────────────────────────────

step "Setting up Infisical"
"${SCRIPT_DIR}/scripts/setup-infisical.sh"

# If we joined Tailscale earlier, write the credentials to Infisical so that
# `infisical run` can inject them into containers that need them.
if [[ -n "${TS_AUTHKEY:-}" ]] && [[ -f "${HOME}/credentials/infisical.env" ]]; then
  step "Writing Tailscale credentials to Infisical"
  # shellcheck disable=SC1091
  source "${HOME}/credentials/infisical.env"
  infisical secrets set "TS_AUTHKEY=${TS_AUTHKEY}" \
    --token="${INFISICAL_TOKEN}" \
    --projectId="${INFISICAL_PROJECT_ID}" \
    --path="/shared" \
    --env=prod \
    --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
  if [[ -n "${TS_DOMAIN:-}" ]]; then
    infisical secrets set "TS_DOMAIN=${TS_DOMAIN}" \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path="/shared" \
      --env=prod \
      --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
  fi
  ok "Tailscale credentials saved to Infisical"
fi

# ── Done ─────────────────────────────────────────────────────────────────

WEB_ADMIN_PORT=$(grep "^PORT=" "${SCRIPT_DIR}/web-admin/backend/.env" 2>/dev/null | cut -d= -f2)
WEB_ADMIN_PORT=${WEB_ADMIN_PORT:-3333}
WEB_ADMIN_BIND=$(grep "^HOST=" "${SCRIPT_DIR}/web-admin/backend/.env" 2>/dev/null | cut -d= -f2)

# Detect the primary network IP for a usable URL when ssh'd into a remote box
NETWORK_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "============================================"
printf "${GREEN}Setup Complete!${NC}\n"
echo "============================================"
echo ""
echo "Web admin:"
echo "  Local:   http://localhost:${WEB_ADMIN_PORT}"
# Only advertise the network URL if the web admin is actually bound to it.
# When HOST=127.0.0.1 (the test mode), the network IP isn't serving anything.
if [[ -z "$WEB_ADMIN_BIND" || "$WEB_ADMIN_BIND" == "0.0.0.0" ]] && [[ -n "$NETWORK_IP" && "$NETWORK_IP" != "127.0.0.1" ]]; then
  echo "  Network: http://${NETWORK_IP}:${WEB_ADMIN_PORT}"
fi
# Once Tailscale is configured, homepage runs as the user's main "console"
# at console.<tailnet>.ts.net. Show that URL when we know the tailnet.
if [[ -n "${TS_DOMAIN:-}" ]]; then
  echo ""
  echo "Dashboard (after Tailscale + first-time container start):"
  echo "  https://console.${TS_DOMAIN}"
fi
echo ""
echo "Next steps:"
echo "  1. Open the web admin in your browser (URL above)"
echo "  2. Configuration tab → set storage mount paths and Tailscale auth key"
echo "     (homepage and infisical are enabled by default; enable any others)"
echo "  3. Click Start to bring containers up"
echo "  4. Open your dashboard once homepage finishes starting"
echo ""
