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

# Tailscale is a hard prerequisite. The web-admin and every container that
# uses_tailscale: true relies on TS_AUTHKEY being available. We need it now
# only when the host has not joined Tailscale yet, OR when Infisical has not
# yet been bootstrapped to hold the key (first-run install), OR when
# Infisical is bootstrapped but the secret is missing (recovery case).
#
# Resolution order (when needed):
#   1. Already in environment (e.g. TS_AUTHKEY=... bash setup.sh)
#   2. Fetched from Infisical (subsequent runs on a healthy host)
#   3. Interactive prompt with read -s, only if stdin is a TTY
#   4. Bail with the red error block

TS_HOST_JOINED=true
if ! tailscale status &>/dev/null || ! tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then
  TS_HOST_JOINED=false
fi

INFISICAL_BOOTSTRAPPED=false
if [[ -f "${HOME}/credentials/infisical.env" ]]; then
  INFISICAL_BOOTSTRAPPED=true
fi

# Try to fetch TS_AUTHKEY from Infisical if it's bootstrapped, the container
# is running, and the env var isn't already set. Cheap and harmless to try.
if [[ -z "${TS_AUTHKEY:-}" ]] && [[ "$INFISICAL_BOOTSTRAPPED" = true ]]; then
  if docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    FETCHED_KEY=$(infisical secrets get TS_AUTHKEY \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path=/shared --env=prod \
      --domain="${INFISICAL_API_URL}" \
      --silent --plain 2>/dev/null) || true
    if [[ -n "$FETCHED_KEY" ]]; then
      TS_AUTHKEY="$FETCHED_KEY"
      ok "Fetched TS_AUTHKEY from Infisical"
    fi
  fi
fi

# Decide whether we still need TS_AUTHKEY. Three reasons it would be needed:
#   (a) host needs to (re-)join Tailscale
#   (b) Infisical is not yet bootstrapped — step 11b will need to seed it
#   (c) Infisical is bootstrapped but the fetch above came back empty — recovery
TS_AUTHKEY_NEEDED=false
if [[ "$TS_HOST_JOINED" = false ]]; then
  TS_AUTHKEY_NEEDED=true
fi
if [[ "$INFISICAL_BOOTSTRAPPED" = false ]]; then
  TS_AUTHKEY_NEEDED=true
fi
if [[ "$INFISICAL_BOOTSTRAPPED" = true ]] && [[ -z "${TS_AUTHKEY:-}" ]]; then
  TS_AUTHKEY_NEEDED=true
fi

# If we need it and still don't have it, prompt or bail.
if [[ "$TS_AUTHKEY_NEEDED" = true ]] && [[ -z "${TS_AUTHKEY:-}" ]]; then
  if [[ -t 0 ]]; then
    printf "\n${YELLOW}Tailscale auth key required.${NC}\n"
    printf "Mint a reusable auth key tagged 'tag:container' at:\n"
    printf "  https://login.tailscale.com/admin/settings/keys\n"
    printf "Your tailnet ACL must define tag:container, and HTTPS Certificates\n"
    printf "must be enabled in the tailnet admin console for Tailscale Serve to\n"
    printf "issue Let's Encrypt certs. See docs/TESTING.md for the details.\n\n"
    read -r -s -p "Tailscale auth key (input hidden): " TS_AUTHKEY
    echo
    if [[ -z "$TS_AUTHKEY" ]]; then
      printf "${RED}No key provided. Aborting.${NC}\n"
      exit 1
    fi
  else
    printf "${RED}TS_AUTHKEY is required but not available.${NC}\n"
    printf "\n"
    printf "This project routes all service ingress through Tailscale.\n"
    printf "Mint a reusable auth key tagged 'tag:container' at:\n"
    printf "  https://login.tailscale.com/admin/settings/keys\n"
    printf "Your tailnet ACL must define tag:container, and HTTPS Certificates\n"
    printf "must be enabled in the tailnet admin console for Tailscale Serve to\n"
    printf "issue Let's Encrypt certs. See docs/TESTING.md for the details.\n"
    printf "\n"
    printf "Then re-run this script with TS_AUTHKEY in your environment, e.g.:\n"
    printf "  TS_AUTHKEY=tskey-auth-... bash %s\n" "$0"
    exit 1
  fi
fi

if [[ "$TS_HOST_JOINED" = false ]]; then
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
  TS_DOMAIN: "${TS_DOMAIN:-}"
  HOST_NAME: "${DETECTED_HOSTNAME}"
  DOCKER_GID: "${DETECTED_DOCKER_GID}"
  # TS_AUTHKEY is intentionally NOT stored here. It lives in Infisical at
  # /shared/TS_AUTHKEY and is injected into containers at start time by
  # scripts/all-containers.sh. Set/rotate via the web admin Configuration
  # tab or `infisical secrets set`.

containers: {}
YAML
  ok "Created ${CONFIG_FILE}"
else
  ok "user-config.yaml already exists, keeping it"
fi

# ── Step 8: Web-admin ───────────────────────────────────────────────────

step "Setting up web-admin"

# Create / update the backend .env. The web-admin backend is always bound
# to 127.0.0.1 -- the only network ingress is the Tailscale Serve sidecar
# in web-admin/compose.yaml, which proxies https://admin.${TS_DOMAIN} to
# http://host.docker.internal:3333. This makes it structurally impossible
# for the web admin (and the secrets it holds) to be reached from anywhere
# except the user's tailnet. WEB_ADMIN_BIND_HOST is still honored as an
# override for local debugging.
WEB_ADMIN_ENV="${SCRIPT_DIR}/web-admin/backend/.env"
WEB_ADMIN_HOST_VALUE="${WEB_ADMIN_BIND_HOST:-127.0.0.1}"
if [[ ! -f "$WEB_ADMIN_ENV" ]]; then
  cat > "$WEB_ADMIN_ENV" << WEBENV
# Server configuration
PORT=3333
HOST=${WEB_ADMIN_HOST_VALUE}

# Docker configuration
DOCKER_SOCKET_PATH=/var/run/docker.sock
CONTAINERS_DIR=~/containers
ICONS_BASE_DIR=~/containers/homepage/dashboard-icons
WEBENV
  ok "Created ${WEB_ADMIN_ENV}"
else
  # Existing .env: ensure HOST is set to a localhost-only bind. Idempotent;
  # rewrites the line if it's missing or set to anything else.
  if ! grep -q "^HOST=${WEB_ADMIN_HOST_VALUE}$" "$WEB_ADMIN_ENV"; then
    sed -i.bak '/^HOST=/d' "$WEB_ADMIN_ENV" && rm -f "${WEB_ADMIN_ENV}.bak"
    printf "HOST=%s\n" "${WEB_ADMIN_HOST_VALUE}" >> "$WEB_ADMIN_ENV"
    ok "Set HOST=${WEB_ADMIN_HOST_VALUE} in ${WEB_ADMIN_ENV}"
  fi
fi
ok "Web admin backend bound to ${WEB_ADMIN_HOST_VALUE}"

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

# Write the Tailscale credentials to Infisical only if they aren't already
# the same value there. Infisical is the canonical store for TS_AUTHKEY;
# this block seeds it on first run and is a no-op on subsequent runs.
if [[ -f "${HOME}/credentials/infisical.env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/credentials/infisical.env"

  if [[ -n "${TS_AUTHKEY:-}" ]]; then
    EXISTING_KEY=$(infisical secrets get TS_AUTHKEY \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path=/shared --env=prod \
      --domain="${INFISICAL_API_URL}" \
      --silent --plain 2>/dev/null) || true
    if [[ "$EXISTING_KEY" != "$TS_AUTHKEY" ]]; then
      step "Writing TS_AUTHKEY to Infisical"
      infisical secrets set "TS_AUTHKEY=${TS_AUTHKEY}" \
        --token="${INFISICAL_TOKEN}" \
        --projectId="${INFISICAL_PROJECT_ID}" \
        --path="/shared" \
        --env=prod \
        --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
      ok "TS_AUTHKEY saved to Infisical"
    fi
  fi

  if [[ -n "${TS_DOMAIN:-}" ]]; then
    EXISTING_DOMAIN=$(infisical secrets get TS_DOMAIN \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path=/shared --env=prod \
      --domain="${INFISICAL_API_URL}" \
      --silent --plain 2>/dev/null) || true
    if [[ "$EXISTING_DOMAIN" != "$TS_DOMAIN" ]]; then
      step "Writing TS_DOMAIN to Infisical"
      infisical secrets set "TS_DOMAIN=${TS_DOMAIN}" \
        --token="${INFISICAL_TOKEN}" \
        --projectId="${INFISICAL_PROJECT_ID}" \
        --path="/shared" \
        --env=prod \
        --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
      ok "TS_DOMAIN saved to Infisical"
    fi
  fi
fi

# ── Step 12: Start default-enabled containers ───────────────────────────
# Bring up the few containers that are enabled by default (infisical,
# homepage, the admin Tailscale sidecar, ...) so the URLs printed below
# are immediately live. Without this, a fresh setup would print URLs that
# 404 until the user manually ran all-containers.sh --start. Additional
# containers can be enabled later via the web admin's Configuration tab.

step "Starting default-enabled containers"
"${SCRIPT_DIR}/scripts/all-containers.sh" --start
ok "Default-enabled containers started"

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
printf "${GREEN}Setup Complete!${NC}\n"
echo "============================================"
echo ""
if [[ -n "${TS_DOMAIN:-}" ]]; then
  echo "Web admin: https://admin.${TS_DOMAIN}"
  echo "Dashboard: https://console.${TS_DOMAIN}"
  echo ""
  echo "Both URLs are reachable from any device signed in to your tailnet."
  echo "If your browser can't reach them, confirm the device is on the same"
  echo "tailnet as this host."
else
  echo "Setup completed but no Tailscale domain was detected."
  echo "Run 'tailscale status' on this host to confirm the tailnet state,"
  echo "then re-run this script."
fi
echo ""
echo "Next steps:"
echo "  1. Open https://admin.${TS_DOMAIN:-<your-tailnet>} in your browser"
echo "  2. Configuration tab → enable any additional containers you want and"
echo "     fill in their per-container variables"
echo "  3. Bring newly-enabled containers up via the web admin or by running"
echo "     'bash ~/containers/scripts/all-containers.sh --start'"
echo ""
