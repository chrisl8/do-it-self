#!/bin/bash
# Check Kopia snapshot freshness and alert via healthchecks.io if any source is stale
# Intended to run via cron every 6 hours
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load configuration
# shellcheck source=kopia-backup-check.conf
. "${SCRIPT_DIR}/kopia-backup-check.conf"

# Load per-host threshold overrides (JSON file, read once)
KOPIA_HOST_THRESHOLDS_FILE="${SCRIPT_DIR}/kopia-host-thresholds.json"
if [ -f "${KOPIA_HOST_THRESHOLDS_FILE}" ]; then
    HOST_THRESHOLDS_JSON=$(cat "${KOPIA_HOST_THRESHOLDS_FILE}")
else
    HOST_THRESHOLDS_JSON="{}"
fi

# Get the effective threshold for a host (per-host override or global default)
get_host_threshold_hours() {
    local host="$1"
    local override
    override=$(echo "${HOST_THRESHOLDS_JSON}" | jq -r --arg h "${host}" '.[$h] // empty')
    if [ -n "${override}" ]; then
        echo "${override}"
    else
        echo "${KOPIA_STALE_HOURS}"
    fi
}

# Ensure log directory exists
mkdir -p "$(dirname "${KOPIA_LOG_FILE}")"

# Check for jq
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required but not installed"
    exit 1
fi

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

HEALTHCHECK_URL=""
if [ "${SECRETS_AVAILABLE}" = "true" ]; then
    HEALTHCHECK_URL=$(load_secret "kopia-backup-check" "HEALTHCHECK_URL") || true
    TS_DOMAIN=$(load_secret "shared" "TS_DOMAIN") || true
fi

# Build web admin URL from hostname and TS_DOMAIN if available
if [ -n "${TS_DOMAIN}" ]; then
    KOPIA_WEB_ADMIN_URL="http://$(hostname).${TS_DOMAIN}:3333/backup-status"
fi

# Rotate log files — keep 5 previous runs
if [ -f "${KOPIA_LOG_FILE}" ]; then
    for i in 4 3 2 1; do
        [ -f "${KOPIA_LOG_FILE}.$i" ] && mv "${KOPIA_LOG_FILE}.$i" "${KOPIA_LOG_FILE}.$((i+1))"
    done
    mv "${KOPIA_LOG_FILE}" "${KOPIA_LOG_FILE}.1"
fi

# Redirect all output to log file only (healthchecks.io and web-admin handle alerting)
exec > "${KOPIA_LOG_FILE}" 2>&1

echo "=========================================="
echo "Kopia backup check starting at $(date)"
echo "=========================================="

# ── Lock file ─────────────────────────────────────────────────────

exec 9>"${KOPIA_LOCK_FILE}"
if ! flock -n 9; then
    echo "ERROR: Another kopia-backup-check.sh is already running"
    exit 1
fi

# ── Healthcheck start ping ───────────────────────────────────────

if [ -n "${HEALTHCHECK_URL}" ]; then
    curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}/start" > /dev/null || true
fi

# Track overall status
CHECK_STATUS="success"
CHECK_ERROR=""

# ── Check container ──────────────────────────────────────────────

echo ""
echo "── Checking container: ${KOPIA_CONTAINER} ──"

if ! docker ps --filter "name=^${KOPIA_CONTAINER}$" --filter "status=running" -q | grep -q .; then
    echo "ERROR: Container ${KOPIA_CONTAINER} is not running"
    CHECK_STATUS="error"
    CHECK_ERROR="Container ${KOPIA_CONTAINER} is not running"
fi

# ── Get and parse snapshots ──────────────────────────────────────

# Check if a host is in the ignore list
is_ignored_host() {
    local check_host="$1"
    for ignored in "${KOPIA_IGNORE_HOSTS[@]}"; do
        [ "${ignored}" = "${check_host}" ] && return 0
    done
    return 1
}

SOURCES_JSON="[]"
STALE_SOURCES=""
STALE_COUNT=0
TOTAL_SOURCES=0

if [ "${CHECK_STATUS}" = "success" ]; then
    echo ""
    echo "── Getting snapshots ──"

    SNAPSHOT_JSON=$(docker exec "${KOPIA_CONTAINER}" kopia snapshot list --all --json 2>/dev/null) || {
        echo "ERROR: Failed to get snapshot list from container"
        CHECK_STATUS="error"
        CHECK_ERROR="Failed to get snapshot list from container"
    }

    if [ "${CHECK_STATUS}" = "success" ]; then
        NOW_EPOCH=$(date +%s)

        # Use jq to group snapshots by source and find the latest endTime per source
        # Output format: host|userName|path|endTime (one line per source)
        LATEST_PER_SOURCE=$(echo "${SNAPSHOT_JSON}" | jq -r '
            group_by(.source.host + "|" + .source.userName + "|" + .source.path)
            | map(
                sort_by(.endTime) | last
                | {
                    host: .source.host,
                    userName: .source.userName,
                    path: .source.path,
                    endTime: .endTime
                }
            )
            | .[]
            | [.host, .userName, .path, .endTime] | @tsv
        ') || {
            echo "ERROR: Failed to parse snapshot JSON with jq"
            CHECK_STATUS="error"
            CHECK_ERROR="Failed to parse snapshot JSON"
        }
    fi

    if [ "${CHECK_STATUS}" = "success" ]; then
        # Build per-source status using process substitution so variables persist
        while IFS=$'\t' read -r host userName path endTime; do
            [ -z "${host}" ] && continue
            TOTAL_SOURCES=$((TOTAL_SOURCES + 1))

            # Parse endTime to epoch — handle ISO 8601 format from Kopia
            SNAP_EPOCH=$(date -d "${endTime}" +%s 2>/dev/null) || SNAP_EPOCH=0
            AGE_SECS=$((NOW_EPOCH - SNAP_EPOCH))
            AGE_HOURS=$((AGE_SECS / 3600))

            # Per-host threshold (override or global default)
            EFFECTIVE_THRESHOLD_HOURS=$(get_host_threshold_hours "${host}")
            EFFECTIVE_THRESHOLD_SECS=$((EFFECTIVE_THRESHOLD_HOURS * 3600))

            if [ "${AGE_SECS}" -gt "${EFFECTIVE_THRESHOLD_SECS}" ]; then
                if is_ignored_host "${host}"; then
                    STATUS="ignored"
                    echo "  SKIP: ${host}@${userName}:${path} — last backup ${AGE_HOURS}h ago (ignored)"
                else
                    STATUS="stale"
                    STALE_COUNT=$((STALE_COUNT + 1))
                    STALE_SOURCES="${STALE_SOURCES}  ${host}@${userName}:${path} (${AGE_HOURS}h old, threshold ${EFFECTIVE_THRESHOLD_HOURS}h)\n"
                    echo "  STALE: ${host}@${userName}:${path} — last backup ${AGE_HOURS}h ago (threshold ${EFFECTIVE_THRESHOLD_HOURS}h)"
                fi
            else
                STATUS="fresh"
                echo "  OK:    ${host}@${userName}:${path} — last backup ${AGE_HOURS}h ago (threshold ${EFFECTIVE_THRESHOLD_HOURS}h)"
            fi

            # Accumulate source entries as JSON using jq
            SOURCES_JSON=$(echo "${SOURCES_JSON}" | jq \
                --arg host "${host}" \
                --arg userName "${userName}" \
                --arg path "${path}" \
                --arg endTime "${endTime}" \
                --arg status "${STATUS}" \
                --argjson ageHours "${AGE_HOURS}" \
                --argjson effectiveThreshold "${EFFECTIVE_THRESHOLD_HOURS}" \
                '. + [{host: $host, userName: $userName, path: $path, lastSnapshot: $endTime, status: $status, ageHours: $ageHours, effectiveThreshold: $effectiveThreshold}]')
        done < <(echo "${LATEST_PER_SOURCE}")

        if [ "${STALE_COUNT}" -gt 0 ]; then
            CHECK_STATUS="stale"
            CHECK_ERROR="${STALE_COUNT} of ${TOTAL_SOURCES} source(s) exceed their stale threshold"
            echo ""
            echo "WARNING: ${CHECK_ERROR}"
            echo "Details: ${KOPIA_WEB_ADMIN_URL}"
        else
            echo ""
            echo "All ${TOTAL_SOURCES} source(s) are fresh (default threshold ${KOPIA_STALE_HOURS}h)"
        fi
    fi
fi

# ── Write status JSON ────────────────────────────────────────────

mkdir -p "${KOPIA_STATUS_DIR}"

jq -n \
    --arg status "${CHECK_STATUS}" \
    --arg checked "$(date -Iseconds)" \
    --argjson totalSources "${TOTAL_SOURCES}" \
    --argjson staleSources "${STALE_COUNT}" \
    --arg thresholdHours "${KOPIA_STALE_HOURS}" \
    --arg error "${CHECK_ERROR}" \
    --argjson sources "${SOURCES_JSON}" \
    '{
        status: $status,
        last_check: $checked,
        total_sources: $totalSources,
        stale_sources: $staleSources,
        threshold_hours: ($thresholdHours | tonumber),
        error: $error,
        sources: $sources
    }' > "${KOPIA_STATUS_FILE}"

echo ""
echo "Status written to ${KOPIA_STATUS_FILE}"
cat "${KOPIA_STATUS_FILE}"

# ── Healthcheck ping ─────────────────────────────────────────────

if [ -n "${HEALTHCHECK_URL}" ]; then
    if [ "${CHECK_STATUS}" = "success" ]; then
        curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}" > /dev/null || true
    else
        curl -m 10 --retry 5 -s "${HEALTHCHECK_URL}/fail" --data-raw "${CHECK_ERROR} — Details: ${KOPIA_WEB_ADMIN_URL}" > /dev/null || true
    fi
fi

echo ""
echo "=========================================="
echo "Kopia backup check finished at $(date) — ${CHECK_STATUS}"
echo "=========================================="

if [ "${CHECK_STATUS}" = "error" ]; then
    exit 1
fi
