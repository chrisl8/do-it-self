#!/bin/bash
# Main BorgBackup script — runs database dumps, creates archive, prunes, updates status
# Intended to run via cron daily at 3:00 AM
# Flags: --remote-only  skip DB dumps and local backup, run only remote
#        --skip-dumps   skip DB dumps
set -e

# Re-exec as root if not already — needed to read all container mount files
if [ "$(id -u)" -ne 0 ]; then
    exec sudo "$0" --home "${HOME}" "$@"
fi

# When re-execed as root, restore the original user's HOME
if [ "$1" = "--home" ]; then
    HOME="$2"
    shift 2
fi

# Parse flags
REMOTE_ONLY=false
SKIP_DUMPS=false
while [ $# -gt 0 ]; do
    case "$1" in
        --remote-only) REMOTE_ONLY=true; SKIP_DUMPS=true ;;
        --skip-dumps)  SKIP_DUMPS=true ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load configuration
# shellcheck source=borg-backup.conf
. "${SCRIPT_DIR}/borg-backup.conf"

# Ensure log directory exists (redirect happens after credential loading below)
mkdir -p "$(dirname "${BORG_LOG_FILE}")"

# Load credentials from Infisical
load_secret() {
    local container="$1"
    local key="$2"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets get "${key}" --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/${container}" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null && return 0
    fi
    return 1
}

SECRETS_AVAILABLE=false
if command -v infisical &>/dev/null && \
   [ -f "${HOME}/credentials/infisical.env" ] && \
   docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    export INFISICAL_TOKEN INFISICAL_API_URL
    SECRETS_AVAILABLE=true
fi

if [ "${SECRETS_AVAILABLE}" = "true" ]; then
    BORG_PASSPHRASE=$(load_secret "borgbackup" "BORG_PASSPHRASE") || true
    BORG_HEALTHCHECK_URL=$(load_secret "borgbackup" "BORG_HEALTHCHECK_URL") || true
    TS_DOMAIN=$(load_secret "shared" "TS_DOMAIN") || true
fi

# Build web admin URL from hostname and TS_DOMAIN if available
if [ -n "${TS_DOMAIN}" ]; then
    BORG_WEB_ADMIN_URL="http://$(hostname).${TS_DOMAIN}:3333/backup-status"
fi

if [ -n "${BORG_REMOTE_REPO}" ]; then
    BORG_REMOTE_PASSPHRASE=$(load_secret "borgbackup" "BORG_REMOTE_PASSPHRASE") || true
    if [ -z "${BORG_REMOTE_PASSPHRASE}" ]; then
        echo "WARNING: BORG_REMOTE_PASSPHRASE is empty — remote backup will be skipped"
    fi
fi

if [ -z "${BORG_PASSPHRASE}" ] && [ "${REMOTE_ONLY}" != "true" ]; then
    echo "ERROR: BORG_PASSPHRASE is empty — cannot proceed without borg passphrase"
    echo "       Ensure Infisical is running and borgbackup secrets are configured"
    exit 1
fi

# Rotate log files — keep 5 previous runs
if [ -f "${BORG_LOG_FILE}" ]; then
    for i in 4 3 2 1; do
        [ -f "${BORG_LOG_FILE}.$i" ] && mv "${BORG_LOG_FILE}.$i" "${BORG_LOG_FILE}.$((i+1))"
    done
    mv "${BORG_LOG_FILE}" "${BORG_LOG_FILE}.1"
fi

# Redirect all output to log file — after credential loading to avoid
# the tee redirect interfering with command substitution captures
exec > >(tee -a "${BORG_LOG_FILE}") 2>&1

export BORG_PASSPHRASE
export BORG_REPO
export BORG_RSH
export OP_AVAILABLE

echo "=========================================="
echo "BorgBackup starting at $(date)"
echo "=========================================="

# ── Lock file ─────────────────────────────────────────────────────

exec 9>"${BORG_LOCK_FILE}"
if ! flock -n 9; then
    echo "ERROR: Another borg-backup.sh is already running"
    exit 1
fi
# Lock is held for the lifetime of this process (fd 9 closes on exit)

# ── Disk space pre-flight check ─────────────────────────────────

if [ "${REMOTE_ONLY}" != "true" ]; then
    REPO_FREE_KB=$(df -k "${BORG_REPO}" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "${REPO_FREE_KB}" ] && [ "${REPO_FREE_KB}" -lt 104857600 ]; then
        REPO_FREE_GB=$((REPO_FREE_KB / 1048576))
        echo "WARNING: Low disk space on borg repo partition — ${REPO_FREE_GB} GB free"
    fi
fi

# ── Healthcheck start ping ───────────────────────────────────────

if [ -n "${BORG_HEALTHCHECK_URL}" ]; then
    curl -m 10 --retry 5 -s "${BORG_HEALTHCHECK_URL}/start" > /dev/null || true
fi

# Track overall status
BACKUP_STATUS="success"
BACKUP_ERROR=""
START_TIME=$(date +%s)

# ── Database dumps ────────────────────────────────────────────────

DUMP_ERRORS=0
if [ "${SKIP_DUMPS}" = "true" ]; then
    echo ""
    echo "── Database dumps (skipped) ──"
else
    echo ""
    echo "── Database dumps ──"
    "${SCRIPT_DIR}/borg-db-dump.sh" && DUMP_ERRORS=0 || DUMP_ERRORS=$?
    if [ "${DUMP_ERRORS}" -ne 0 ]; then
        echo "WARNING: ${DUMP_ERRORS} database dump(s) failed, continuing with backup"
        # Don't fail the whole backup for dump errors — the data files are still backed up
    fi
fi

# ── Create archive ────────────────────────────────────────────────

ARCHIVE_NAME="backup-$(date +%Y-%m-%dT%H:%M:%S)"

if [ "${REMOTE_ONLY}" = "true" ]; then
    echo ""
    echo "── Local backup (skipped — remote-only mode) ──"
else
    echo ""
    echo "── Creating archive: ${ARCHIVE_NAME} ──"

    # Build the borg create command
    if borg create \
        --compression "${BORG_COMPRESSION}" \
        --exclude-from "${BORG_EXCLUDE_FILE}" \
        --exclude-caches \
        --stats \
        --show-rc \
        "${BORG_REPO}::${ARCHIVE_NAME}" \
        "${BORG_BACKUP_PATHS[@]}"; then
        echo "Archive created successfully"
    else
        BORG_EXIT=$?
        if [ ${BORG_EXIT} -eq 1 ]; then
            echo "WARNING: borg create finished with warnings (exit code 1)"
        else
            echo "ERROR: borg create failed (exit code ${BORG_EXIT})"
            BACKUP_STATUS="failed"
            BACKUP_ERROR="borg create failed with exit code ${BORG_EXIT}"
        fi
    fi

    # ── Prune old archives ───────────────────────────────────────────

    echo ""
    echo "── Pruning old archives ──"

    if borg prune \
        --keep-daily="${BORG_KEEP_DAILY}" \
        --keep-weekly="${BORG_KEEP_WEEKLY}" \
        --keep-monthly="${BORG_KEEP_MONTHLY}" \
        --keep-yearly="${BORG_KEEP_YEARLY}" \
        --stats \
        --show-rc \
        "${BORG_REPO}"; then
        echo "Prune completed successfully"
    else
        echo "WARNING: borg prune had issues"
    fi

    # ── Compact repository ───────────────────────────────────────────

    echo ""
    echo "── Compacting repository ──"

    if borg compact --show-rc "${BORG_REPO}"; then
        echo "Compact completed successfully"
    else
        echo "WARNING: borg compact had issues"
    fi
fi

# ── Remote (offsite) backup ──────────────────────────────────────

REMOTE_STATUS="skipped"
REMOTE_ERROR=""
REMOTE_DURATION=""

run_remote_backup() {
    local REMOTE_BORG_OPTS=()
    if [ "${BORG_REMOTE_RATELIMIT}" -gt 0 ] 2>/dev/null; then
        REMOTE_BORG_OPTS+=(--upload-ratelimit "${BORG_REMOTE_RATELIMIT}")
    fi

    echo "Creating remote archive: ${ARCHIVE_NAME}"
    if BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg create \
        --compression "${BORG_REMOTE_COMPRESSION}" \
        --exclude-from "${BORG_EXCLUDE_FILE}" \
        --exclude-caches \
        --stats \
        --show-rc \
        "${REMOTE_BORG_OPTS[@]}" \
        "${BORG_REMOTE_REPO}::${ARCHIVE_NAME}" \
        "${BORG_BACKUP_PATHS[@]}"; then
        echo "Remote archive created successfully"
    else
        BORG_EXIT=$?
        if [ ${BORG_EXIT} -eq 1 ]; then
            echo "WARNING: remote borg create finished with warnings (exit code 1)"
        else
            return ${BORG_EXIT}
        fi
    fi

    echo ""
    echo "Pruning remote archives"
    BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg prune \
        --keep-daily="${BORG_REMOTE_KEEP_DAILY}" \
        --keep-weekly="${BORG_REMOTE_KEEP_WEEKLY}" \
        --keep-monthly="${BORG_REMOTE_KEEP_MONTHLY}" \
        --keep-yearly="${BORG_REMOTE_KEEP_YEARLY}" \
        --stats \
        --show-rc \
        "${BORG_REMOTE_REPO}" || echo "WARNING: remote borg prune had issues"

    echo ""
    echo "Compacting remote repository"
    BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg compact \
        --show-rc \
        "${BORG_REMOTE_REPO}" || echo "WARNING: remote borg compact had issues"

    return 0
}

if [ -n "${BORG_REMOTE_REPO}" ] && [ -n "${BORG_REMOTE_PASSPHRASE}" ]; then
    echo ""
    echo "── Remote (offsite) backup ──"

    # No pre-flight disk space check — the borg user's shell is restricted to
    # borg serve --append-only (ransomware protection), so we can't run arbitrary
    # commands via SSH. The Pi's own health check monitors disk space and emails alerts.
    REMOTE_START_TIME=$(date +%s)

    if run_remote_backup; then
        REMOTE_STATUS="success"
        echo "Remote backup completed successfully"
    else
        REMOTE_STATUS="failed"
        REMOTE_ERROR="remote borg create failed"
        echo "WARNING: Remote backup failed — local backup is still intact"
    fi

    REMOTE_END_TIME=$(date +%s)
    REMOTE_DURATION_SECS=$((REMOTE_END_TIME - REMOTE_START_TIME))
    REMOTE_DURATION_MIN=$((REMOTE_DURATION_SECS / 60))
    REMOTE_DURATION_REM=$((REMOTE_DURATION_SECS % 60))
    REMOTE_DURATION="${REMOTE_DURATION_MIN}m ${REMOTE_DURATION_REM}s"
elif [ -n "${BORG_REMOTE_REPO}" ]; then
    echo ""
    echo "── Remote (offsite) backup ──"
    echo "Skipped — BORG_REMOTE_PASSPHRASE not available"
fi

# Promote remote failure to overall partial status
if [ "${REMOTE_STATUS}" = "failed" ] && [ "${BACKUP_STATUS}" = "success" ]; then
    BACKUP_STATUS="partial"
    BACKUP_ERROR="Local backup OK but remote backup failed: ${REMOTE_ERROR}"
fi

# ── Update status file ───────────────────────────────────────────

END_TIME=$(date +%s)
DURATION_SECS=$((END_TIME - START_TIME))
DURATION_MIN=$((DURATION_SECS / 60))
DURATION_REM_SECS=$((DURATION_SECS % 60))

# Get repo info for status
if [ "${REMOTE_ONLY}" = "true" ]; then
    REPO_SIZE="skipped"
    ARCHIVE_COUNT="skipped"
else
    REPO_SIZE=$(borg info "${BORG_REPO}" 2>/dev/null | grep "All archives:" | head -1 | awk '{print $7, $8}') || REPO_SIZE="unknown"
    ARCHIVE_COUNT=$(borg list "${BORG_REPO}" 2>/dev/null | wc -l) || ARCHIVE_COUNT="unknown"
fi

mkdir -p "${BORG_STATUS_DIR}"

cat > "${BORG_STATUS_FILE}" << STATUSEOF
{
    "status": "${BACKUP_STATUS}",
    "last_backup": "$(date -Iseconds)",
    "archive": "${ARCHIVE_NAME}",
    "duration": "${DURATION_MIN}m ${DURATION_REM_SECS}s",
    "repo_size": "${REPO_SIZE}",
    "archive_count": "${ARCHIVE_COUNT}",
    "dump_errors": ${DUMP_ERRORS},
    "error": "${BACKUP_ERROR}",
    "remote": {
        "status": "${REMOTE_STATUS}",
        "duration": "${REMOTE_DURATION}",
        "error": "${REMOTE_ERROR}"
    }
}
STATUSEOF
chown 1000:1000 "${BORG_STATUS_FILE}"
chmod 644 "${BORG_STATUS_FILE}"

echo ""
echo "Status written to ${BORG_STATUS_FILE}"
cat "${BORG_STATUS_FILE}"

# ── Healthcheck ping ─────────────────────────────────────────────

if [ -n "${BORG_HEALTHCHECK_URL}" ]; then
    if [ "${BACKUP_STATUS}" = "success" ]; then
        curl -m 10 --retry 5 -s "${BORG_HEALTHCHECK_URL}" > /dev/null || true
    else
        curl -m 10 --retry 5 -s "${BORG_HEALTHCHECK_URL}/fail" --data-raw "${BACKUP_ERROR} — Details: ${BORG_WEB_ADMIN_URL}" > /dev/null || true
    fi
fi

echo ""
echo "=========================================="
echo "BorgBackup finished at $(date) — ${BACKUP_STATUS} (${DURATION_MIN}m)"
echo "=========================================="

if [ "${BACKUP_STATUS}" != "success" ]; then
    echo "Details: ${BORG_WEB_ADMIN_URL}"
    exit 1
fi
