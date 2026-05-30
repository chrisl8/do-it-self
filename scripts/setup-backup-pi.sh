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

# Default for optional config value.
ADMIN_USER="${ADMIN_USER:-piadmin}"

# ── Multi-client schema ─────────────────────────────────────────
#
# The Pi holds NO borg passphrases. Management is driven by the manager
# host (neuromancer) via the SSH key whose pubkey is in MANAGER_SSH_PUBKEY.
# Each client has its own SSH key for the append-only backup path.

client_var() {
    # client_var <name> <KEY> → echoes CLIENT_<UPPERNAME>_<KEY>.
    # Uppercases name and replaces '-' with '_'.
    local name="$1"
    local key="$2"
    local upper
    upper=$(echo "$name" | tr 'a-z-' 'A-Z_')
    local var="CLIENT_${upper}_${key}"
    echo "${!var:-}"
}

if [[ -z "${CLIENTS:-}" ]]; then
    echo "[ERROR] CLIENTS is empty. Set it in /etc/backup-pi.conf (see conf.example)."
    exit 1
fi
for _name in $CLIENTS; do
    if [[ ! "$_name" =~ ^[a-z0-9-]+$ ]]; then
        echo "[ERROR] Client name '$_name' must match [a-z0-9-]+"
        exit 1
    fi
    for _key in PUBKEY REPO_PATH; do
        _v=$(client_var "$_name" "$_key")
        if [[ -z "$_v" || "$_v" == "CONFIGURE_ME" ]]; then
            echo "[ERROR] CLIENT_$(echo "$_name" | tr 'a-z-' 'A-Z_')_${_key} is not set"
            exit 1
        fi
    done
done
unset _name _key _v

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
#   - Tailscale auth key MUST be reusable + non-ephemeral +
#     tagged with tag:backup-target (see preflight warning).
#   - SSH keys survive drive replacement (they're on the SD card,
#     not the USB drive). No re-keying needed.
#   - A NEW borg encryption key is generated for each fresh repo.
#     The operator is prompted for the passphrase interactively —
#     the conf doesn't hold it.
#   - All backup data starts from scratch — previous archives
#     lived on the old drive.
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

# Check for unconfigured values. The Pi holds no borg/kopia passphrases —
# only TAILSCALE_AUTH_KEY (used at join time) and MANAGER_SSH_PUBKEY are
# required globals. Per-client PUBKEY + REPO_PATH validated above.
UNCONFIGURED=0
for var in TAILSCALE_AUTH_KEY MANAGER_SSH_PUBKEY; do
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

# Warn about the Tailscale auth key — only when we're actually about to
# use it (i.e., Tailscale isn't connected yet). On routine re-runs of an
# already-joined Pi, the key is unused and the warning is noise.
if ! tailscale status &>/dev/null; then
    log_warn ""
    log_warn "=== Tailscale auth key requirements ==="
    log_warn "If this is a fresh install or drive replacement, the auth key MUST be:"
    log_warn "  (a) REUSABLE — single-use keys are consumed on first join and a"
    log_warn "      future drive replacement that re-runs this script would fail."
    log_warn "  (b) NOT ephemeral — ephemeral nodes auto-expire on disconnect."
    log_warn "  (c) Tagged with tag:backup-target — required for the ACL setup"
    log_warn "      (see STEP 20 summary at the end of this run)."
    log_warn "Generate at https://login.tailscale.com/admin/settings/keys with:"
    log_warn "  Reusable: ON   Ephemeral: OFF   Tags: tag:backup-target"
    log_warn ""
    log_warn "Continuing in 5 seconds — Ctrl-C now if the key isn't right."
    sleep 5
fi

# Print piadmin password warning — surfaces here, also restated at the end
# in STEP 20. NOPASSWD sudoers entries for ADMIN_USER get removed in STEP 7b,
# so piadmin's interactive password becomes the last line of defense against
# ransomware-on-neuromancer trying to wipe /mnt/backup.
log_warn ""
log_warn "=== piadmin password ==="
log_warn "This script removes the Pi-Imager / cloud-init NOPASSWD sudo rules"
log_warn "for ${ADMIN_USER}. After this run, ${ADMIN_USER}'s password is the last"
log_warn "line of defense if your neuromancer SSH key is compromised."
log_warn "Before you disconnect, set a strong password (20+ random chars):"
log_warn "    sudo passwd ${ADMIN_USER}"
log_warn "The script does not change it for you (we can't verify strength)."
log_warn ""

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
    borgbackup openssh-server ufw smartmontools unattended-upgrades

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

# Create base directory. Per-client repo dirs are created in the chown loop
# below, so we don't hardcode any repo subdirs here.
mkdir -p "$MOUNT_POINT"
log_info "Mount point directory ready"

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

# kopia is no longer used (retired). Tear-down happens in STEP 11.

# ============================================================
# STEP 5: Set directory permissions + write clients.env
# ============================================================
log_step "Set directory permissions"

# Each client's repo parent dir exists and is borg-owned. Idempotent — for
# existing repos (e.g. wintermute created out-of-band), no-op.
for name in $CLIENTS; do
    repo_path=$(client_var "$name" REPO_PATH)
    mkdir -p "$repo_path"
    chown borg:borg "$repo_path"
done
log_info "Permissions set"

# ── Generate /etc/backup-pi.clients.env ─────────────────────────
# Single source of truth consumed by:
#   - /usr/local/bin/borg-serve-only.sh (allowlist + repo paths)
#   - /usr/local/bin/borg-manage.sh (allowlist + repo paths)
#   - /usr/local/sbin/pi-status.sh (per-client JSON in status output)
# Contains no secrets — mode 644.
log_step "Write /etc/backup-pi.clients.env"

CLIENTS_ENV_TMP=$(mktemp)
{
    echo "# Auto-generated by setup-backup-pi.sh — do not hand-edit."
    echo "# Source of truth for the multi-client schema. Re-run the setup"
    echo "# script after editing /etc/backup-pi.conf to regenerate."
    echo ""
    echo "CLIENTS=\"${CLIENTS}\""
    for name in $CLIENTS; do
        upper=$(echo "$name" | tr 'a-z-' 'A-Z_')
        echo "CLIENT_${upper}_REPO_PATH=\"$(client_var "$name" REPO_PATH)\""
    done
} > "$CLIENTS_ENV_TMP"
install -m 0644 -o root -g root "$CLIENTS_ENV_TMP" /etc/backup-pi.clients.env
rm -f "$CLIENTS_ENV_TMP"
log_info "Wrote /etc/backup-pi.clients.env"

# ============================================================
# STEP 5b: SSH key auth for borg user (per-client forced commands)
# ============================================================
# Every client gets its own authorized_keys line with a forced command that
# names the client; /usr/local/bin/borg-serve-only.sh (STEP 10) maps that
# name → repo path. A leaked key can only reach the repo it was issued for.
log_step "SSH key auth for borg user"

mkdir -p /home/borg/.ssh

AUTH_KEYS_TMP=$(mktemp)
declare -A NEW_PUBKEYS=()

# Per-client backup keys (force borg-serve-only.sh with --append-only).
for name in $CLIENTS; do
    pubkey=$(client_var "$name" PUBKEY)
    # Use OpenSSH `restrict` keyword — implies no-port/X11/agent-fwd, no-pty,
    # and is forward-compatible with future restrictions.
    echo "command=\"/usr/local/bin/borg-serve-only.sh ${name}\",restrict ${pubkey}" >> "$AUTH_KEYS_TMP"
    # Index by trailing base64 chunk (the key body) for the diff below
    key_body=$(awk '{print $2}' <<<"$pubkey")
    NEW_PUBKEYS["$key_body"]=1
done

# Manager key (forces borg-manage.sh — verb passed in SSH_ORIGINAL_COMMAND,
# BORG_PASSPHRASE forwarded via SSH SendEnv).
echo "command=\"/usr/local/bin/borg-manage.sh\",restrict ${MANAGER_SSH_PUBKEY}" >> "$AUTH_KEYS_TMP"
mgr_body=$(awk '{print $2}' <<<"$MANAGER_SSH_PUBKEY")
NEW_PUBKEYS["$mgr_body"]=1

# Warn about any pubkeys we'd be removing — catches hand-edited keys the
# operator may have forgotten about. Backup the existing file regardless.
if [[ -f /home/borg/.ssh/authorized_keys ]]; then
    backup="/home/borg/.ssh/authorized_keys.bak.$(date +%s)"
    cp /home/borg/.ssh/authorized_keys "$backup"
    chown borg:borg "$backup"
    chmod 600 "$backup"
    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        # Match existing lines against our intended set by the base64 key body.
        found=false
        for body in "${!NEW_PUBKEYS[@]}"; do
            if grep -qF "$body" <<<"$line"; then
                found=true
                break
            fi
        done
        if ! $found; then
            log_warn "authorized_keys: existing pubkey will be REMOVED (kept in $backup):"
            log_warn "    ${line:0:80}…"
        fi
    done < /home/borg/.ssh/authorized_keys
fi

install -m 600 -o borg -g borg "$AUTH_KEYS_TMP" /home/borg/.ssh/authorized_keys
rm -f "$AUTH_KEYS_TMP"
chown borg:borg /home/borg/.ssh
chmod 700 /home/borg/.ssh
log_info "SSH authorized_keys installed for borg user ($(echo "$CLIENTS" | wc -w) client key(s) + 1 manager key)"

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
    # --advertise-tags claims tag:backup-target so the tailnet ACLs can
    # restrict the Pi to inbound-only (see docs/SETUP-BACKUP-PI.md "Tailscale
    # ACLs"). The auth key MUST authorize this tag or the claim is rejected.
    tailscale up \
        --auth-key="$TAILSCALE_AUTH_KEY" \
        --hostname="$TAILSCALE_HOSTNAME" \
        --advertise-tags=tag:backup-target
    log_info "Tailscale connected as $TAILSCALE_HOSTNAME with tag:backup-target"
fi

# Disable Tailscale SSH — use OpenSSH with key auth for unattended borg backups
tailscale set --ssh=false

# ============================================================
# STEP 7: Get Tailscale IP
# ============================================================
TAILSCALE_IP=$(tailscale ip -4)
log_info "Tailscale IP: $TAILSCALE_IP"

# ============================================================
# STEP 7b: SSH hardening + fail2ban
# ============================================================
# Two pieces, both always-on:
#   (a) fail2ban with sshd jail. UFW already blocks the LAN side of sshd,
#       but fail2ban catches anything that gets past it (e.g. via Tailscale).
#   (b) sshd_config drop-in: PasswordAuthentication=no, PermitRootLogin=no,
#       AllowUsers <admin> borg [webadmin].
#
# What used to be here and isn't anymore: `ListenAddress <tailscale-ip>` and
# an After=tailscaled.service drop-in. They were redundant with UFW (which
# already restricts sshd to the Tailscale interface) AND introduced a real
# boot-time race — sshd would try to bind the Tailscale IP before tailscaled
# had finished bringing the interface up, and refuse to start. The 127.0.0.1
# fallback didn't save it because sshd fails the whole startup if any
# ListenAddress can't bind. Lesson learned the hard way.
log_step "SSH hardening + fail2ban"

DEBIAN_FRONTEND=noninteractive apt install -y fail2ban

cat > /etc/fail2ban/jail.d/sshd.local << 'EOF'
[sshd]
enabled = true
port    = ssh
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
log_info "fail2ban installed and sshd jail active"

# Build AllowUsers dynamically so we don't grant a user we never created
# (webadmin is optional).
ALLOW_USERS="${ADMIN_USER} borg"
if [[ "${WEBADMIN_SSH_PUBKEY:-CONFIGURE_ME}" != "CONFIGURE_ME" ]]; then
    ALLOW_USERS="${ALLOW_USERS} webadmin"
fi

SSHD_DROPIN="/etc/ssh/sshd_config.d/99-backup-pi.conf"
cat > "$SSHD_DROPIN" << EOF
# Backup Pi sshd hardening — managed by setup-backup-pi.sh.
# Tailscale-only access is enforced by UFW (allow in on tailscale0,
# default deny incoming), not by ListenAddress (which caused a boot-time
# race with tailscaled in an earlier revision).
PasswordAuthentication no
PermitRootLogin no
AllowUsers ${ALLOW_USERS}

# Allow the manager / webadmin to forward per-operation passphrases via SSH
# env. The Pi-side wrappers (borg-manage.sh, pi-status.sh) read these from
# the environment. NEVER use AcceptEnv * — that's a credential-leak hole.
AcceptEnv BORG_PASSPHRASE
AcceptEnv BORG_PASSPHRASE_*
EOF
chmod 644 "$SSHD_DROPIN"

# Validate before reloading; bail out hard if the rendered config is bad.
if ! sshd -t 2>&1; then
    log_error "sshd -t rejected the new config; removing drop-in and bailing"
    rm -f "$SSHD_DROPIN"
    exit 1
fi

# Clean up the old wait-tailscale.conf drop-in if it's still around from a
# prior run that used the now-removed HARDEN_SSHD=true path.
if [[ -f /etc/systemd/system/ssh.service.d/wait-tailscale.conf ]]; then
    rm -f /etc/systemd/system/ssh.service.d/wait-tailscale.conf
    rmdir /etc/systemd/system/ssh.service.d 2>/dev/null || true
    systemctl daemon-reload
    log_info "Removed stale /etc/systemd/system/ssh.service.d/wait-tailscale.conf"
fi

# Remove the Pi-Imager / cloud-init NOPASSWD sudo entries for ADMIN_USER.
# After this, ${ADMIN_USER}'s password is required for sudo — the last line
# of defense if neuromancer's SSH key is compromised by ransomware.
# webadmin's NOPASSWD entries for pi-rpc scripts stay (STEP 19b owns those).
PIADMIN_NOPASSWD_REMOVED=false
for f in /etc/sudoers.d/010_pi-nopasswd /etc/sudoers.d/90-cloud-init-users; do
    if [[ -f "$f" ]]; then
        rm -f "$f"
        log_info "Removed $f (was: ${ADMIN_USER} NOPASSWD sudo)"
        PIADMIN_NOPASSWD_REMOVED=true
    fi
done
if $PIADMIN_NOPASSWD_REMOVED; then
    log_warn "${ADMIN_USER} now requires a password for sudo."
    log_warn "Future re-runs of this script will prompt for it."
    log_warn "Set a strong password if you have not already: passwd ${ADMIN_USER}"
fi

systemctl reload ssh || systemctl restart ssh
log_info "sshd hardened: PasswordAuthentication=no, PermitRootLogin=no, AllowUsers=${ALLOW_USERS}, AcceptEnv BORG_PASSPHRASE*"

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
# STEP 8b: Tailscale ACL probe (non-fatal)
# ============================================================
# The Pi should be reachable INBOUND from neuromancer + wintermute but
# should not be able to initiate OUTBOUND to anything on the tailnet. The
# tailnet's ACL policy is what enforces this — see docs/SETUP-BACKUP-PI.md
# "Tailscale ACLs" for the exact JSON. The script can't apply ACLs (they're
# managed in the Tailscale admin console), but it can detect when they
# aren't restrictive yet and warn loudly.
log_step "Tailscale ACL probe"

# Pick a probe target — try a known peer the user is likely to have. Falls
# back gracefully if no peer matches (e.g. a fresh tailnet with only the Pi).
PROBE_TARGETS=("neuromancer" "wintermute")
PROBE_RESULT="no-target"
for target in "${PROBE_TARGETS[@]}"; do
    if tailscale status "$target" &>/dev/null; then
        if timeout 5 tailscale ping -c 1 -timeout 3s "$target" &>/dev/null; then
            PROBE_RESULT="reachable:${target}"
        else
            PROBE_RESULT="blocked:${target}"
        fi
        break
    fi
done

case "$PROBE_RESULT" in
    blocked:*)
        log_info "Pi cannot initiate outbound to ${PROBE_RESULT#blocked:} — ACLs appear restrictive ✓"
        ;;
    reachable:*)
        log_warn ""
        log_warn "Pi CAN initiate outbound to ${PROBE_RESULT#reachable:} over Tailscale."
        log_warn "This means tailnet ACLs are NOT yet restricting tag:backup-target."
        log_warn "A compromised Pi could pivot to your other tailnet devices."
        log_warn "Follow the ACL setup instructions printed at the end of this run."
        log_warn ""
        ;;
    no-target)
        log_warn "Could not probe Tailscale ACLs (no known peer to test against)."
        log_warn "Manually verify after setup: tailscale ping <peer-host> from the Pi"
        log_warn "should fail once ACLs restrict tag:backup-target."
        ;;
esac

# ============================================================
# STEP 9: Initialize Borg repos (one per client)
# ============================================================
log_step "Borg repository setup"

# Track whether we exported any new keys this run — only print the scary
# "SAVE THIS KEY" warning when at least one new repo was initialized, so
# routine re-runs stay quiet.
BORG_KEY_EXPORTED_THIS_RUN=false

for name in $CLIENTS; do
    repo_path=$(client_var "$name" REPO_PATH)
    if [[ -d "$repo_path/data" ]]; then
        log_info "Borg repo for $name already exists at $repo_path"
        continue
    fi

    # The conf no longer holds passphrases — prompt the operator. Read
    # interactively from the controlling TTY so a piped/scripted invocation
    # fails loudly rather than initializing with an empty passphrase.
    log_warn "No repo exists at $repo_path for client '$name' — fresh init required."
    log_warn "The Pi does not store borg passphrases. Enter the passphrase NOW."
    log_warn "It will also be stored in Infisical on the manager (neuromancer)"
    log_warn "as BORG_REMOTE_PASSPHRASE_$(echo "$name" | tr 'a-z-' 'A-Z_'), so make"
    log_warn "sure they match."
    if [[ ! -t 0 ]]; then
        log_error "stdin is not a TTY; cannot prompt for the borg passphrase."
        log_error "Re-run this script in an interactive session (sudo bash setup-backup-pi.sh)"
        exit 1
    fi
    init_passphrase=""
    while [[ -z "$init_passphrase" ]]; do
        read -rs -p "Passphrase for $name's borg repo: " init_passphrase </dev/tty
        echo
        if [[ -z "$init_passphrase" ]]; then
            log_warn "Empty passphrase rejected; try again."
        fi
    done
    read -rs -p "Confirm passphrase: " confirm </dev/tty
    echo
    if [[ "$init_passphrase" != "$confirm" ]]; then
        log_error "Passphrases do not match. Aborting before repo init."
        unset init_passphrase confirm
        exit 1
    fi
    unset confirm

    sudo -u borg BORG_PASSPHRASE="$init_passphrase" \
        borg init --encryption=repokey-blake2 "$repo_path"
    log_info "Borg repo for $name initialized at $repo_path"

    # Export the encryption key once, at repo creation. The repokey is
    # already inside the repo (wrapped by the passphrase); this exported
    # copy is just a recovery option if the repo files are damaged.
    key_dst="/home/${ADMIN_USER}/borg-key-backup-${name}.txt"
    sudo -u borg BORG_PASSPHRASE="$init_passphrase" \
        borg key export "$repo_path" "/home/borg/borg-key-${name}.txt"
    mv "/home/borg/borg-key-${name}.txt" "$key_dst"
    chown "${ADMIN_USER}":"${ADMIN_USER}" "$key_dst"
    chmod 600 "$key_dst"
    unset init_passphrase
    log_warn "Borg key for $name exported to $key_dst"
    log_warn ">>> SAVE THIS KEY OFF THE PI AND THEN DELETE IT <<<"
    BORG_KEY_EXPORTED_THIS_RUN=true
done

# ============================================================
# STEP 10: Borg restricted shell wrapper (arg-driven)
# ============================================================
# Called from the authorized_keys forced command as
#   /usr/local/bin/borg-serve-only.sh <client-name>
# Validates the client name against /etc/backup-pi.clients.env (defense in
# depth — even if a leaked key were re-issued with a tampered command=,
# the wrapper still pins the repo path to the one that client is allowed).
log_step "Borg append-only restriction"

cat > /usr/local/bin/borg-serve-only.sh << 'BORGWRAPPER'
#!/bin/bash
set -e

CLIENT_NAME="${1:-}"

# Shape check first — keeps a malformed name out of the env lookup.
if [[ ! "$CLIENT_NAME" =~ ^[a-z0-9-]+$ ]]; then
    logger -t borg-serve-only "rejected: bad client name shape: ${CLIENT_NAME:-<empty>}"
    echo "ERROR: invalid client name" >&2
    exit 1
fi

# shellcheck source=/dev/null
. /etc/backup-pi.clients.env

# Allowlist check: $CLIENTS is space-separated.
allowed=false
for c in $CLIENTS; do
    [[ "$c" == "$CLIENT_NAME" ]] && { allowed=true; break; }
done
if ! $allowed; then
    logger -t borg-serve-only "rejected: not in CLIENTS allowlist: $CLIENT_NAME"
    echo "ERROR: client not allowed" >&2
    exit 1
fi

# Look up repo path for this client.
upper=$(echo "$CLIENT_NAME" | tr 'a-z-' 'A-Z_')
varname="CLIENT_${upper}_REPO_PATH"
repo_path="${!varname:-}"

if [[ -z "$repo_path" ]]; then
    logger -t borg-serve-only "no REPO_PATH set for $CLIENT_NAME"
    echo "ERROR: client repo path not configured" >&2
    exit 1
fi

exec borg serve --restrict-to-path "$repo_path" --append-only
BORGWRAPPER

chmod 755 /usr/local/bin/borg-serve-only.sh

# /usr/local/bin/borg-manage.sh — management path. Called from the
# authorized_keys forced command for the manager key. Parses verb + client
# from $SSH_ORIGINAL_COMMAND, validates both, reads BORG_PASSPHRASE from SSH
# env (forwarded via SendEnv on the manager side), runs borg with hardcoded
# args. Anything not in the allowlist is rejected and logged.
cat > /usr/local/bin/borg-manage.sh << 'MANAGEWRAPPER'
#!/bin/bash
set -e

# Parse "<verb> <client> [args...]" from SSH_ORIGINAL_COMMAND.
cmd="${SSH_ORIGINAL_COMMAND:-}"
read -r VERB CLIENT_NAME ARG1 ARG2 _ <<<"$cmd"

if [[ ! "$VERB" =~ ^[a-z-]+$ ]]; then
    logger -t borg-manage "rejected: bad verb shape: ${VERB:-<empty>}"
    echo "ERROR: invalid verb" >&2
    exit 1
fi
if [[ ! "$CLIENT_NAME" =~ ^[a-z0-9-]+$ ]]; then
    logger -t borg-manage "rejected: bad client name: ${CLIENT_NAME:-<empty>}"
    echo "ERROR: invalid client name" >&2
    exit 1
fi

# shellcheck source=/dev/null
. /etc/backup-pi.clients.env

allowed=false
for c in $CLIENTS; do [[ "$c" == "$CLIENT_NAME" ]] && { allowed=true; break; }; done
if ! $allowed; then
    logger -t borg-manage "rejected: not in CLIENTS allowlist: $CLIENT_NAME"
    echo "ERROR: client not allowed" >&2
    exit 1
fi

upper=$(echo "$CLIENT_NAME" | tr 'a-z-' 'A-Z_')
varname="CLIENT_${upper}_REPO_PATH"
REPO_PATH="${!varname:-}"
if [[ -z "$REPO_PATH" ]]; then
    logger -t borg-manage "no REPO_PATH for $CLIENT_NAME"
    echo "ERROR: client repo path not configured" >&2
    exit 1
fi

if [[ -z "${BORG_PASSPHRASE:-}" ]]; then
    logger -t borg-manage "rejected: no BORG_PASSPHRASE in env for $VERB $CLIENT_NAME"
    echo "ERROR: BORG_PASSPHRASE must be forwarded via SSH SendEnv" >&2
    exit 1
fi
export BORG_PASSPHRASE

case "$VERB" in
    prune)
        # Hardcoded retention. No --prefix, no --keep-daily 0 from caller.
        logger -t borg-manage "prune $CLIENT_NAME ($REPO_PATH)"
        exec borg prune --keep-daily 14 --keep-weekly 4 --stats --show-rc "$REPO_PATH"
        ;;
    compact)
        logger -t borg-manage "compact $CLIENT_NAME ($REPO_PATH)"
        exec borg compact --show-rc "$REPO_PATH"
        ;;
    check)
        logger -t borg-manage "check $CLIENT_NAME ($REPO_PATH)"
        exec borg check --show-rc "$REPO_PATH"
        ;;
    break-lock)
        # Release a stale repository lock left behind when a borg process was
        # killed mid-operation (e.g. the Pi was powered off during a push).
        # break-lock only removes the lock file; it never deletes or mutates
        # archive data, so it is safe to expose to the manager key. Only run
        # this when you are certain no borg process is actually operating on
        # the repo, otherwise you can corrupt a concurrent transaction.
        logger -t borg-manage "break-lock $CLIENT_NAME ($REPO_PATH)"
        exec borg break-lock --show-rc "$REPO_PATH"
        ;;
    list)
        logger -t borg-manage "list $CLIENT_NAME ($REPO_PATH)"
        exec borg list --short "$REPO_PATH"
        ;;
    list-last)
        # {start} with an explicit ISO strftime — borg 1.4 removed the bare
        # {isoformat} key (KeyError), and the neuromancer-side freshness parser
        # does `date -d` on this field, so it must be ISO-parseable.
        logger -t borg-manage "list-last $CLIENT_NAME ($REPO_PATH)"
        exec borg list --last 1 --format '{start:%Y-%m-%dT%H:%M:%S}|{archive}' "$REPO_PATH"
        ;;
    info)
        logger -t borg-manage "info $CLIENT_NAME ($REPO_PATH)"
        exec borg info --json "$REPO_PATH"
        ;;
    extract)
        # extract <archive> <path> — pipes contents of <path> from <archive> to stdout.
        # Used by the restore-test to verify a known file is recoverable.
        ARCHIVE="$ARG1"
        EXTRACT_PATH="$ARG2"
        if [[ ! "$ARCHIVE" =~ ^[A-Za-z0-9_:.-]+$ ]]; then
            logger -t borg-manage "rejected: bad archive name: $ARCHIVE"
            echo "ERROR: bad archive name" >&2
            exit 1
        fi
        if [[ ! "$EXTRACT_PATH" =~ ^[A-Za-z0-9/_.-]+$ ]] || [[ "$EXTRACT_PATH" == *..* ]]; then
            logger -t borg-manage "rejected: bad extract path: $EXTRACT_PATH"
            echo "ERROR: bad extract path" >&2
            exit 1
        fi
        logger -t borg-manage "extract $CLIENT_NAME ($REPO_PATH) :: $ARCHIVE :: $EXTRACT_PATH"
        exec borg extract --stdout "${REPO_PATH}::${ARCHIVE}" "$EXTRACT_PATH"
        ;;
    *)
        logger -t borg-manage "rejected: verb not in allowlist: $VERB"
        echo "ERROR: verb not allowed" >&2
        exit 1
        ;;
esac
MANAGEWRAPPER

chmod 755 /usr/local/bin/borg-manage.sh

# borg's login shell stays /bin/bash. (An earlier revision chsh'd the borg
# user to borg-serve-only.sh; that collided with sshd's `shell -c <forced>`
# invocation pattern and broke the new arg-driven wrappers. /bin/bash here.)
chsh -s /bin/bash borg

# Clean up the wrapper's entry from /etc/shells if a prior run added it.
if grep -q "^/usr/local/bin/borg-serve-only.sh$" /etc/shells 2>/dev/null; then
    sed -i '\|^/usr/local/bin/borg-serve-only.sh$|d' /etc/shells
fi
log_info "Borg wrappers installed: borg-serve-only.sh (backup, append-only) + borg-manage.sh (management, allowlist-gated)"

# ============================================================
# STEPS 11-13: Kopia tear-down (kopia is retired)
# ============================================================
# Kopia was previously the remote backup target for wintermute (a Windows
# desktop). Wintermute has migrated to Linux + borgmatic, so kopia is no
# longer used. Its presence on the Pi was a physical-theft liability:
# KOPIA_REPO_PASSWORD was stored in /etc/backup-pi.conf, meaning the kopia
# repo on the USB drive was decryptable from the Pi alone.
#
# This block tears down kopia idempotently. Runs on every re-run; once
# nothing is left to remove, every line is a no-op.
log_step "Kopia tear-down"

systemctl stop kopia-server 2>/dev/null || true
systemctl disable kopia-server 2>/dev/null || true
systemctl mask kopia-server 2>/dev/null || true
if [[ -f /etc/systemd/system/kopia-server.service ]]; then
    rm -f /etc/systemd/system/kopia-server.service
    systemctl daemon-reload
fi

# Remove kopia data + user. The repo data and any historical snapshots
# from when wintermute backed up via kopia are deliberately discarded.
rm -rf /mnt/backup/kopia /home/kopiauser 2>/dev/null || true
if id kopiauser &>/dev/null; then
    userdel kopiauser 2>/dev/null || true
    log_info "Removed kopiauser system user"
fi

# Remove kopia package + apt source. Best-effort; ignore failures on
# already-clean systems.
if command -v kopia &>/dev/null; then
    apt purge -y kopia 2>/dev/null || true
    log_info "Purged kopia package"
fi
rm -f /usr/share/keyrings/kopia-keyring.gpg /etc/apt/sources.list.d/kopia.list

# (STEP 14 — msmtp/email alerting — was removed in a prior revision.
# Notifications flow through healthchecks.io exclusively.)

log_info "Kopia tear-down complete"

# ============================================================
# STEPS 15-16: Pi-side management script tear-down
# ============================================================
log_step "Pi-side management tear-down"

# Previous revisions installed check-health.sh, borg-prune.sh, and
# borg-check-all.sh on the Pi to manage repos using passphrases stored in
# /etc/backup-pi.conf. Those scripts are now retired — all management runs
# from neuromancer via scripts/borg-pi-manage.sh, with passphrases injected
# per-operation via SSH SendEnv. The Pi holds no borg passphrases.
#
# Remove the old scripts and any leftover health log so a re-run cleanly
# transitions from the old layout to the new one.
rm -f /home/"${ADMIN_USER}"/check-health.sh \
      /home/"${ADMIN_USER}"/borg-prune.sh \
      /home/"${ADMIN_USER}"/borg-check-all.sh
# Health log is rotated — leave any existing /var/log/backup-pi-health.log
# alone as historical record. Future runs won't write to it.
log_info "Removed legacy Pi-side management scripts"

# ============================================================
# STEP 17: Cron jobs (SMART monitoring only)
# ============================================================
log_step "Cron jobs"

# The Pi is now passive. The only cron job is SMART drive health (added
# below in STEP 18 if smartctl supports the drive). No borg cron jobs —
# prune/check/restore-test run from neuromancer's user crontab.
cat > /etc/cron.d/backup-pi << 'EOF'
# Backup Pi cron jobs
# (Borg management cron lives on neuromancer, not the Pi. See
# scripts/borg-pi-manage.sh on neuromancer.)
EOF
chmod 644 /etc/cron.d/backup-pi
log_info "Cron file rewritten (Pi-side borg jobs removed)"

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
    # Allowlist contracted to status / apt-upgrade / reboot. Borg verbs
    # (check, prune, list, restore-test) are NOT routed through this path;
    # they go through /usr/local/bin/borg-manage.sh under the manager key,
    # which accepts BORG_PASSPHRASE via SSH SendEnv. Kopia is retired.
    cat > /usr/local/bin/pi-rpc.sh << 'RPCSCRIPT'
#!/bin/bash
# Forced SSH command for the webadmin user. Whitelists $SSH_ORIGINAL_COMMAND
# against the fixed set below; rejects everything else. Installed via:
#   command="/usr/local/bin/pi-rpc.sh",restrict <key>
# in ~webadmin/.ssh/authorized_keys. pi-status.sh and pi-action.sh are
# invoked via sudo so they run as root with a clean environment.

set -e

case "${SSH_ORIGINAL_COMMAND:-}" in
    status)
        # pi-status.sh reads BORG_PASSPHRASE_<NAME> env vars (forwarded via
        # SendEnv from the web admin) to populate per-client archive count
        # and last-archive time. Without them it falls back to filesystem
        # stat. Either way, no passphrase is stored on the Pi.
        # env_keep in /etc/sudoers.d/webadmin lets BORG_PASSPHRASE_* survive
        # the sudo boundary.
        exec sudo -n /usr/local/sbin/pi-status.sh
        ;;
    "action apt-upgrade"|"action reboot")
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
    # Runs as root via sudo from pi-rpc.sh. For each client:
    #   - If BORG_PASSPHRASE_<UPPERNAME> is in the env (forwarded via SSH
    #     SendEnv from the web admin, which fetches from Infisical), call
    #     `borg list` for full archive_count + last_archive_*.
    #   - Else fall back to stat'ing <repo>/transactions mtime for
    #     last_activity_iso.
    # Either way, no passphrase is persisted on the Pi.
    cat > /usr/local/sbin/pi-status.sh << 'STATUSSCRIPT'
#!/bin/bash
set -u

# shellcheck source=/dev/null
source /etc/backup-pi.clients.env

# MOUNT_POINT comes from /etc/backup-pi.conf but the conf is mode 600 root.
# We're root (via sudo), so we can read it.
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

NOW_EPOCH=$(date +%s)
CLIENT_JSON_PARTS=()
for name in $CLIENTS; do
    upper=$(echo "$name" | tr 'a-z-' 'A-Z_')
    repo_var="CLIENT_${upper}_REPO_PATH"
    pass_var="BORG_PASSPHRASE_${upper}"
    repo_path="${!repo_var:-}"
    [ -z "$repo_path" ] && continue

    last_iso=""
    last_name=""
    last_activity_epoch=0
    archive_count=0
    has_passphrase=false
    error=""
    if [[ -n "${!pass_var:-}" ]]; then
        has_passphrase=true
    fi

    if $DRIVE_MOUNTED && [[ -d "$repo_path/data" ]]; then
        # Fallback path: filesystem mtime of <repo>/transactions, which is
        # rewritten on every successful borg create commit. No passphrase
        # required. Sufficient to detect "wintermute hasn't backed up."
        if [[ -f "$repo_path/transactions" ]]; then
            last_activity_epoch=$(stat -c %Y "$repo_path/transactions")
            last_iso=$(date -u -d "@$last_activity_epoch" +%Y-%m-%dT%H:%M:%SZ)
        fi

        # Richer path: only when the manager forwarded a passphrase via SSH
        # SendEnv. Replaces last_iso with the actual archive timestamp and
        # gives us archive_count + last_archive_name.
        if $has_passphrase; then
            # {start} with explicit ISO strftime — borg 1.4 removed the bare
            # {isoformat} key. parseBorgArchiveTimestamp() (web admin) accepts ISO.
            borg_line=$(sudo -u borg BORG_PASSPHRASE="${!pass_var}" \
                borg list --last 1 --format '{start:%Y-%m-%dT%H:%M:%S}|{archive}' "$repo_path" 2>/dev/null | head -1 || true)
            if [[ -n "$borg_line" ]]; then
                last_iso="${borg_line%%|*}"
                last_name="${borg_line#*|}"
            else
                # Empty result with a passphrase set = either no archives or
                # wrong passphrase. Probe to distinguish.
                if sudo -u borg BORG_PASSPHRASE="${!pass_var}" \
                    borg list --short "$repo_path" 2>&1 >/dev/null | grep -q "passphrase"; then
                    error="passphrase mismatch on $repo_path"
                fi
            fi
            archive_count=$(sudo -u borg BORG_PASSPHRASE="${!pass_var}" \
                borg list --short "$repo_path" 2>/dev/null | wc -l || echo 0)
        fi
    fi

    CLIENT_JSON_PARTS+=("{\"name\":\"$name\",\"repo_path\":\"$repo_path\",\"last_archive_iso\":\"$last_iso\",\"last_archive_name\":\"$last_name\",\"archive_count\":$archive_count,\"has_passphrase\":$has_passphrase,\"error\":\"$error\"}")
done

# Join with commas
CLIENTS_JSON=""
for ((i=0; i<${#CLIENT_JSON_PARTS[@]}; i++)); do
    [ $i -gt 0 ] && CLIENTS_JSON="${CLIENTS_JSON},"
    CLIENTS_JSON="${CLIENTS_JSON}${CLIENT_JSON_PARTS[$i]}"
done

TS_BACKEND=$(tailscale status --json 2>/dev/null \
    | grep -oP '"BackendState":\s*"\K[^"]+' | head -1 || echo "")
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || echo "")

UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
HOSTNAME=$(hostname)

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
  "clients": [$CLIENTS_JSON],
  "tailscale": {
    "backend_state": "$TS_BACKEND",
    "ip": "$TS_IP"
  }
}
JSON
STATUSSCRIPT
    chown root:root /usr/local/sbin/pi-status.sh
    chmod 755 /usr/local/sbin/pi-status.sh

    # /usr/local/sbin/pi-action.sh — runs a whitelisted maintenance action.
    # Borg verbs are NOT here — they live in /usr/local/bin/borg-manage.sh
    # under the manager key (so passphrases never persist on the Pi).
    cat > /usr/local/sbin/pi-action.sh << 'ACTIONSCRIPT'
#!/bin/bash
set -u

ACTION="${1:-}"

case "$ACTION" in
    apt-upgrade)
        export DEBIAN_FRONTEND=noninteractive
        echo ">>> apt-get update"
        apt-get update
        echo ">>> apt-get upgrade -y"
        apt-get upgrade -y
        echo ">>> done"
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

    # SSH key restriction (forced command + `restrict` keyword)
    mkdir -p /home/webadmin/.ssh
    cat > /home/webadmin/.ssh/authorized_keys << EOF
command="/usr/local/bin/pi-rpc.sh",restrict ${WEBADMIN_SSH_PUBKEY}
EOF
    chown -R webadmin:webadmin /home/webadmin/.ssh
    chmod 700 /home/webadmin/.ssh
    chmod 600 /home/webadmin/.ssh/authorized_keys

    # Sudoers — write to tempfile, validate with visudo -cf, then install.
    # env_keep lets pi-status.sh see BORG_PASSPHRASE_<NAME> env vars
    # forwarded via SSH SendEnv from the web admin; nothing else stays.
    SUDOERS_TMP=$(mktemp)
    cat > "$SUDOERS_TMP" << 'SUDOERS'
# webadmin: only the actions invoked by /usr/local/bin/pi-rpc.sh.
# Keep BORG_PASSPHRASE_<NAME> across the sudo boundary so pi-status.sh can
# emit full per-client status when the manager forwards passphrases.
Defaults:webadmin env_keep += "BORG_PASSPHRASE_*"

webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-status.sh
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/pi-action.sh apt-upgrade
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
echo "  Configured clients:    $CLIENTS"
for _name in $CLIENTS; do
    _repo=$(client_var "$_name" REPO_PATH)
    echo "    - $_name → $_repo"
done
unset _name _repo
if $BORG_KEY_EXPORTED_THIS_RUN; then
echo -e "  ${RED}>>> One or more new repos were created this run.${NC}"
echo -e "  ${RED}>>> SAVE /home/${ADMIN_USER}/borg-key-backup-<name>.txt OFF THE PI <<<${NC}"
fi
echo ""
echo "  Kopia:                 retired (data + service torn down this run if present)"
echo ""
echo "  Borg backup path:      /usr/local/bin/borg-serve-only.sh (append-only)"
echo "  Borg mgmt path:        /usr/local/bin/borg-manage.sh (allowlist, env passphrase)"
if [[ "${WEBADMIN_SSH_PUBKEY:-CONFIGURE_ME}" != "CONFIGURE_ME" ]]; then
echo "  Web admin RPC:         /usr/local/bin/pi-rpc.sh (status, apt-upgrade, reboot)"
fi
echo "  Firewall:              Active (Tailscale only)"
echo "  Pi-side cron:          SMART monitoring only (borg mgmt runs from neuromancer)"
echo ""

cat <<NEXTSTEPS
============================================
  Next steps
============================================

1) Set a strong piadmin password (NOPASSWD sudo is gone after this run):
       passwd ${ADMIN_USER}
   (Skip if already strong. 20+ random chars from a password manager.)

2) Install borg-pi-manage.sh on neuromancer (the manager host):
       ~/containers/scripts/borg-pi-manage.sh
       ~/containers/scripts/borg-pi-manage.conf
   See ~/containers/docs/SETUP-BACKUP-PI.md for the full procedure.
   Add daily prune+freshness and weekly check+restore-test to chrisl8's user
   crontab on neuromancer.

3) Tailscale ACL setup (in the admin console — the script can't do this):
   The Pi is tagged tag:backup-target. Without ACLs, the tag is decorative
   and a compromised Pi can pivot to other tailnet nodes. Apply this policy
   at https://login.tailscale.com/admin/acls/file:

       {
         "tagOwners": {
           "tag:backup-target": ["autogroup:admin"]
         },
         "acls": [
           // Your existing devices reach each other:
           {"action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:member:*"]},
           // Your devices reach the backup Pi on SSH only:
           {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:backup-target:22"]}
           // NO rule for src=tag:backup-target — the Pi is denied initiating.
         ]
       }

   Verify after applying:
     From the Pi: tailscale ping -c 1 -timeout 3s neuromancer  → expected fail
     From neuromancer: tailscale ping -c 1 backup-pi           → expected OK

4) Test the borg backup path (read-only smoke test) from each client:
NEXTSTEPS
for _name in $CLIENTS; do
    _repo=$(client_var "$_name" REPO_PATH)
    echo "     (as $_name)  BORG_PASSPHRASE=… BORG_RSH=\"ssh -i ~/.ssh/borg_backup\" \\"
    echo "                    borg list ssh://borg@${TAILSCALE_HOSTNAME}${_repo}"
done
unset _name _repo
cat <<NEXTSTEPS2

5) Test the borg-manage path from neuromancer:
     BORG_PASSPHRASE=\$(infisical secrets get BORG_REMOTE_PASSPHRASE ...) \\
       ssh -o SendEnv=BORG_PASSPHRASE -i ~/.ssh/borg-pi-mgmt \\
       borg@${TAILSCALE_HOSTNAME} list-last neuromancer
   Should print the most recent archive line.

6) Verify with the web admin BackupPi page (per-client status).
============================================
NEXTSTEPS2
