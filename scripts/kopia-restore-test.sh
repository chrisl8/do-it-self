#!/bin/bash
# Weekly Kopia restore test — verifies repo content integrity via
# `kopia snapshot verify`, complementing kopia-backup-check.sh's freshness-only
# check. Intended to run via cron Sundays.
#
# First Sunday of the month: also downloads and hashes a sample of real file
# content (KOPIA_VERIFY_FULL_PERCENT). Other Sundays: blob-existence check
# only (still walks every chunk in the repo, just doesn't re-download file
# bytes) — mirrors borg-restore-test.sh's fast/full split.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=kopia-backup-check.conf.example
. "${SCRIPT_DIR}/kopia-backup-check.conf"

mkdir -p "$(dirname "${KOPIA_VERIFY_LOG_FILE}")"
if [ -f "${KOPIA_VERIFY_LOG_FILE}" ]; then
    mv "${KOPIA_VERIFY_LOG_FILE}" "${KOPIA_VERIFY_LOG_FILE}.1"
fi
exec > "${KOPIA_VERIFY_LOG_FILE}" 2>&1

echo "=========================================="
echo "Kopia restore test starting at $(date)"
echo "=========================================="

exec 9>"${KOPIA_VERIFY_LOCK_FILE}"
if ! flock -n 9; then
    echo "ERROR: Another kopia-restore-test.sh is already running"
    exit 1
fi

# Load credentials from Infisical (healthcheck URL only — repo access goes
# through the already-connected `kopia` container, no passphrase needed here)
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

HEALTHCHECK_URL=""
if [ "${SECRETS_AVAILABLE}" = "true" ]; then
    HEALTHCHECK_URL=$(load_secret "kopia-backup-check" "KOPIA_RESTORE_TEST_HEALTHCHECK_URL") || true
fi

if [ -n "${HEALTHCHECK_URL}" ]; then
    curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}/start" > /dev/null || true
fi

TEST_STATUS="success"

if ! docker ps --filter "name=^${KOPIA_CONTAINER}$" --filter "status=running" -q | grep -q .; then
    echo "ERROR: Container ${KOPIA_CONTAINER} is not running"
    TEST_STATUS="failed"
else
    DAY_OF_MONTH=$(date +%d)
    if [ "${DAY_OF_MONTH}" -le 7 ]; then
        CHECK_MODE="full"
        VERIFY_PERCENT="${KOPIA_VERIFY_FULL_PERCENT}"
    else
        CHECK_MODE="fast"
        VERIFY_PERCENT="0"
    fi

    echo ""
    echo "── Snapshot verify (${CHECK_MODE}, verify-files-percent=${VERIFY_PERCENT}) ──"

    if docker exec "${KOPIA_CONTAINER}" kopia snapshot verify \
            --max-errors=1 \
            --verify-files-percent="${VERIFY_PERCENT}"; then
        echo "Snapshot verify passed"
    else
        echo "ERROR: Snapshot verify failed"
        TEST_STATUS="failed"
    fi
fi

echo ""
echo "=========================================="
echo "Kopia restore test finished at $(date) — ${TEST_STATUS}"
echo "=========================================="

# Merge results into the existing kopia-status.json written by
# kopia-backup-check.sh, same pattern borg-restore-test.sh uses for
# BORG_STATUS_FILE.
if [ -f "${KOPIA_STATUS_FILE}" ] && command -v python3 &>/dev/null; then
    TEMP_STATUS=$(mktemp)
    python3 -c "
import json
with open('${KOPIA_STATUS_FILE}') as f:
    data = json.load(f)
data['last_verify'] = '$(date -Iseconds)'
data['verify_status'] = '${TEST_STATUS}'
data['verify_mode'] = '${CHECK_MODE:-unknown}'
with open('${TEMP_STATUS}', 'w') as f:
    json.dump(data, f, indent=4)
" && mv "${TEMP_STATUS}" "${KOPIA_STATUS_FILE}" && chmod 644 "${KOPIA_STATUS_FILE}" || rm -f "${TEMP_STATUS}"
fi

if [ -n "${HEALTHCHECK_URL}" ]; then
    if [ "${TEST_STATUS}" = "success" ]; then
        curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}" > /dev/null || true
    else
        curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}/fail" > /dev/null || true
    fi
fi

if [ "${TEST_STATUS}" = "failed" ]; then
    exit 1
fi
