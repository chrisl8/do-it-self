#!/bin/bash
# Weekly borg restore test — verifies repo integrity and test extraction
# Intended to run via cron Sundays at 6:00 AM
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

# After a sudo re-exec, $USER is "root"; use SUDO_USER to recover the real user
# so we can resolve "home/<user>/credentials/" inside the archive correctly.
ORIGINAL_USER="${SUDO_USER:-${USER}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load configuration
# shellcheck source=borg-backup.conf
. "${SCRIPT_DIR}/borg-backup.conf"

# ── Log setup (first, so early failures are captured) ──────────
LOG_FILE="${HOME}/logs/borg-restore-test.log"
mkdir -p "$(dirname "${LOG_FILE}")"
if [ -f "${LOG_FILE}" ]; then
    mv "${LOG_FILE}" "${LOG_FILE}.1"
fi
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "=========================================="
echo "Borg restore test starting at $(date)"
echo "=========================================="

# ── Failure-reporting setup ────────────────────────────────────
# Load a cached healthcheck URL written by previous successful runs so we can
# still ping /fail if Infisical is unreachable on this run. Without this, any
# failure before the Infisical load went silently undetected (see Apr 12 2026).
CACHED_HC_FILE="${HOME}/.cache/borg/restore-test-healthcheck.env"
if [ -f "${CACHED_HC_FILE}" ]; then
    # shellcheck disable=SC1090
    source "${CACHED_HC_FILE}"
fi

TEST_DIR=""
TEST_STATUS="success"

ping_fail() {
    if [ -n "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" ]; then
        curl -m 10 --retry 5 -s "${BORG_RESTORE_TEST_HEALTHCHECK_URL}/fail" > /dev/null || true
    fi
}

cleanup() {
    if [ -n "${TEST_DIR}" ] && [ -d "${TEST_DIR}" ]; then
        echo "Cleaning up test directory: ${TEST_DIR}"
        rm -rf "${TEST_DIR}"
    fi
}

on_exit() {
    local rc=$?
    if [ "${rc}" -ne 0 ]; then
        echo "ERROR: script exiting with rc=${rc} — pinging healthchecks /fail"
        ping_fail
    fi
    cleanup
}
trap on_exit EXIT

# Load a secret from Infisical
load_secret() {
    local container="$1"
    local key="$2"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets get "${key}" --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/${container}" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null && return 0
    fi
    return 1
}

# Retry load_secret to ride through brief Infisical/network blips
load_secret_retry() {
    local container="$1"
    local key="$2"
    local max_tries=3
    local delay=10
    local attempt=1
    local value=""
    while [ "${attempt}" -le "${max_tries}" ]; do
        if value=$(load_secret "${container}" "${key}"); then
            printf '%s' "${value}"
            return 0
        fi
        if [ "${attempt}" -lt "${max_tries}" ]; then
            echo "WARN: load_secret ${container}/${key} failed (attempt ${attempt}/${max_tries}), retrying in ${delay}s..." >&2
            sleep "${delay}"
        fi
        attempt=$((attempt + 1))
    done
    return 1
}

# Load credentials from Infisical
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
    BORG_PASSPHRASE=$(load_secret_retry "borgbackup" "BORG_PASSPHRASE") || true
    BORG_RESTORE_TEST_HEALTHCHECK_URL=$(load_secret "borgbackup" "BORG_RESTORE_TEST_HEALTHCHECK_URL") || true
    if [ -n "${BORG_REMOTE_REPO}" ]; then
        BORG_REMOTE_PASSPHRASE=$(load_secret "borgbackup" "BORG_REMOTE_PASSPHRASE") || true
    fi
fi

# Cache the healthcheck URL so the trap can ping /fail on future runs even if
# Infisical is unreachable.
if [ -n "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" ]; then
    mkdir -p "$(dirname "${CACHED_HC_FILE}")"
    printf 'BORG_RESTORE_TEST_HEALTHCHECK_URL=%q\n' "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" > "${CACHED_HC_FILE}"
    chmod 600 "${CACHED_HC_FILE}"
fi

if [ -z "${BORG_PASSPHRASE}" ]; then
    echo "ERROR: BORG_PASSPHRASE is empty — cannot proceed without borg passphrase"
    echo "       Ensure Infisical is running and borgbackup secrets are configured"
    exit 1
fi

export BORG_PASSPHRASE
export BORG_REPO
export BORG_RSH

if [ -n "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" ]; then
    curl -m 10 --retry 5 -s "${BORG_RESTORE_TEST_HEALTHCHECK_URL}/start" > /dev/null || true
fi

TEST_DIR=$(mktemp -d /tmp/borg-restore-test.XXXXXX)

# ── Repository integrity check ───────────────────────────────────

# First Sunday of month: full data verification (slow, verifies every byte)
# Other Sundays: repository-only check (fast, verifies repo structure/consistency)
DAY_OF_MONTH=$(date +%d)
if [ "${DAY_OF_MONTH}" -le 7 ]; then
    CHECK_MODE="full"
    BORG_CHECK_ARGS="--verify-data --show-rc"
else
    CHECK_MODE="fast"
    BORG_CHECK_ARGS="--repository-only --show-rc"
fi

echo ""
echo "── Repository integrity check (${CHECK_MODE}) ──"

# BORG_CHECK_ARGS contains multiple flags, must word-split
# shellcheck disable=SC2086
if borg check ${BORG_CHECK_ARGS} "${BORG_REPO}"; then
    echo "Repository integrity check passed"
else
    echo "ERROR: Repository integrity check failed"
    TEST_STATUS="failed"
fi

# ── Test extraction ──────────────────────────────────────────────

echo ""
echo "── Test extraction ──"

# Get the latest archive name
LATEST_ARCHIVE=$(borg list --last 1 --format '{archive}' "${BORG_REPO}" 2>/dev/null)

if [ -z "${LATEST_ARCHIVE}" ]; then
    echo "ERROR: No archives found in repository"
    TEST_STATUS="failed"
else
    echo "Testing extraction from: ${LATEST_ARCHIVE}"

    # Extract just the credentials directory as a test (small, critical)
    echo "  Extracting ~/credentials/ ..."
    cd "${TEST_DIR}"
    if borg extract "${BORG_REPO}::${LATEST_ARCHIVE}" "home/${ORIGINAL_USER}/credentials/"; then
        FILE_COUNT=$(find "${TEST_DIR}" -type f | wc -l)
        echo "  Extracted ${FILE_COUNT} files successfully"
        if [ "${FILE_COUNT}" -eq 0 ]; then
            echo "  WARNING: No files extracted — possible issue"
            TEST_STATUS="failed"
        fi
    else
        echo "  ERROR: Extraction failed"
        TEST_STATUS="failed"
    fi

    # Verify database dumps can be extracted
    echo "  Extracting db-dumps/ ..."
    if borg extract "${BORG_REPO}::${LATEST_ARCHIVE}" "${BORG_DB_DUMP_DIR#/}/"; then
        DUMP_COUNT=$(find "${TEST_DIR}" -name "*.sql" -o -name "*.sql.gz" -o -name "*.archive" -o -name "*.archive.gz" -o -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" -o -name "*.sqlite.gz" -o -name "*.sqlite3.gz" -o -name "*.db.gz" | wc -l)
        echo "  Extracted ${DUMP_COUNT} dump files successfully"
        if [ "${DUMP_COUNT}" -eq 0 ]; then
            echo "  WARNING: No dump files found in extraction"
        fi
    else
        echo "  WARNING: Could not extract db-dumps (may not exist in archive yet)"
    fi

    # Verify a sample file can be extracted
    SAMPLE_PATH="${BORG_RESTORE_TEST_SAMPLE_PATH:-etc/hostname}"
    echo "  Extracting sample file (${SAMPLE_PATH}) ..."
    if borg extract "${BORG_REPO}::${LATEST_ARCHIVE}" "${SAMPLE_PATH}"; then
        echo "  Sample file extraction OK"
    else
        echo "  WARNING: Could not extract ${SAMPLE_PATH}"
    fi
fi

# ── Remote repository integrity check ────────────────────────────

REMOTE_INTEGRITY_STATUS="skipped"

if [ -n "${BORG_REMOTE_REPO}" ] && [ -n "${BORG_REMOTE_PASSPHRASE}" ]; then
    echo ""
    echo "── Remote repository integrity check ──"

    # BORG_CHECK_ARGS contains multiple flags, must word-split
    # shellcheck disable=SC2086
    if BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg check ${BORG_CHECK_ARGS} "${BORG_REMOTE_REPO}"; then
        echo "Remote repository integrity check passed"
        REMOTE_INTEGRITY_STATUS="success"
    else
        echo "WARNING: Remote repository integrity check failed"
        REMOTE_INTEGRITY_STATUS="failed"
        # Remote failure is a warning only — does not fail the overall test
    fi

    # List latest remote archives for visibility
    echo ""
    echo "Latest remote archives:"
    BORG_PASSPHRASE="${BORG_REMOTE_PASSPHRASE}" borg list --last 3 "${BORG_REMOTE_REPO}" 2>/dev/null || true
elif [ -n "${BORG_REMOTE_REPO}" ]; then
    echo ""
    echo "── Remote repository integrity check ──"
    echo "Skipped — BORG_REMOTE_PASSPHRASE not available"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "Restore test finished at $(date) — ${TEST_STATUS}"
echo "=========================================="

# Update status file with test results
if [ -f "${BORG_STATUS_FILE}" ]; then
    # Use a temp file to update the status JSON
    TEMP_STATUS=$(mktemp)
    if command -v python3 &>/dev/null; then
        python3 -c "
import json, sys
with open('${BORG_STATUS_FILE}') as f:
    data = json.load(f)
data['last_integrity_check'] = '$(date -Iseconds)'
data['integrity_status'] = '${TEST_STATUS}'
data['remote_integrity_status'] = '${REMOTE_INTEGRITY_STATUS}'
with open('${TEMP_STATUS}', 'w') as f:
    json.dump(data, f, indent=4)
" && mv "${TEMP_STATUS}" "${BORG_STATUS_FILE}" && chown 1000:1000 "${BORG_STATUS_FILE}" && chmod 644 "${BORG_STATUS_FILE}"
    else
        rm -f "${TEMP_STATUS}"
    fi
fi

if [ -n "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" ]; then
    if [ "${TEST_STATUS}" = "success" ]; then
        curl -m 10 --retry 5 -s "${BORG_RESTORE_TEST_HEALTHCHECK_URL}" > /dev/null || true
    else
        curl -m 10 --retry 5 -s "${BORG_RESTORE_TEST_HEALTHCHECK_URL}/fail" > /dev/null || true
    fi
fi

if [ "${TEST_STATUS}" = "failed" ]; then
    exit 1
fi
