#!/bin/bash
# Idempotent BorgBackup setup script
# Safe to re-run — checks before each action and skips if already done
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERS_DIR="${HOME}/containers"
BORGBACKUP_DIR="${CONTAINERS_DIR}/borgbackup"

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # NoColor

# ── Bootstrap configuration ─────────────────────────────────────

CONF_FILE="${SCRIPT_DIR}/borg-backup.conf"
CONF_EXAMPLE="${SCRIPT_DIR}/borg-backup.conf.example"

if [ ! -f "${CONF_FILE}" ]; then
    if [ -f "${CONF_EXAMPLE}" ]; then
        cp "${CONF_EXAMPLE}" "${CONF_FILE}"
        printf "${YELLOW}[NOTE]${NC} Created %s from template\n" "${CONF_FILE}"
        printf "       Edit this file to configure paths for your system before continuing.\n\n"
    else
        echo "ERROR: Neither ${CONF_FILE} nor ${CONF_EXAMPLE} found"
        exit 1
    fi
fi

# shellcheck source=borg-backup.conf
. "${CONF_FILE}"

if [[ "${BORG_REPO}" == *"YOUR-MOUNT"* ]] || [ -z "${BORG_REPO}" ]; then
    printf "${YELLOW}[WARN]${NC} borg-backup.conf still has placeholder values\n"
    printf "       Fill in the Borg Backup Configuration section on the web admin\n"
    printf "       Backups page (sets repo path, backup paths, and passphrase),\n"
    printf "       then re-run this script. Or edit %s\n" "${CONF_FILE}"
    printf "       directly if you're running shell-only — see borgbackup/SETUP.md.\n"
    exit 1
fi

done_count=0
skip_count=0

done_msg() {
    printf "${GREEN}[DONE]${NC} %s\n" "$1"
    done_count=$((done_count + 1))
}

skip_msg() {
    printf "${YELLOW}[SKIP]${NC} %s (already exists)\n" "$1"
    skip_count=$((skip_count + 1))
}

echo "=========================================="
echo "BorgBackup Setup"
echo "=========================================="
echo ""

# ── Install borgbackup ───────────────────────────────────────────

echo "── System packages ──"
if command -v borg &>/dev/null; then
    BORG_VERSION=$(borg --version)
    skip_msg "borgbackup (${BORG_VERSION})"
else
    echo "Installing borgbackup..."
    sudo apt update
    sudo apt install -y borgbackup
    done_msg "borgbackup installed ($(borg --version))"
fi

if command -v sqlite3 &>/dev/null; then
    skip_msg "sqlite3 ($(sqlite3 --version | awk '{print $1}'))"
else
    echo "Installing sqlite3 (needed for safe SQLite database dumps)..."
    sudo apt update
    sudo apt install -y sqlite3
    done_msg "sqlite3 installed ($(sqlite3 --version | awk '{print $1}'))"
fi
echo ""

# ── Create directories ───────────────────────────────────────────

echo "── Directories ──"

create_dir() {
    if [ -d "$1" ]; then
        skip_msg "$1"
    else
        mkdir -p "$1"
        done_msg "Created $1"
    fi
}

create_dir "${BORGBACKUP_DIR}"
create_dir "${BORG_DB_DUMP_DIR}"
create_dir "${HOME}/logs"
echo ""

# ── Infisical integration ────────────────────────────────────────

echo "── Secret Manager ──"

SECRETS_AVAILABLE=false
if command -v infisical &>/dev/null && \
   [ -f "${HOME}/credentials/infisical.env" ] && \
   docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    export INFISICAL_TOKEN INFISICAL_API_URL
    SECRETS_AVAILABLE=true
    done_msg "Infisical secret manager available"
else
    printf "${YELLOW}[WARN]${NC} Infisical not available — secrets must be set manually\n"
fi

echo ""

# ── Initialize borg repository ───────────────────────────────────

echo "── Borg repository ──"

# Load BORG_PASSPHRASE from Infisical
if [ "${SECRETS_AVAILABLE}" = "true" ]; then
    BORG_PASSPHRASE=$(infisical secrets get BORG_PASSPHRASE --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/borgbackup" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null) || true
fi
export BORG_PASSPHRASE

if [ -d "${BORG_REPO}" ]; then
    skip_msg "Borg repo at ${BORG_REPO}"
else
    if [ -z "${BORG_PASSPHRASE}" ]; then
        printf "${YELLOW}[WARN]${NC} Cannot initialize borg repo — BORG_PASSPHRASE not available\n"
        printf "       Set BORG_PASSPHRASE in Infisical at /borgbackup, then re-run this script\n"
    else
        echo "Initializing borg repository at ${BORG_REPO}..."
        borg init --encryption=repokey-blake2 "${BORG_REPO}"
        done_msg "Initialized borg repo at ${BORG_REPO}"

        # Export the key
        KEY_FILE="${HOME}/credentials/borg-repo-key.txt"
        borg key export "${BORG_REPO}" "${KEY_FILE}"
        chmod 600 "${KEY_FILE}"
        done_msg "Exported borg key to ${KEY_FILE} (store a copy somewhere safe!)"
    fi
fi
echo ""

# ── Remote borg repository ───────────────────────────────────────

echo "── Remote borg repository ──"

if [ -z "${BORG_REMOTE_REPO}" ]; then
    skip_msg "Remote backup (BORG_REMOTE_REPO not set in borg-backup.conf)"
else
    # Test SSH connectivity
    REMOTE_HOST=$(echo "${BORG_REMOTE_REPO}" | sed -n 's|ssh://\([^/]*\)/.*|\1|p')
    if [ -z "${REMOTE_HOST}" ]; then
        printf "${YELLOW}[WARN]${NC} Cannot parse host from BORG_REMOTE_REPO: ${BORG_REMOTE_REPO}\n"
    elif ! ssh -o ConnectTimeout=10 -o BatchMode=yes "${REMOTE_HOST}" "echo ok" &>/dev/null; then
        printf "${YELLOW}[WARN]${NC} Cannot SSH to ${REMOTE_HOST} — check SSH key and config\n"
    else
        done_msg "SSH connectivity to ${REMOTE_HOST}"

        # Load remote passphrase from Infisical
        BORG_REMOTE_PASSPHRASE=""
        if [ "${SECRETS_AVAILABLE}" = "true" ]; then
            BORG_REMOTE_PASSPHRASE=$(infisical secrets get BORG_REMOTE_PASSPHRASE --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/borgbackup" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null) || true
        fi

        if [ -z "${BORG_REMOTE_PASSPHRASE}" ]; then
            printf "${YELLOW}[WARN]${NC} Cannot initialize remote repo — BORG_REMOTE_PASSPHRASE not available\n"
            printf "       Set BORG_REMOTE_PASSPHRASE in Infisical at /borgbackup, then re-run this script\n"
        elif BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg info "${BORG_REMOTE_REPO}" &>/dev/null; then
            skip_msg "Remote borg repo at ${BORG_REMOTE_REPO}"
        else
            echo "Initializing remote borg repository at ${BORG_REMOTE_REPO}..."
            BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg init --encryption=repokey-blake2 "${BORG_REMOTE_REPO}"
            done_msg "Initialized remote borg repo at ${BORG_REMOTE_REPO}"

            # Export the remote key
            REMOTE_KEY_FILE="${HOME}/credentials/borg-remote-repo-key.txt"
            BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg key export "${BORG_REMOTE_REPO}" "${REMOTE_KEY_FILE}"
            chmod 600 "${REMOTE_KEY_FILE}"
            done_msg "Exported remote borg key to ${REMOTE_KEY_FILE} (store a copy somewhere safe!)"
        fi
    fi
fi
echo ""

# ── Make scripts executable ──────────────────────────────────────

echo "── Script permissions ──"
for script in borg-backup.sh borg-db-dump.sh borg-restore-test.sh; do
    SCRIPT_PATH="${SCRIPT_DIR}/${script}"
    if [ -f "${SCRIPT_PATH}" ]; then
        chmod +x "${SCRIPT_PATH}"
        done_msg "Made ${script} executable"
    else
        printf "${YELLOW}[WARN]${NC} %s not found\n" "${SCRIPT_PATH}"
    fi
done
echo ""

# ── Install cron jobs ────────────────────────────────────────────

echo "── Cron jobs ──"

install_cron() {
    local schedule="$1"
    local command="$2"
    local description="$3"
    if crontab -l 2>/dev/null | grep -qF "${command}"; then
        skip_msg "Cron: ${description}"
    else
        (crontab -l 2>/dev/null; echo "${schedule} ${command}") | crontab -
        done_msg "Installed cron: ${description}"
    fi
}

install_cron "0 3 * * *" "${SCRIPT_DIR}/borg-backup.sh" "Daily backup at 3:00 AM"
install_cron "0 6 * * 0" "${SCRIPT_DIR}/borg-restore-test.sh" "Weekly restore test Sundays at 6:00 AM"
echo ""

# ── Create initial status file ───────────────────────────────────

echo "── Status file ──"
STATUS_FILE="${CONTAINERS_DIR}/homepage/images/borg-status.json"
if [ -f "${STATUS_FILE}" ]; then
    skip_msg "${STATUS_FILE}"
else
    cat > "${STATUS_FILE}" << 'STATUSEOF'
{
    "status": "not_run",
    "last_backup": "never",
    "archive": "",
    "duration": "",
    "repo_size": "",
    "archive_count": "0",
    "error": ""
}
STATUSEOF
    done_msg "Created initial ${STATUS_FILE}"
fi
echo ""

# ── Summary ──────────────────────────────────────────────────────

echo "=========================================="
echo "Setup complete: ${done_count} actions performed, ${skip_count} skipped"
echo "=========================================="
echo ""
echo "Configuration: ${CONF_FILE}"
echo ""

# Only show next steps the user actually still has to do. When setup is
# driven from the web admin, most of these are already done.
pending_steps=()
if [ "${SECRETS_AVAILABLE}" != "true" ]; then
    pending_steps+=("Start Infisical on this host — borg passphrases can't be stored without it")
fi
if [ -z "${BORG_PASSPHRASE}" ]; then
    pending_steps+=("Set BORG_PASSPHRASE in Infisical at /borgbackup (web admin Backups page does this), then re-run this script")
fi
if [ -n "${BORG_REMOTE_REPO}" ] && [ -z "${BORG_REMOTE_PASSPHRASE}" ]; then
    pending_steps+=("Set BORG_REMOTE_PASSPHRASE in Infisical at /borgbackup (web admin), then re-run this script")
fi
if [ ! -d "${BORG_REPO}" ]; then
    pending_steps+=("Local borg repo was not initialized — see warnings above")
fi

if [ ${#pending_steps[@]} -eq 0 ]; then
    echo "Next steps:"
    echo "  Run the first backup:"
    echo "     ${SCRIPT_DIR}/borg-backup.sh"
    echo "  (or click 'Run backup now' on the Backups page in the web admin)"
    echo ""
    echo "  Verify: borg list ${BORG_REPO}"
else
    echo "Outstanding before backups will run:"
    for step in "${pending_steps[@]}"; do
        echo "  - ${step}"
    done
fi
echo ""
echo "See borgbackup/SETUP.md for the full walkthrough."
echo ""
