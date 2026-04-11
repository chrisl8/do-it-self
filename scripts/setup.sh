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

BASE_PACKAGES=(git curl ca-certificates unzip jq)
ALL_PRESENT=true
for pkg in "${BASE_PACKAGES[@]}"; do
  if ! dpkg -s "$pkg" &>/dev/null; then
    ALL_PRESENT=false
    break
  fi
done
if [[ "$ALL_PRESENT" = false ]]; then
  step "Installing base packages"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${BASE_PACKAGES[@]}"
  ok "Base packages installed"
else
  ok "Base packages already installed"
fi

# yq (Mike Farah's Go version) is used by all-containers.sh for reliable
# YAML parsing of mount-permissions.yaml. The apt "yq" package is a
# different tool (Python jq wrapper), so install the Go binary directly.
if ! command -v yq &>/dev/null; then
  step "Installing yq"
  YQ_ARCH="amd64"
  if [[ "$(uname -m)" == "aarch64" ]]; then YQ_ARCH="arm64"; fi
  sudo curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}" -o /usr/local/bin/yq
  sudo chmod +x /usr/local/bin/yq
  ok "yq installed ($(yq --version))"
else
  ok "yq already installed"
fi

# ── Step 1b: Passwordless sudo for container operations ─────────────────
# all-containers.sh needs passwordless chown (mount permissions) and
# system-graceful-shutdown.sh needs passwordless shutdown. Use sudoers.d
# drop-in files — safer than editing /etc/sudoers, idempotent, easy to
# remove.
SUDOERS_CHOWN="/etc/sudoers.d/containers-chown"
SUDOERS_SHUTDOWN="/etc/sudoers.d/containers-shutdown"
CURRENT_USER=$(whoami)
if [[ ! -f "$SUDOERS_CHOWN" ]]; then
  step "Configuring passwordless sudo for chown"
  echo "${CURRENT_USER} ALL=(ALL) NOPASSWD: /usr/bin/chown" | sudo tee "$SUDOERS_CHOWN" > /dev/null
  sudo chmod 0440 "$SUDOERS_CHOWN"
  ok "Passwordless sudo for /usr/bin/chown configured"
else
  ok "Passwordless sudo for chown already configured"
fi
if [[ ! -f "$SUDOERS_SHUTDOWN" ]]; then
  step "Configuring passwordless sudo for shutdown"
  echo "${CURRENT_USER} ALL=(ALL) NOPASSWD: /usr/sbin/shutdown" | sudo tee "$SUDOERS_SHUTDOWN" > /dev/null
  sudo chmod 0440 "$SUDOERS_SHUTDOWN"
  ok "Passwordless sudo for /usr/sbin/shutdown configured"
else
  ok "Passwordless sudo for shutdown already configured"
fi

# ── Step 2: Docker ───────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  step "Installing Docker"
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

# Try to fetch TS_AUTHKEY and TS_API_TOKEN from Infisical if it's
# bootstrapped, the container is running, and the env vars aren't already
# set. Cheap and harmless to try.
if [[ "$INFISICAL_BOOTSTRAPPED" = true ]]; then
  if docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    if [[ -z "${TS_AUTHKEY:-}" ]]; then
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
    if [[ -z "${TS_API_TOKEN:-}" ]]; then
      FETCHED_TOKEN=$(infisical secrets get TS_API_TOKEN \
        --token="${INFISICAL_TOKEN}" \
        --projectId="${INFISICAL_PROJECT_ID}" \
        --path=/shared --env=prod \
        --domain="${INFISICAL_API_URL}" \
        --silent --plain 2>/dev/null) || true
      if [[ -n "$FETCHED_TOKEN" ]]; then
        TS_API_TOKEN="$FETCHED_TOKEN"
        ok "Fetched TS_API_TOKEN from Infisical"
      fi
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

# TS_API_TOKEN follows the same pattern: needed if Infisical doesn't have
# it yet, OR the env var wasn't provided and the fetch came back empty.
TS_API_TOKEN_NEEDED=false
if [[ "$INFISICAL_BOOTSTRAPPED" = false ]]; then
  TS_API_TOKEN_NEEDED=true
fi
if [[ -z "${TS_API_TOKEN:-}" ]]; then
  TS_API_TOKEN_NEEDED=true
fi

# If we need credentials and still don't have them, prompt or bail.
# Both are created on the same Tailscale admin page.
TS_KEYS_URL="https://login.tailscale.com/admin/settings/keys"
if [[ "$TS_AUTHKEY_NEEDED" = true && -z "${TS_AUTHKEY:-}" ]] || \
   [[ "$TS_API_TOKEN_NEEDED" = true && -z "${TS_API_TOKEN:-}" ]]; then
  if [[ -t 0 ]]; then
    printf "\n${YELLOW}Tailscale credentials required.${NC}\n"
    printf "Both are created at: ${TS_KEYS_URL}\n\n"
    printf "  1. Auth key: click 'Generate auth key'\n"
    printf "     Reusable=ON, Tags=tag:container\n"
    printf "  2. API token: scroll to 'API access tokens', click 'Generate'\n"
    printf "     (used for preflight checks that catch misconfigurations)\n\n"
    printf "Your tailnet ACL must define tag:container, and HTTPS Certificates\n"
    printf "must be enabled (DNS → HTTPS Certificates). See docs/TESTING.md.\n\n"
    if [[ "$TS_AUTHKEY_NEEDED" = true && -z "${TS_AUTHKEY:-}" ]]; then
      read -r -s -p "Tailscale auth key (input hidden): " TS_AUTHKEY
      echo
      if [[ -z "$TS_AUTHKEY" ]]; then
        printf "${RED}No auth key provided. Aborting.${NC}\n"
        exit 1
      fi
    fi
    if [[ "$TS_API_TOKEN_NEEDED" = true && -z "${TS_API_TOKEN:-}" ]]; then
      read -r -s -p "Tailscale API token (input hidden): " TS_API_TOKEN
      echo
      if [[ -z "$TS_API_TOKEN" ]]; then
        printf "${RED}No API token provided. Aborting.${NC}\n"
        exit 1
      fi
    fi
  else
    printf "${RED}Tailscale credentials required but not available.${NC}\n"
    printf "\n"
    printf "This project routes all service ingress through Tailscale.\n"
    printf "Both credentials are created at: ${TS_KEYS_URL}\n\n"
    printf "  1. Auth key: Reusable=ON, Tags=tag:container\n"
    printf "  2. API token: scroll to 'API access tokens', generate one\n\n"
    printf "Your tailnet ACL must define tag:container, and HTTPS Certificates\n"
    printf "must be enabled (DNS → HTTPS Certificates). See docs/TESTING.md.\n"
    printf "\n"
    printf "Then re-run with both in your environment, e.g.:\n"
    printf "  TS_AUTHKEY=tskey-auth-... TS_API_TOKEN=tskey-api-... bash %s\n" "$0"
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

# Detect host facts that step 11b will seed into Infisical. Done here (not
# inside the first-run-only block below) so subsequent runs can also reseed
# if Infisical was wiped or restored from a backup that's missing values.
DETECTED_HOSTNAME=$(hostname)
DETECTED_DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3)
DETECTED_DOCKER_GID=${DETECTED_DOCKER_GID:-985}

CONFIG_FILE="${SCRIPT_DIR}/user-config.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  step "Creating default user-config.yaml"
  ok "Detected hostname: ${DETECTED_HOSTNAME}"
  ok "Detected Docker GID: ${DETECTED_DOCKER_GID}"
  cat > "$CONFIG_FILE" << YAML
# Container Configuration
# Edit these values here or use the web-admin UI.
#
# Storage mounts: define one per disk or directory.
# All container volumes default to the first mount.
#
# Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME, DOCKER_GID) are NOT
# stored here. They live in Infisical at /shared and are injected into
# containers at start time by scripts/all-containers.sh. Set/rotate them
# via the web admin Configuration tab or \`infisical secrets set\`.

mounts:
  - path: "~/container-data"
    label: "Default"

containers: {}
YAML
  ok "Created ${CONFIG_FILE}"
else
  ok "user-config.yaml already exists, keeping it"
fi

# ── Step 8: Web-admin ───────────────────────────────────────────────────

step "Setting up web-admin"

# Create / update the backend .env. The web-admin backend listens on a Unix
# domain socket at web-admin/backend/sockets/web-admin.sock. The Tailscale
# Serve sidecar in web-admin/compose.yaml bind-mounts that directory and
# proxies https://admin.${TS_DOMAIN} to the socket. Filesystem permissions
# on the socket file (chmod 0660 set by server.js) are the access control:
# nothing on the LAN, the public internet, any other tailnet device, or any
# other docker container can reach the backend except via the sidecar. So
# the .env contains no HOST/PORT -- there's no TCP listener at all by
# default.
#
# DEBUG_TCP_PORT is an optional escape hatch: set it (e.g. to 3333) to
# also start a loopback-only TCP listener, useful for `curl
# http://127.0.0.1:3333/...` debugging from the host. Off by default.
WEB_ADMIN_ENV="${SCRIPT_DIR}/web-admin/backend/.env"
if [[ ! -f "$WEB_ADMIN_ENV" ]]; then
  cat > "$WEB_ADMIN_ENV" << 'WEBENV'
# Server configuration. The web-admin listens on a Unix domain socket at
# web-admin/backend/sockets/web-admin.sock. To also start a loopback TCP
# listener for local debugging from the host, uncomment DEBUG_TCP_PORT:
# DEBUG_TCP_PORT=3333

# Docker configuration
DOCKER_SOCKET_PATH=/var/run/docker.sock
CONTAINERS_DIR=~/containers
ICONS_BASE_DIR=~/containers/homepage/dashboard-icons
WEBENV
  ok "Created ${WEB_ADMIN_ENV}"
else
  # Existing .env from before the Unix-socket migration: strip stale
  # HOST= and PORT= lines if present. They're now ignored by server.js,
  # but leaving them around is confusing for future maintainers.
  if grep -qE '^(HOST|PORT)=' "$WEB_ADMIN_ENV"; then
    sed -i.bak -E '/^(HOST|PORT)=/d' "$WEB_ADMIN_ENV" && rm -f "${WEB_ADMIN_ENV}.bak"
    ok "Removed stale HOST/PORT lines from ${WEB_ADMIN_ENV}"
  fi
fi

# Ensure the sockets directory exists. server.js also mkdirs this on
# startup as a safety net, but creating it here means the bind mount in
# compose.yaml has something to mount even before PM2 has run.
mkdir -p "${SCRIPT_DIR}/web-admin/backend/sockets"
ok "Web admin backend will listen on Unix socket at web-admin/backend/sockets/web-admin.sock"

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

# ── Step 10: Module system setup ───────────────────────────────────────
# Clone default module sources and migrate existing containers if this is
# a legacy install. On a fresh install, this makes containers available to
# install via the web admin. On a legacy install, it records existing
# container directories as module-sourced. Idempotent.

step "Setting up module system"
"${SCRIPT_DIR}/scripts/migrate-to-modules.sh"
ok "Module system ready"

# ── Step 10b: Clone external git repositories ─────────────────────────
# Some containers build from external git repos (e.g. tsidp, valheim,
# minecraft) and homepage needs dashboard-icons for its tiles. These are
# gitignored and must be cloned before the containers can start. Repo URLs,
# branches, and shallow-clone flags are defined in container-registry.yaml
# under each container's git_repos field. Idempotent: existing repos get a
# `git pull` instead of a fresh clone.

step "Cloning external git repositories for enabled containers"
"${SCRIPT_DIR}/scripts/all-containers.sh" --update-git-repos
ok "External git repositories ready"

# ── Step 11: Infisical secret manager ───────────────────────────────────

# Skip Infisical bootstrap if it's already running and credentials exist.
# On a pre-built system, re-running setup-infisical.sh is slow (docker
# compose up -d checks images, waits for API) and unnecessary.
if [[ -f "${HOME}/credentials/infisical.env" ]] && \
   docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
  ok "Infisical already running with credentials"
else
  step "Setting up Infisical"
  "${SCRIPT_DIR}/scripts/setup-infisical.sh"
fi

# Seed shared variables into Infisical only if they aren't already the
# same value there. Infisical is the canonical (and ONLY) store for these
# four variables; this block seeds them on first run and is a no-op on
# subsequent runs. New values come from: TS_AUTHKEY (env/prompt/Infisical
# fetch above), TS_DOMAIN (auto-detected from `tailscale status` above),
# HOST_NAME and DOCKER_GID (detected in step 7).
seed_shared() {
  local name="$1"
  local value="$2"
  [[ -z "$value" ]] && return 0
  local existing
  existing=$(infisical secrets get "$name" \
    --token="${INFISICAL_TOKEN}" \
    --projectId="${INFISICAL_PROJECT_ID}" \
    --path=/shared --env=prod \
    --domain="${INFISICAL_API_URL}" \
    --silent --plain 2>/dev/null) || true
  if [[ "$existing" != "$value" ]]; then
    step "Writing ${name} to Infisical"
    infisical secrets set "${name}=${value}" \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path="/shared" \
      --env=prod \
      --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
    ok "${name} saved to Infisical"
  fi
}

if [[ -f "${HOME}/credentials/infisical.env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/credentials/infisical.env"

  seed_shared TS_AUTHKEY   "${TS_AUTHKEY:-}"
  seed_shared TS_API_TOKEN "${TS_API_TOKEN:-}"
  seed_shared TS_DOMAIN    "${TS_DOMAIN:-}"
  seed_shared HOST_NAME    "${DETECTED_HOSTNAME}"
  seed_shared DOCKER_GID   "${DETECTED_DOCKER_GID}"
fi

# ── Step 11b: Tailscale preflight ──────────────────────────────────────
# Run API-based checks BEFORE starting any container. Catches the most
# common Tailscale-side misconfigurations (ACL missing tag:container,
# auth key not reusable / expired / wrong-tag) with specific error
# messages and admin-console fix URLs.
if [[ -n "${TS_API_TOKEN:-}" ]]; then
  step "Running Tailscale preflight checks"
  export TS_API_TOKEN TS_AUTHKEY TS_DOMAIN
  set +e
  node "${SCRIPT_DIR}/scripts/lib/tailscale-preflight.js"
  PREFLIGHT_EXIT=$?
  set -e
  if [[ $PREFLIGHT_EXIT -ne 0 ]]; then
    printf "${RED}Fix the above Tailscale issues and re-run setup.${NC}\n"
    exit 1
  fi
  ok "Tailscale preflight passed"
fi

# ── Step 12: Start default-enabled containers ───────────────────────────
# Bring up the few containers that are enabled by default (infisical,
# homepage, the admin Tailscale sidecar, ...) so the URLs printed below
# are immediately live. Without this, a fresh setup would print URLs that
# 404 until the user manually ran all-containers.sh --start. Additional
# containers can be enabled later via the web admin's Configuration tab.

step "Starting default-enabled containers"
# SKIP_PREFLIGHT: setup.sh already ran the Tailscale preflight above,
# so tell all-containers.sh not to run it again.
SKIP_PREFLIGHT=true "${SCRIPT_DIR}/scripts/all-containers.sh" --start
ok "Default-enabled containers started"

# ── Step 12b: Install system cron jobs ──────────────────────────────────
# Core cron entries that every installation needs. Uses the same
# idempotent install_cron pattern as setup-borg-backup.sh: appends
# the line to crontab only if not already present.
install_cron() {
  local schedule="$1"
  local command="$2"
  local description="$3"
  if crontab -l 2>/dev/null | grep -qF "${command}"; then
    ok "Cron already installed: ${description}"
  else
    (crontab -l 2>/dev/null; echo "${schedule} ${command}") | crontab -
    ok "Installed cron: ${description}"
  fi
}

step "Installing system cron jobs"
install_cron "@reboot" "${SCRIPT_DIR}/scripts/system-cron-startup.sh" "Start containers on boot"
install_cron "*/15 * * * *" "${SCRIPT_DIR}/scripts/system-health-check.sh" "Health check every 15 minutes"
install_cron "0 */6 * * *" "${SCRIPT_DIR}/scripts/kopia-backup-check.sh" "Kopia backup freshness check every 6 hours"

# ── Step 13: End-to-end web admin reachability check ────────────────────
# Architectural regression guard. The web-admin backend listens on a Unix
# domain socket inside web-admin/backend/sockets/ and the Tailscale Serve
# sidecar (web-admin-ts) bind-mounts that directory and proxies
# https://admin.${TS_DOMAIN} to the socket. We learned the hard way that
# this whole pipeline is easy to break in subtle ways: bind on a TCP
# interface the sidecar can't see, mount the socket file directly instead
# of its directory (which pins the inode), forget to chmod the socket so
# the container can't open it, etc. Catch all of those here BEFORE the
# user goes looking for the dashboard URL and finds it broken.
#
# Each check has a clear error message pointing at the most likely cause
# so a future Claude session (or human) doesn't have to start from
# scratch.

step "Verifying web admin end-to-end"

WEB_ADMIN_SOCKET="${SCRIPT_DIR}/web-admin/backend/sockets/web-admin.sock"

# 1. The socket file should exist as a socket. server.js creates it on
#    startup; if it's missing the PM2 process either crashed or never ran.
if [[ ! -S "$WEB_ADMIN_SOCKET" ]]; then
  printf "${RED}  FAIL: web-admin socket not found at ${WEB_ADMIN_SOCKET}${NC}\n"
  printf "${RED}  Check 'pm2 logs Container Web Admin --lines 30' for backend errors.${NC}\n"
  printf "${RED}  Most likely: server.js failed to start (syntax error, missing dep, port conflict on the optional DEBUG_TCP_PORT).${NC}\n"
  exit 1
fi
ok "Backend socket exists at web-admin/backend/sockets/web-admin.sock"

# 2. The web-admin-ts sidecar should be running and reporting healthy.
if ! docker ps --filter "name=^web-admin-ts$" --filter "status=running" -q | grep -q .; then
  printf "${RED}  FAIL: web-admin-ts sidecar is not running${NC}\n"
  printf "${RED}  Check 'docker logs web-admin-ts' for the error.${NC}\n"
  printf "${RED}  Most likely: TS_AUTHKEY missing/expired/wrong-tag, or tag:container not in tailnet ACL.${NC}\n"
  exit 1
fi
ok "Sidecar web-admin-ts is running"

# 3. The sidecar should see the socket file via its bind mount. If this
#    fails, the bind mount in compose.yaml is wrong (most likely mounting
#    the socket file directly instead of its parent directory, which pins
#    the inode and breaks on every PM2 restart).
if ! docker exec web-admin-ts test -S /sockets/web-admin.sock 2>/dev/null; then
  printf "${RED}  FAIL: sidecar cannot see /sockets/web-admin.sock${NC}\n"
  printf "${RED}  Check the volumes block in web-admin/compose.yaml: it should mount${NC}\n"
  printf "${RED}  ./backend/sockets:/sockets (the directory, not the socket file).${NC}\n"
  exit 1
fi
ok "Sidecar sees the socket via bind mount"

# 4. Tailscale Serve inside the sidecar should be configured to proxy to
#    the unix socket. If TS_SERVE_CONFIG points somewhere else, this is
#    where we'd find out.
if ! docker exec web-admin-ts tailscale serve status --json 2>/dev/null \
     | grep -q 'unix:/sockets/web-admin.sock'; then
  printf "${RED}  FAIL: TS Serve not proxying to unix:/sockets/web-admin.sock${NC}\n"
  printf "${RED}  Check web-admin/tailscale-config/tailscale-config.json -- the Proxy field${NC}\n"
  printf "${RED}  should be \"unix:/sockets/web-admin.sock\".${NC}\n"
  exit 1
fi
ok "Tailscale Serve proxy targets the unix socket"

# 5. End-to-end: from this host (which is on the tailnet), HTTPS-fetch
#    the admin URL through Tailscale Serve. This is the same path the
#    user's browser will take. Retry for ~60s because TS Serve has to
#    provision a Let's Encrypt cert on first run, which can take a few
#    seconds.
if [[ -n "${TS_DOMAIN:-}" ]]; then
  ADMIN_URL="https://admin.${TS_DOMAIN}/api/config/infisical-status"
  printf "${YELLOW}  Probing ${ADMIN_URL} ...${NC}\n"
  REACHED=false
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -sf -m 5 -o /dev/null "$ADMIN_URL" 2>/dev/null; then
      REACHED=true
      break
    fi
    sleep 5
  done
  if [[ "$REACHED" = true ]]; then
    ok "https://admin.${TS_DOMAIN} is reachable end-to-end"
  else
    printf "${RED}  FAIL: https://admin.${TS_DOMAIN} did not respond after 60s${NC}\n"
    printf "${RED}  All four upstream checks above passed, so the failure is somewhere${NC}\n"
    printf "${RED}  in the tailnet routing layer. Most likely causes:${NC}\n"
    printf "${RED}    - HTTPS Certificates not enabled in your tailnet (Tailscale admin --> DNS).${NC}\n"
    printf "${RED}    - First-run cert provisioning still in progress; retry in a minute.${NC}\n"
    printf "${RED}    - This host isn't actually on the tailnet (run 'tailscale status').${NC}\n"
    printf "${RED}    - sidecar logs: docker logs web-admin-ts | grep -i 'serve\\|cert'${NC}\n"
    exit 1
  fi
else
  printf "${YELLOW}  Skipping tailnet probe (TS_DOMAIN not set this run).${NC}\n"
fi

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
echo "  3. Docker Status tab → click 'Start All Enabled' to bring them up"
echo ""
