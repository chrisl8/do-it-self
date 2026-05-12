#!/bin/bash
set -euo pipefail

# ============================================================
# CONFIGURATION
# ============================================================
# Config is loaded from an external file so the script can be
# updated via scp without overwriting secrets.
#
# First run:  Copy backup-pi.conf.example to the Pi, fill in
#             values, then run:
#               sudo bash setup-backup-pi.sh /path/to/backup-pi.conf
#
# Re-runs:    The config file is copied to /etc/backup-pi.conf
#             on first run. After that, just scp the script and:
#               sudo bash setup-backup-pi.sh
# ============================================================

CONFIG_FILE="${1:-/etc/backup-pi.conf}"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file not found: $CONFIG_FILE"
    echo "Usage: sudo bash setup-backup-pi.sh [/path/to/backup-pi.conf]"
    echo "See setup-backup-pi.conf.example for the template."
    exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

# Defaults for optional config values (the conf example sets these explicitly,
# but ${VAR:-default} keeps older conf files working without edits).
ADMIN_USER="${ADMIN_USER:-piadmin}"
SMTP_HOST="${SMTP_HOST:-smtp.fastmail.com}"
SMTP_PORT="${SMTP_PORT:-587}"

# Persist config to /etc for future re-runs (skip if already there)
if [[ "$CONFIG_FILE" != "/etc/backup-pi.conf" ]]; then
    cp "$CONFIG_FILE" /etc/backup-pi.conf
    chmod 600 /etc/backup-pi.conf
    echo "[INFO] Config saved to /etc/backup-pi.conf"
fi

# ============================================================
# DRIVE REPLACEMENT
# ============================================================
# When swapping the USB drive, just update the config file
# (if needed) and re-run this script. It handles formatting,
# repo init, and service restart idempotently.
# The config file survives drive replacement — it's on the
# SD card at /etc/backup-pi.conf, not the USB drive.
#
# What to know:
#   - Tailscale auth key expiry doesn't matter — Tailscale is
#     already connected on the Pi, so it stays up.
#   - SSH keys survive drive replacement (they're on the SD card,
#     not the USB drive). No re-keying needed.
#   - A NEW borg encryption key is generated for the new repo.
#     You MUST save it again from /home/"${ADMIN_USER}"/borg-key-backup.txt.
#   - A NEW Kopia TLS cert is generated. The Kopia client
#     must reconnect using the new certificate fingerprint.
#   - All backup data starts from scratch — previous archives
#     and snapshots lived on the old drive.
# ============================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${GREEN}=== $1 ===${NC}"; }

# ============================================================
# STEP 0: Preflight checks
# ============================================================
log_step "Preflight checks"

if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (use: sudo bash setup-backup-pi.sh)"
    exit 1
fi

# Warn when a stray backup-pi.conf in someone's home dir disagrees with
# /etc/backup-pi.conf. Common footgun: user edits the home-dir copy left
# behind by the first install and re-runs with no arg, expecting the edits
# to apply — but a no-arg run reads /etc, not the home-dir copy.
if [[ "$CONFIG_FILE" == "/etc/backup-pi.conf" ]]; then
    candidate_homes=()
    [[ -n "${SUDO_USER:-}" ]] && candidate_homes+=("$(getent passwd "$SUDO_USER" | cut -d: -f6)")
    [[ -n "${HOME:-}" && "$HOME" != "/root" ]] && candidate_homes+=("$HOME")
    for h in "${candidate_homes[@]}"; do
        stray="$h/backup-pi.conf"
        if [[ -f "$stray" ]] && ! diff -q "$stray" /etc/backup-pi.conf >/dev/null 2>&1; then
            log_warn "Stray conf detected: $stray differs from /etc/backup-pi.conf"
            log_warn "This run is reading /etc/backup-pi.conf — your edits to $stray are NOT applied."
            log_warn "To apply them: sudo bash $0 \"$stray\"   (then: rm \"$stray\")"
        fi
    done
fi

# Check for unconfigured values
UNCONFIGURED=0
for var in TAILSCALE_AUTH_KEY BORG_REPO_PASSPHRASE KOPIA_REPO_PASSWORD \
           KOPIA_SERVER_CONTROL_PASSWORD KOPIA_USER_PASSWORD \
           ALERT_EMAIL SMTP_USER SMTP_PASSWORD BORG_CLIENT_SSH_PUBKEY; do
    if [[ "${!var:-CONFIGURE_ME}" == "CONFIGURE_ME" ]]; then
        log_error "$var is still set to CONFIGURE_ME"
        UNCONFIGURED=1
    fi
done
if [[ $UNCONFIGURED -eq 1 ]]; then
    log_error "Fill in all CONFIGURE_ME values in your config file before running"
    exit 1
fi

# Validate drive device exists
if [[ ! -b "$DRIVE_DEVICE" ]]; then
    log_error "Drive device $DRIVE_DEVICE does not exist"
    log_error "Plug in the USB drive and check with: lsblk"
    exit 1
fi

# Make sure we're not about to format the boot device
BOOT_DEVICE=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//' | sed 's/p[0-9]*$//')
if [[ "$DRIVE_DEVICE" == "$BOOT_DEVICE" ]]; then
    log_error "$DRIVE_DEVICE is the boot device! Aborting."
    exit 1
fi

log_info "Drive $DRIVE_DEVICE found (not the boot device)"
lsblk "$DRIVE_DEVICE" --output NAME,SIZE,MODEL,SERIAL 2>/dev/null || true
log_info "All preflight checks passed"

# ============================================================
# STEP 1: System update
# ============================================================
log_step "System update"

apt update
DEBIAN_FRONTEND=noninteractive apt upgrade -y
log_info "System updated"

# ============================================================
# STEP 2: Install packages
# ============================================================
log_step "Install packages"

DEBIAN_FRONTEND=noninteractive apt install -y \
    borgbackup openssh-server ufw smartmontools msmtp msmtp-mta mailutils unattended-upgrades

# Install Kopia from official repo
if ! command -v kopia &>/dev/null; then
    log_info "Adding Kopia apt repository"
    curl -s https://kopia.io/signing-key | gpg --dearmor -o /usr/share/keyrings/kopia-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" \
        > /etc/apt/sources.list.d/kopia.list
    apt update
    DEBIAN_FRONTEND=noninteractive apt install -y kopia
    log_info "Kopia installed"
else
    log_info "Kopia already installed"
fi

log_info "All packages installed"

# ============================================================
# STEP 3: Format and mount USB drive
# ============================================================
log_step "USB drive setup"

PARTITION="${DRIVE_DEVICE}1"

if blkid -L "$DRIVE_LABEL" &>/dev/null; then
    log_info "Drive already has label '$DRIVE_LABEL' — skipping format"
else
    log_warn "Formatting $DRIVE_DEVICE (all data will be lost)"
    parted "$DRIVE_DEVICE" --script mklabel gpt
    parted "$DRIVE_DEVICE" --script mkpart primary ext4 0% 100%
    sleep 2  # Wait for partition to appear
    mkfs.ext4 -L "$DRIVE_LABEL" "$PARTITION"
    log_info "Drive formatted with label '$DRIVE_LABEL'"
fi

# Add fstab entry if not present
if ! grep -q "LABEL=$DRIVE_LABEL" /etc/fstab; then
    echo "LABEL=$DRIVE_LABEL $MOUNT_POINT ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
    log_info "Added fstab entry"
else
    log_info "Fstab entry already exists"
fi

# Mount
mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
    mount -a
    log_info "Drive mounted at $MOUNT_POINT"
else
    log_info "Drive already mounted at $MOUNT_POINT"
fi

# Create directory structure
mkdir -p "$MOUNT_POINT"/{borg,kopia,health}
log_info "Directory structure created"

# ============================================================
# STEP 4: Create service users
# ============================================================
log_step "Create service users"

if id borg &>/dev/null; then
    log_info "User 'borg' already exists"
else
    useradd -m -s /bin/bash borg
    log_info "Created user 'borg'"
fi

if id kopiauser &>/dev/null; then
    log_info "User 'kopiauser' already exists"
else
    useradd -m -s /bin/bash kopiauser
    log_info "Created user 'kopiauser'"
fi

# ============================================================
# STEP 5: Set directory permissions
# ============================================================
log_step "Set directory permissions"

chown borg:borg "$MOUNT_POINT/borg"
chown kopiauser:kopiauser "$MOUNT_POINT/kopia"
chown "${ADMIN_USER}":"${ADMIN_USER}" "$MOUNT_POINT/health"
log_info "Permissions set"

# ============================================================
# STEP 5b: SSH key auth for borg user
# ============================================================
log_step "SSH key auth for borg user"

mkdir -p /home/borg/.ssh
echo "$BORG_CLIENT_SSH_PUBKEY" > /home/borg/.ssh/authorized_keys
chown -R borg:borg /home/borg/.ssh
chmod 700 /home/borg/.ssh
chmod 600 /home/borg/.ssh/authorized_keys
log_info "SSH authorized_keys installed for borg user"

# ============================================================
# STEP 6: Install and configure Tailscale
# ============================================================
log_step "Tailscale setup"

if ! command -v tailscale &>/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
    log_info "Tailscale installed"
else
    log_info "Tailscale already installed"
fi

# Check if already connected
if tailscale status &>/dev/null; then
    log_info "Tailscale already connected"
else
    tailscale up --auth-key="$TAILSCALE_AUTH_KEY" --hostname="$TAILSCALE_HOSTNAME"
    log_info "Tailscale connected as $TAILSCALE_HOSTNAME"
fi

# Disable Tailscale SSH — use OpenSSH with key auth for unattended borg backups
tailscale set --ssh=false

# ============================================================
# STEP 7: Get Tailscale IP
# ============================================================
TAILSCALE_IP=$(tailscale ip -4)
log_info "Tailscale IP: $TAILSCALE_IP"

# ============================================================
# STEP 8: Configure firewall
# ============================================================
log_step "Firewall setup"

ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
# DHCP — needed to get an IP from the host's router
ufw allow in on eth0 from any port 67 to any port 68 proto udp
ufw --force enable
log_info "Firewall configured (Tailscale-only access)"

# ============================================================
# STEP 9: Initialize Borg repo
# ============================================================
log_step "Borg repository setup"

# Track whether we just initialized the repo this run, so the key export
# (and its scary warning) only happens on first install or drive replacement —
# not on every routine re-run when the user has already saved the key.
BORG_KEY_EXPORTED_THIS_RUN=false

if [[ -d "$BORG_REPO_PATH/data" ]]; then
    log_info "Borg repo already exists at $BORG_REPO_PATH"
else
    sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
        borg init --encryption=repokey-blake2 "$BORG_REPO_PATH"
    log_info "Borg repo initialized"

    # Export the encryption key to a file the user can copy off the Pi.
    # Done once, at repo creation. The key never changes for an existing repo,
    # so a re-export on every run would just recreate a file the user already
    # saved (or deliberately deleted). To re-export manually any time:
    #   sudo -u borg BORG_PASSPHRASE='<passphrase>' \
    #       borg key export /mnt/backup/borg /tmp/borg-key.txt
    sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
        borg key export "$BORG_REPO_PATH" /home/borg/borg-key-backup.txt
    cp /home/borg/borg-key-backup.txt /home/"${ADMIN_USER}"/borg-key-backup.txt
    rm /home/borg/borg-key-backup.txt
    chown "${ADMIN_USER}":"${ADMIN_USER}" /home/"${ADMIN_USER}"/borg-key-backup.txt
    chmod 600 /home/"${ADMIN_USER}"/borg-key-backup.txt
    log_warn "Borg key exported to /home/${ADMIN_USER}/borg-key-backup.txt"
    log_warn ">>> SAVE THIS KEY SECURELY AND DELETE FROM PI <<<"
    BORG_KEY_EXPORTED_THIS_RUN=true
fi

# ============================================================
# STEP 10: Borg restricted shell wrapper
# ============================================================
log_step "Borg append-only restriction"

cat > /usr/local/bin/borg-serve-only.sh << 'BORGWRAPPER'
#!/bin/bash
# Restricted shell for borg user — only allows borg serve in append-only mode.
# This is the borg user's login shell, so any SSH connection as borg
# runs borg serve unconditionally.
exec borg serve --restrict-to-path /mnt/backup/borg --append-only
BORGWRAPPER

chmod 755 /usr/local/bin/borg-serve-only.sh

# Add to /etc/shells if not present (required for chsh)
if ! grep -q "/usr/local/bin/borg-serve-only.sh" /etc/shells; then
    echo "/usr/local/bin/borg-serve-only.sh" >> /etc/shells
fi

chsh -s /usr/local/bin/borg-serve-only.sh borg
log_info "Borg user restricted to append-only borg serve"

# ============================================================
# STEP 11: Initialize Kopia repo
# ============================================================
log_step "Kopia repository setup"

KOPIA_CONFIG_DIR="/home/kopiauser/.config/kopia"

if [[ -d "$KOPIA_REPO_PATH/kopia.repository" ]] || [[ -f "$KOPIA_REPO_PATH/kopia.repository.f" ]]; then
    log_info "Kopia repo already exists at $KOPIA_REPO_PATH"
else
    sudo -u kopiauser kopia repository create filesystem \
        --path "$KOPIA_REPO_PATH" \
        --password "$KOPIA_REPO_PASSWORD"
    log_info "Kopia repo initialized"
fi

# ============================================================
# STEP 12: Kopia server systemd unit
# ============================================================
log_step "Kopia server setup"

# Generate TLS cert if it doesn't exist yet (persists across restarts).
# Track whether we generated a new cert this run, so the summary can show
# the >>> RECORD THE FINGERPRINT <<< warning only when it actually matters.
# A re-run reuses the existing cert; clients are already configured with
# its fingerprint and don't need to do anything.
KOPIA_CERT_FILE="/home/kopiauser/.config/kopia/server.cert"
KOPIA_KEY_FILE="/home/kopiauser/.config/kopia/server.key"
KOPIA_CERT_GENERATED_THIS_RUN=false
if [[ ! -f "$KOPIA_CERT_FILE" ]]; then
    sudo -u kopiauser openssl req -x509 -newkey rsa:4096 \
        -keyout "$KOPIA_KEY_FILE" -out "$KOPIA_CERT_FILE" \
        -days 3650 -nodes -subj "/CN=kopia-server" 2>/dev/null
    log_info "Generated TLS certificate"
    KOPIA_CERT_GENERATED_THIS_RUN=true
else
    log_info "TLS certificate already exists, reusing"
fi

cat > /etc/systemd/system/kopia-server.service << EOF
[Unit]
Description=Kopia Repository Server
After=network-online.target tailscaled.service
Wants=network-online.target
RequiresMountsFor=$MOUNT_POINT

[Service]
Type=simple
User=kopiauser
Group=kopiauser
ExecStart=/usr/bin/kopia server start \
    --address=${TAILSCALE_IP}:${KOPIA_SERVER_PORT} \
    --tls-cert-file /home/kopiauser/.config/kopia/server.cert \
    --tls-key-file /home/kopiauser/.config/kopia/server.key \
    --server-control-password=${KOPIA_SERVER_CONTROL_PASSWORD}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable kopia-server
systemctl restart kopia-server
log_info "Kopia server running on https://${TAILSCALE_IP}:${KOPIA_SERVER_PORT}"

# Wait for server to become ready
sleep 5

# Capture cert fingerprint
KOPIA_FINGERPRINT=""
if sudo -u kopiauser kopia server status --address="https://${TAILSCALE_IP}:${KOPIA_SERVER_PORT}" 2>/dev/null; then
    KOPIA_FINGERPRINT=$(sudo -u kopiauser kopia server status \
        --address="https://${TAILSCALE_IP}:${KOPIA_SERVER_PORT}" 2>&1 | grep -i fingerprint | head -1 || true)
fi

# Try to get fingerprint from the TLS cert file
if [[ -z "$KOPIA_FINGERPRINT" ]]; then
    CERT_FILE="/home/kopiauser/.config/kopia/server.cert"
    if [[ -n "$CERT_FILE" ]]; then
        KOPIA_FINGERPRINT=$(openssl x509 -in "$CERT_FILE" -noout -fingerprint -sha256 2>/dev/null \
            | sed 's/sha256 Fingerprint=//i' | tr -d ':' | tr '[:upper:]' '[:lower:]' || true)
    fi
fi

if [[ -n "$KOPIA_FINGERPRINT" ]]; then
    log_info "Kopia TLS fingerprint: $KOPIA_FINGERPRINT"
else
    log_warn "Could not automatically capture Kopia TLS fingerprint"
    log_warn "Check the Kopia server logs: journalctl -u kopia-server"
fi

# ============================================================
# STEP 13: Add Kopia server user
# ============================================================
log_step "Kopia server user"

# Connect to the repo first (needed for server user management)
sudo -u kopiauser kopia repository connect filesystem \
    --path "$KOPIA_REPO_PATH" \
    --password "$KOPIA_REPO_PASSWORD" 2>/dev/null || true

sudo -u kopiauser kopia server user add "$KOPIA_USER_NAME" \
    --user-password "$KOPIA_USER_PASSWORD" 2>/dev/null || true

# Restart server to pick up user changes
systemctl restart kopia-server
log_info "Kopia server user '$KOPIA_USER_NAME' configured"

# ============================================================
# STEP 14: Configure msmtp for email alerts
# ============================================================
log_step "Email configuration (msmtp)"

cat > /etc/msmtprc << EOF
# SMTP configuration for backup alerts
defaults
auth           on
tls            on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile        /var/log/msmtp.log

account        smtp
host           ${SMTP_HOST}
port           ${SMTP_PORT}
from           ${ALERT_EMAIL}
user           ${SMTP_USER}
password       ${SMTP_PASSWORD}

account default : smtp
EOF

chmod 600 /etc/msmtprc
log_info "msmtp configured for ${SMTP_HOST}"

# ============================================================
# STEP 15: Health check script
# ============================================================
log_step "Health check script"

cat > /home/"${ADMIN_USER}"/check-health.sh << 'HEALTHSCRIPT'
#!/bin/bash

ALERT_EMAIL="__ALERT_EMAIL__"
HEALTHCHECK_URL="__HEALTHCHECK_URL__"
MOUNT_POINT="__MOUNT_POINT__"
BORG_REPO_PATH="__BORG_REPO_PATH__"
BORG_PASSPHRASE="__BORG_PASSPHRASE__"

ALERTS=()

# Check if backup drive is mounted
if ! mountpoint -q "$MOUNT_POINT"; then
    ALERTS+=("CRITICAL: Backup drive not mounted at $MOUNT_POINT")
fi

# Check disk usage (percentage)
if mountpoint -q "$MOUNT_POINT"; then
    USAGE=$(df --output=pcent "$MOUNT_POINT" | tail -1 | tr -d ' %')
    if [ "$USAGE" -gt 85 ]; then
        ALERTS+=("WARNING: Backup drive at ${USAGE}% capacity")
    fi

    # Check absolute free space
    FREE_KB=$(df --output=avail "$MOUNT_POINT" | tail -1 | tr -d ' ')
    FREE_GB=$((FREE_KB / 1048576))
    if [ "$FREE_GB" -lt 500 ]; then
        ALERTS+=("WARNING: Backup drive has only ${FREE_GB} GB free")
    fi
fi

# Check borg repo freshness (48 hour threshold)
if mountpoint -q "$MOUNT_POINT" && [ -d "$BORG_REPO_PATH/data" ]; then
    LAST_ARCHIVE=$(sudo -u borg BORG_PASSPHRASE="$BORG_PASSPHRASE" \
        borg list --last 1 --format '{time}' "$BORG_REPO_PATH" 2>/dev/null)
    if [ -n "$LAST_ARCHIVE" ]; then
        LAST_EPOCH=$(date -d "$LAST_ARCHIVE" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        AGE_HOURS=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))
        if [ "$AGE_HOURS" -gt 48 ]; then
            ALERTS+=("WARNING: Last borg archive is ${AGE_HOURS} hours old (threshold: 48h)")
        fi
    fi
fi

# Check kopia server is running
if ! systemctl is-active --quiet kopia-server; then
    ALERTS+=("WARNING: Kopia server is not running — attempting restart")
    systemctl start kopia-server 2>/dev/null || true
fi

# Touch health timestamp
mkdir -p "$MOUNT_POINT/health" 2>/dev/null || true
date > "$MOUNT_POINT/health/last-check.txt"

# Send alerts if any
if [ ${#ALERTS[@]} -gt 0 ]; then
    BODY=$(printf '%s\n' "${ALERTS[@]}")
    echo "$BODY" | mail -s "[Backup Pi] Health Alert" "$ALERT_EMAIL"
    echo "[$(date)] ALERTS: $BODY" >> /var/log/backup-pi-health.log
fi

# Ping healthchecks.io if configured
if [ -n "$HEALTHCHECK_URL" ]; then
    if [ ${#ALERTS[@]} -gt 0 ]; then
        # Report failure with alert text as POST body so the reason shows up
        # in the healthchecks.io UI and notification emails.
        curl -fsS --retry 3 --data-raw "$BODY" "${HEALTHCHECK_URL}/fail" > /dev/null 2>&1 || true
    else
        # Report success
        curl -fsS --retry 3 "$HEALTHCHECK_URL" > /dev/null 2>&1 || true
    fi
fi
HEALTHSCRIPT

# Substitute actual config values into the health check script
sed -i "s|__ALERT_EMAIL__|${ALERT_EMAIL}|g" /home/"${ADMIN_USER}"/check-health.sh
sed -i "s|__HEALTHCHECK_URL__|${HEALTHCHECK_URL}|g" /home/"${ADMIN_USER}"/check-health.sh
sed -i "s|__MOUNT_POINT__|${MOUNT_POINT}|g" /home/"${ADMIN_USER}"/check-health.sh
sed -i "s|__BORG_REPO_PATH__|${BORG_REPO_PATH}|g" /home/"${ADMIN_USER}"/check-health.sh
sed -i "s|__BORG_PASSPHRASE__|${BORG_REPO_PASSPHRASE}|g" /home/"${ADMIN_USER}"/check-health.sh

chown "${ADMIN_USER}":"${ADMIN_USER}" /home/"${ADMIN_USER}"/check-health.sh
chmod 755 /home/"${ADMIN_USER}"/check-health.sh
log_info "Health check script installed"

# ============================================================
# STEP 16: Borg prune script
# ============================================================
log_step "Borg prune script"

cat > /home/"${ADMIN_USER}"/borg-prune.sh << PRUNESCRIPT
#!/bin/bash
# Run borg prune and compact as the borg user.
# This script is called from cron as root.
export BORG_PASSPHRASE="${BORG_REPO_PASSPHRASE}"

sudo -u borg BORG_PASSPHRASE="\$BORG_PASSPHRASE" borg prune \\
    --keep-daily 3 \\
    --keep-weekly 4 \\
    --keep-monthly 6 \\
    ${BORG_REPO_PATH}

sudo -u borg BORG_PASSPHRASE="\$BORG_PASSPHRASE" borg compact ${BORG_REPO_PATH}
PRUNESCRIPT

chown "${ADMIN_USER}":"${ADMIN_USER}" /home/"${ADMIN_USER}"/borg-prune.sh
chmod 755 /home/"${ADMIN_USER}"/borg-prune.sh
log_info "Borg prune script installed"

# ============================================================
# STEP 17: Cron jobs
# ============================================================
log_step "Cron jobs"

# Write a dedicated crontab file (overwrite, not append — idempotent)
cat > /etc/cron.d/backup-pi << 'EOF'
# Backup Pi cron jobs

# Health check — every 6 hours (root for sudo -u borg and systemctl access)
0 */6 * * * root /home/__ADMIN_USER__/check-health.sh 2>&1 | logger -t backup-pi-health

# Borg prune — weekly Sunday 3am (root to sudo -u borg)
0 3 * * 0 root /home/__ADMIN_USER__/borg-prune.sh 2>&1 | logger -t borg-prune

# Borg integrity check — weekly Sunday 4am
0 4 * * 0 root sudo -u borg BORG_PASSPHRASE="__BORG_PASSPHRASE__" borg check /mnt/backup/borg 2>&1 | logger -t borg-check
EOF

# Substitute placeholders into the cron file
sed -i "s|__ADMIN_USER__|${ADMIN_USER}|g" /etc/cron.d/backup-pi
sed -i "s|__BORG_PASSPHRASE__|${BORG_REPO_PASSPHRASE}|g" /etc/cron.d/backup-pi

chmod 644 /etc/cron.d/backup-pi
log_info "Cron jobs installed"

# ============================================================
# STEP 18: SMART monitoring (best-effort)
# ============================================================
log_step "SMART monitoring"

if smartctl -i "$DRIVE_DEVICE" &>/dev/null; then
    log_info "SMART supported on $DRIVE_DEVICE"
    # Add weekly SMART check to cron
    cat >> /etc/cron.d/backup-pi << EOF

# SMART check — weekly Saturday 4am
0 4 * * 6 root smartctl -a ${DRIVE_DEVICE} 2>&1 | logger -t smart-check
EOF
    log_info "Weekly SMART check scheduled"
else
    log_warn "SMART not supported on $DRIVE_DEVICE (common with USB enclosures)"
    log_warn "Relying on filesystem checks and I/O error monitoring"
fi

# ============================================================
# STEP 19: Unattended upgrades
# ============================================================
log_step "Unattended upgrades"

DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -plow unattended-upgrades
log_info "Unattended upgrades configured"

# ============================================================
# STEP 19b: Web admin RPC (optional)
# ============================================================
# When the web admin host monitors and operates this Pi over Tailscale,
# we provision a separate `webadmin` user whose SSH key is forced to
# invoke /usr/local/bin/pi-rpc.sh. The dispatcher whitelists allowed
# commands and refuses everything else (mirrors the borg-serve-only.sh
# restricted-shell pattern used for the borg user).
#
# Skipped entirely if WEBADMIN_SSH_PUBKEY is left as CONFIGURE_ME — for
# users who don't run the web admin and want a leaner Pi.
log_step "Web admin RPC setup"

if [[ "${WEBADMIN_SSH_PUBKEY:-CONFIGURE_ME}" == "CONFIGURE_ME" ]]; then
    log_warn "WEBADMIN_SSH_PUBKEY not set — skipping web admin RPC setup."
    log_warn "To enable later, add the key to /etc/backup-pi.conf and re-run."
else
    # Service user (idempotent, mirrors borg/kopiauser blocks)
    if id webadmin &>/dev/null; then
        log_info "User 'webadmin' already exists"
    else
        useradd -m -s /bin/bash webadmin
        log_info "Created user 'webadmin'"
    fi

    # /usr/local/bin/pi-rpc.sh — forced SSH command + dispatcher
    cat > /usr/local/bin/pi-rpc.sh << 'RPCSCRIPT'
#!/bin/bash
# Forced SSH command for the webadmin user. Whitelists $SSH_ORIGINAL_COMMAND
# against the fixed set below; rejects everything else. Installed via:
#   command="/usr/local/bin/pi-rpc.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty <key>
# in ~webadmin/.ssh/authorized_keys. Both pi-status.sh and pi-action.sh
# are invoked via sudo so they run as root with a clean environment.

set -e

case "${SSH_ORIGINAL_COMMAND:-}" in
    status)
        exec sudo -n /usr/local/sbin/pi-status.sh
        ;;
    "action restart-kopia"|"action apt-upgrade"|"action borg-check"|"action borg-prune"|"action reboot")
        action="${SSH_ORIGINAL_COMMAND#action }"
        exec sudo -n /usr/local/sbin/pi-action.sh "$action"
        ;;
    *)
        logger -t pi-rpc "rejected: ${SSH_ORIGINAL_COMMAND:-<empty>}"
        echo "ERROR: command not allowed" >&2
        exit 1
        ;;
esac
RPCSCRIPT
    chown root:root /usr/local/bin/pi-rpc.sh
    chmod 755 /usr/local/bin/pi-rpc.sh

    # /usr/local/sbin/pi-status.sh — emits one JSON object describing Pi state.
    # Runs as root (via sudo from pi-rpc.sh) so it can read /etc/backup-pi.conf
    # directly and sudo -u borg cleanly.
    cat > /usr/local/sbin/pi-status.sh << 'STATUSSCRIPT'
#!/bin/bash
# Gathers backup-pi state and emits a single JSON object on stdout.
# Invoked as root via the SSH RPC dispatcher.

set -u

# shellcheck source=/dev/null
source /etc/backup-pi.conf

DRIVE_MOUNTED=false
DISK_SIZE_KB=0
DISK_USED_KB=0
DISK_AVAIL_KB=0
DISK_PERCENT=0
if mountpoint -q "$MOUNT_POINT"; then
    DRIVE_MOUNTED=true
    DISK_LINE=$(df --output=size,used,avail,pcent "$MOUNT_POINT" | tail -1)
    DISK_SIZE_KB=$(echo "$DISK_LINE" | awk '{print $1}')
    DISK_USED_KB=$(echo "$DISK_LINE" | awk '{print $2}')
    DISK_AVAIL_KB=$(echo "$DISK_LINE" | awk '{print $3}')
    DISK_PERCENT=$(echo "$DISK_LINE" | awk '{print $4}' | tr -d %)
fi

LAST_BORG_ISO=""
LAST_BORG_NAME=""
if $DRIVE_MOUNTED && [[ -d "$BORG_REPO_PATH/data" ]]; then
    BORG_LINE=$(sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
        borg list --last 1 --format '{time}|{archive}' "$BORG_REPO_PATH" 2>/dev/null | head -1 || true)
    if [[ -n "$BORG_LINE" ]]; then
        LAST_BORG_ISO="${BORG_LINE%%|*}"
        LAST_BORG_NAME="${BORG_LINE#*|}"
    fi
fi

KOPIA_ACTIVE=$(systemctl is-active kopia-server 2>/dev/null || echo "inactive")

TS_BACKEND=$(tailscale status --json 2>/dev/null \
    | grep -oP '"BackendState":\s*"\K[^"]+' | head -1 || echo "")
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || echo "")

LAST_HEALTH_EPOCH=0
HEALTH_FILE="$MOUNT_POINT/health/last-check.txt"
if [[ -f "$HEALTH_FILE" ]]; then
    LAST_HEALTH_EPOCH=$(stat -c %Y "$HEALTH_FILE")
fi

UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
HOSTNAME=$(hostname)
NOW_EPOCH=$(date +%s)

# Escape strings minimally — none of these should contain " or \ in practice
cat <<JSON
{
  "hostname": "$HOSTNAME",
  "now_epoch": $NOW_EPOCH,
  "uptime_seconds": $UPTIME_SECONDS,
  "drive": {
    "mounted": $DRIVE_MOUNTED,
    "mount_point": "$MOUNT_POINT",
    "size_kb": $DISK_SIZE_KB,
    "used_kb": $DISK_USED_KB,
    "avail_kb": $DISK_AVAIL_KB,
    "percent": $DISK_PERCENT
  },
  "borg": {
    "last_archive_iso": "$LAST_BORG_ISO",
    "last_archive_name": "$LAST_BORG_NAME"
  },
  "kopia": {
    "service_active": "$KOPIA_ACTIVE"
  },
  "tailscale": {
    "backend_state": "$TS_BACKEND",
    "ip": "$TS_IP"
  },
  "health": {
    "last_check_epoch": $LAST_HEALTH_EPOCH
  }
}
JSON
STATUSSCRIPT
    chown root:root /usr/local/sbin/pi-status.sh
    chmod 755 /usr/local/sbin/pi-status.sh

    # /usr/local/sbin/pi-action.sh — runs a whitelisted maintenance action.
    # Invoked as root (via sudo from pi-rpc.sh, with arg-matching in sudoers).
    cat > /usr/local/sbin/pi-action.sh << 'ACTIONSCRIPT'
#!/bin/bash
# Runs one whitelisted maintenance action. First arg = action name.
# Invoked as root via sudo from /usr/local/bin/pi-rpc.sh; sudoers limits
# which (script + arg) tuples webadmin can invoke.

set -u

ACTION="${1:-}"

# shellcheck source=/dev/null
source /etc/backup-pi.conf

case "$ACTION" in
    restart-kopia)
        echo ">>> Restarting kopia-server..."
        systemctl restart kopia-server
        sleep 2
        systemctl status kopia-server --no-pager
        ;;
    apt-upgrade)
        export DEBIAN_FRONTEND=noninteractive
        echo ">>> apt-get update"
        apt-get update
        echo ">>> apt-get upgrade -y"
        apt-get upgrade -y
        echo ">>> done"
        ;;
    borg-check)
        echo ">>> borg check (this can take a while)..."
        sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
            borg check "$BORG_REPO_PATH"
        echo ">>> borg check passed"
        ;;
    borg-prune)
        echo ">>> running /home/$ADMIN_USER/borg-prune.sh"
        bash "/home/$ADMIN_USER/borg-prune.sh"
        ;;
    reboot)
        echo ">>> rebooting in 5 seconds..."
        sleep 5
        /sbin/reboot
        ;;
    *)
        echo "ERROR: unknown action: $ACTION" >&2
        exit 2
        ;;
esac
ACTIONSCRIPT
    chown root:root /usr/local/sbin/pi-action.sh
    chmod 755 /usr/local/sbin/pi-action.sh

    # SSH key restriction (forced command, no port/X11/agent forwarding, no pty)
    mkdir -p /home/webadmin/.ssh
    cat > /home/webadmin/.ssh/authorized_keys << EOF
command="/usr/local/bin/pi-rpc.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${WEBADMIN_SSH_PUBKEY}
EOF
    chown -R webadmin:webadmin /home/webadmin/.ssh
    chmod 700 /home/webadmin/.ssh
    chmod 600 /home/webadmin/.ssh/authorized_keys

    # Sudoers — write to tempfile, validate with visudo -cf, then install.
    # Each (script + arg) tuple is granted explicitly; webadmin has no other sudo.
    SUDOERS_TMP=$(mktemp)
    cat > "$SUDOERS_TMP" << 'SUDOERS'
# webadmin: only the actions invoked by /usr/local/bin/pi-rpc.sh
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-status.sh
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh restart-kopia
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh apt-upgrade
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh borg-check
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh borg-prune
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh reboot
SUDOERS

    if visudo -cf "$SUDOERS_TMP" >/dev/null; then
        install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/webadmin
        log_info "Sudoers entry installed for webadmin"
    else
        log_error "Sudoers file failed visudo validation; aborting"
        rm -f "$SUDOERS_TMP"
        exit 1
    fi
    rm -f "$SUDOERS_TMP"

    log_info "Web admin RPC ready: ssh webadmin@${TAILSCALE_HOSTNAME} status"
fi

# ============================================================
# STEP 20: Summary
# ============================================================
echo ""
echo "============================================"
echo "  Backup Pi provisioning complete!"
echo "============================================"
echo ""
echo "  Config file:           /etc/backup-pi.conf"
echo ""
echo "  Tailscale IP:          $TAILSCALE_IP"
echo "  Tailscale hostname:    $TAILSCALE_HOSTNAME"
echo ""
echo "  Borg repo:             $BORG_REPO_PATH"
if $BORG_KEY_EXPORTED_THIS_RUN; then
echo "  Borg key exported to:  /home/${ADMIN_USER}/borg-key-backup.txt"
echo -e "  ${RED}>>> SAVE THIS KEY SECURELY AND DELETE FROM PI <<<${NC}"
fi
echo ""
echo "  Kopia server:          https://${TAILSCALE_IP}:${KOPIA_SERVER_PORT}"
if [[ -n "$KOPIA_FINGERPRINT" ]]; then
echo "  Kopia cert fingerprint: $KOPIA_FINGERPRINT"
fi
if $KOPIA_CERT_GENERATED_THIS_RUN; then
echo -e "  ${RED}>>> RECORD THE FINGERPRINT FOR CLIENT SETUP <<<${NC}"
else
echo "  (Kopia cert + fingerprint unchanged from previous setup — clients OK)"
fi
echo "  Kopia server user:     $KOPIA_USER_NAME"
echo ""
echo "  Borg user shell:       /usr/local/bin/borg-serve-only.sh (append-only)"
if [[ "${WEBADMIN_SSH_PUBKEY:-CONFIGURE_ME}" != "CONFIGURE_ME" ]]; then
echo "  Web admin RPC:         /usr/local/bin/pi-rpc.sh (webadmin user)"
fi
echo "  Firewall:              Active (Tailscale only)"
echo "  Health checks:         Every 6 hours via cron"
echo "  Borg prune:            Weekly Sunday 3am"
echo "  Borg integrity check:  Weekly Sunday 4am"
echo "  Email alerts:          $ALERT_EMAIL via $SMTP_HOST"
if [[ -n "$HEALTHCHECK_URL" ]]; then
echo "  Healthchecks.io:       Configured"
fi
echo ""
echo "  Next steps:"
echo "  1. Save the borg key and kopia cert fingerprint"
echo "  2. Test SSH: ssh -i ~/.ssh/borg_backup borg@backup-pi"
echo "     (should see 'borg serve' and then hang — that's correct, Ctrl-C to exit)"
echo "  3. Run initial borg backup from your backup client:"
echo "     BORG_RSH=\"ssh -i ~/.ssh/borg_backup\" borg create \\"
echo "         ssh://borg@backup-pi/mnt/backup/borg::initial /path/to/data"
echo "  4. Connect your Kopia client to the remote server:"
echo "     kopia repository connect server \\"
echo "         --url https://${TAILSCALE_IP}:${KOPIA_SERVER_PORT} \\"
echo "         --server-cert-fingerprint <FINGERPRINT> \\"
echo "         --password <REPO_PASSWORD> \\"
echo "         --config-file repository-remote.config"
echo "  5. Run initial Kopia backup from your Kopia client"
echo "  6. Verify both backups with test restores"
echo "  7. Ship the Pi to the remote location"
echo "============================================"
