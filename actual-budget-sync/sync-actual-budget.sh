#!/bin/bash
set -e

export PATH="${HOME}/n/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILURE_THRESHOLD=6
STATE_DIR="${HOME}/.local/state/actual-budget-sync"
FAILURE_COUNT_FILE="${STATE_DIR}/failure_count"
FIRST_FAILURE_FILE="${STATE_DIR}/first_failure"
LOG_FILE="${HOME}/logs/actual-budget-bank-sync.log"

# Exit early if the actual docker container is not running
if ! /usr/bin/docker ps --format '{{.Names}}' | grep -q '^actual-server$'; then
    exit 0
fi

# Ensure state directory exists
mkdir -p "${STATE_DIR}"

# Read current failure count (default 0)
FAILURE_COUNT=0
if [[ -f "${FAILURE_COUNT_FILE}" ]]; then
    FAILURE_COUNT=$(cat "${FAILURE_COUNT_FILE}")
fi

# Load secrets from Infisical (silently no-op if Infisical is unavailable —
# treated like the actual-server-not-running case above, not a sync failure)
if ! command -v infisical &>/dev/null \
   || [[ ! -f "${HOME}/credentials/infisical.env" ]] \
   || ! /usr/bin/docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
    exit 0
fi

# shellcheck disable=SC1091
source "${HOME}/credentials/infisical.env"
export INFISICAL_TOKEN INFISICAL_API_URL

get_secret() {
    local path="$1"
    local key="$2"
    infisical secrets get "${key}" \
        --token="${INFISICAL_TOKEN}" \
        --projectId="${INFISICAL_PROJECT_ID}" \
        --path="${path}" \
        --env=prod \
        --domain="${INFISICAL_API_URL}" \
        --silent --plain 2>/dev/null
}

TS_DOMAIN=$(get_secret "/shared" "TS_DOMAIN") || true
ACTUAL_SERVER_PASSWORD=$(get_secret "/actual-budget-api" "ACTUAL_SERVER_PASSWORD") || true
SYNC_ID=$(get_secret "/actual-budget-api" "SYNC_ID") || true

if [[ -z "${TS_DOMAIN}" || -z "${ACTUAL_SERVER_PASSWORD}" || -z "${SYNC_ID}" ]]; then
    # Required secret missing — silently no-op rather than spamming the failure counter
    exit 0
fi
export TS_DOMAIN ACTUAL_SERVER_PASSWORD SYNC_ID

# Attempt the sync, capturing output and exit code
cd "${SCRIPT_DIR}"
set +e
OUTPUT=$(node actual-budget-bank-sync.js 2>&1)
EXIT_CODE=$?
set -e

# Write output to log file regardless
echo "${OUTPUT}" > "${LOG_FILE}"

if [[ ${EXIT_CODE} -eq 0 ]]; then
    # Success: reset counter, produce no output (no cron email)
    rm -f "${FAILURE_COUNT_FILE}" "${FIRST_FAILURE_FILE}"
    exit 0
fi

# Failure: increment counter
FAILURE_COUNT=$((FAILURE_COUNT + 1))
echo "${FAILURE_COUNT}" > "${FAILURE_COUNT_FILE}"

# Record first failure timestamp if this is the start of a new streak
if [[ ! -f "${FIRST_FAILURE_FILE}" ]]; then
    date -Iseconds > "${FIRST_FAILURE_FILE}"
fi

# Only produce output (triggering cron email) if threshold reached
if [[ ${FAILURE_COUNT} -ge ${FAILURE_THRESHOLD} ]]; then
    FIRST_FAILURE=$(cat "${FIRST_FAILURE_FILE}")
    echo "Actual Budget bank sync: ${FAILURE_COUNT} consecutive failures (since ${FIRST_FAILURE})"
    echo ""
    echo "Latest error output:"
    echo "${OUTPUT}"
    exit 1
fi

# Below threshold: stay silent, exit 0 to suppress cron email
exit 0
