#!/bin/bash
# Check freshness of INBOUND borg repos — repos that other hosts push into
# this machine via `borg serve` (e.g. wintermute's borgmatic -> neuromancer).
# Auto-enumerates every borg repo under BORG_INBOUND_REPOS_ROOT, reads the
# latest archive + repo stats via `borg list/info`, and writes a status JSON
# the web admin renders on the Backup Status page. Intended to run via cron.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bootstrap runtime config from the committed template on first run.
if [ ! -f "${SCRIPT_DIR}/borg-inbound-check.conf" ] && \
   [ -f "${SCRIPT_DIR}/borg-inbound-check.conf.example" ]; then
    cp "${SCRIPT_DIR}/borg-inbound-check.conf.example" "${SCRIPT_DIR}/borg-inbound-check.conf"
fi

# Load configuration
# shellcheck source=borg-inbound-check.conf.example
. "${SCRIPT_DIR}/borg-inbound-check.conf"

# Ensure log directory exists
mkdir -p "$(dirname "${BORG_INBOUND_LOG_FILE}")"

# Check for jq
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required but not installed"
    exit 1
fi
if ! command -v borg &>/dev/null; then
    echo "ERROR: borg is required but not installed"
    exit 1
fi

# Load credentials from Infisical (mirrors scripts/borg-backup.sh)
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
    if [ -z "${BORG_INBOUND_HEALTHCHECK_URL}" ]; then
        BORG_INBOUND_HEALTHCHECK_URL=$(load_secret "borg-inbound-check" "HEALTHCHECK_URL") || true
    fi
    TS_DOMAIN=$(load_secret "shared" "TS_DOMAIN") || true
fi

# Build web admin URL from hostname and TS_DOMAIN if available
if [ -n "${TS_DOMAIN}" ]; then
    BORG_INBOUND_WEB_ADMIN_URL="http://$(hostname).${TS_DOMAIN}:3333/backup-status"
fi

# Rotate log files — keep 5 previous runs
if [ -f "${BORG_INBOUND_LOG_FILE}" ]; then
    for i in 4 3 2 1; do
        [ -f "${BORG_INBOUND_LOG_FILE}.$i" ] && mv "${BORG_INBOUND_LOG_FILE}.$i" "${BORG_INBOUND_LOG_FILE}.$((i+1))"
    done
    mv "${BORG_INBOUND_LOG_FILE}" "${BORG_INBOUND_LOG_FILE}.1"
fi

# Redirect all output to the log file (healthchecks.io + web admin handle alerting)
exec > "${BORG_INBOUND_LOG_FILE}" 2>&1

echo "=========================================="
echo "Inbound borg check starting at $(date)"
echo "Repos root: ${BORG_INBOUND_REPOS_ROOT}"
echo "=========================================="

# ── Lock file ─────────────────────────────────────────────────────
exec 9>"${BORG_INBOUND_LOCK_FILE}"
if ! flock -n 9; then
    echo "ERROR: Another borg-inbound-check.sh is already running"
    exit 1
fi

# ── Healthcheck start ping ───────────────────────────────────────
if [ -n "${BORG_INBOUND_HEALTHCHECK_URL}" ]; then
    curl -m 10 --retry 5 -s "${BORG_INBOUND_HEALTHCHECK_URL}/start" > /dev/null || true
fi

# Overall tracking
CHECK_STATUS="success"
CHECK_ERROR=""
REPOS_JSON="[]"
TOTAL_REPOS=0
STALE_REPOS=0
ERROR_REPOS=0
STALE_SUMMARY=""
NOW_EPOCH=$(date +%s)

# Don't let a single repo's `set -e`-tripping command abort the whole run; we
# handle per-repo errors explicitly below.
set +e

if [ ! -d "${BORG_INBOUND_REPOS_ROOT}" ]; then
    echo "ERROR: repos root not found: ${BORG_INBOUND_REPOS_ROOT}"
    CHECK_STATUS="error"
    CHECK_ERROR="repos root not found: ${BORG_INBOUND_REPOS_ROOT}"
fi

if [ "${CHECK_STATUS}" != "error" ]; then
    for repo_dir in "${BORG_INBOUND_REPOS_ROOT}"/*/; do
        repo_dir="${repo_dir%/}"
        [ -d "${repo_dir}" ] || continue
        # Only borg repos: a `config` file containing [repository]
        if ! grep -qs '^\[repository\]' "${repo_dir}/config"; then
            continue
        fi
        name="$(basename "${repo_dir}")"
        TOTAL_REPOS=$((TOTAL_REPOS + 1))
        echo ""
        echo "── Repo: ${name} (${repo_dir}) ──"

        # Map repo name -> Infisical passphrase key (uppercase, '-' -> '_')
        upper="$(echo "${name}" | tr '[:lower:]-' '[:upper:]_')"
        pass_key="BORG_REMOTE_PASSPHRASE_${upper}"
        passphrase="$(load_secret "${BORG_INBOUND_INFISICAL_PATH}" "${pass_key}")"

        repo_status="fresh"
        repo_error=""
        last_archive=""
        last_archive_iso=""
        age_hours="null"
        archive_count="null"
        repo_size_bytes="null"
        repo_size_human=""

        if [ -z "${passphrase}" ]; then
            repo_status="error"
            repo_error="passphrase not available (Infisical key ${pass_key})"
            ERROR_REPOS=$((ERROR_REPOS + 1))
            echo "  ERROR: ${repo_error}"
        else
            export BORG_PASSPHRASE="${passphrase}"
            # One `borg list --json` gives us the full archive list (count +
            # newest). --lock-wait so a concurrent borgmatic push doesn't fail us.
            list_json="$(borg list --json --lock-wait 30 "${repo_dir}" 2>/tmp/borg-inbound-err.$$)"
            list_rc=$?
            if [ "${list_rc}" -ne 0 ]; then
                repo_status="error"
                repo_error="borg list failed: $(tr '\n' ' ' < /tmp/borg-inbound-err.$$ | head -c 300)"
                ERROR_REPOS=$((ERROR_REPOS + 1))
                echo "  ERROR: ${repo_error}"
            else
                archive_count="$(echo "${list_json}" | jq '.archives | length')"
                last_archive="$(echo "${list_json}" | jq -r '.archives | last | .name // ""')"
                last_archive_iso="$(echo "${list_json}" | jq -r '.archives | last | .time // ""')"
                if [ -n "${last_archive_iso}" ]; then
                    snap_epoch="$(date -d "${last_archive_iso}" +%s 2>/dev/null || echo 0)"
                    if [ "${snap_epoch}" -gt 0 ]; then
                        age_hours=$(( (NOW_EPOCH - snap_epoch) / 3600 ))
                    fi
                fi
                # Repo on-disk (deduplicated, compressed) size from borg info.
                info_json="$(borg info --json --lock-wait 30 "${repo_dir}" 2>/dev/null)"
                if [ -n "${info_json}" ]; then
                    repo_size_bytes="$(echo "${info_json}" | jq '.cache.stats.unique_csize // 0')"
                    if [ "${repo_size_bytes}" != "null" ] && [ "${repo_size_bytes}" -gt 0 ] 2>/dev/null; then
                        repo_size_human="$(numfmt --to=iec --suffix=B "${repo_size_bytes}" 2>/dev/null || echo "")"
                    fi
                fi

                if [ "${age_hours}" = "null" ]; then
                    repo_status="error"
                    repo_error="no archives found"
                    ERROR_REPOS=$((ERROR_REPOS + 1))
                    echo "  ERROR: repo has no archives"
                elif [ "${age_hours}" -gt "${BORG_INBOUND_STALE_HOURS}" ]; then
                    repo_status="stale"
                    STALE_REPOS=$((STALE_REPOS + 1))
                    STALE_SUMMARY="${STALE_SUMMARY}  ${name} (${age_hours}h old, threshold ${BORG_INBOUND_STALE_HOURS}h)\n"
                    echo "  STALE: last archive ${last_archive} — ${age_hours}h ago (threshold ${BORG_INBOUND_STALE_HOURS}h)"
                else
                    echo "  OK:    last archive ${last_archive} — ${age_hours}h ago (count ${archive_count}, size ${repo_size_human:-?})"
                fi
            fi
            unset BORG_PASSPHRASE
            rm -f /tmp/borg-inbound-err.$$
        fi

        REPOS_JSON="$(echo "${REPOS_JSON}" | jq \
            --arg name "${name}" \
            --arg path "${repo_dir}" \
            --arg status "${repo_status}" \
            --arg error "${repo_error}" \
            --arg lastArchive "${last_archive}" \
            --arg lastArchiveIso "${last_archive_iso}" \
            --arg repoSizeHuman "${repo_size_human}" \
            --argjson ageHours "${age_hours}" \
            --argjson archiveCount "${archive_count}" \
            --argjson repoSizeBytes "${repo_size_bytes}" \
            --argjson thresholdHours "${BORG_INBOUND_STALE_HOURS}" \
            '. + [{
                name: $name,
                path: $path,
                status: $status,
                error: $error,
                last_archive: $lastArchive,
                last_archive_iso: $lastArchiveIso,
                age_hours: $ageHours,
                archive_count: $archiveCount,
                repo_size_bytes: $repoSizeBytes,
                repo_size: $repoSizeHuman,
                threshold_hours: $thresholdHours
            }]')"
    done
fi

set -e

# Derive overall status
if [ "${CHECK_STATUS}" != "error" ]; then
    if [ "${ERROR_REPOS}" -gt 0 ]; then
        CHECK_STATUS="error"
        CHECK_ERROR="${ERROR_REPOS} of ${TOTAL_REPOS} inbound repo(s) errored"
    elif [ "${STALE_REPOS}" -gt 0 ]; then
        CHECK_STATUS="stale"
        CHECK_ERROR="${STALE_REPOS} of ${TOTAL_REPOS} inbound repo(s) exceed the ${BORG_INBOUND_STALE_HOURS}h threshold"
    elif [ "${TOTAL_REPOS}" -eq 0 ]; then
        CHECK_STATUS="success"
        CHECK_ERROR=""
        echo ""
        echo "No inbound borg repos found under ${BORG_INBOUND_REPOS_ROOT}"
    fi
fi

# ── Write status JSON ────────────────────────────────────────────
mkdir -p "${BORG_INBOUND_STATUS_DIR}"
jq -n \
    --arg status "${CHECK_STATUS}" \
    --arg checked "$(date -Iseconds)" \
    --arg error "${CHECK_ERROR}" \
    --argjson totalRepos "${TOTAL_REPOS}" \
    --argjson staleRepos "${STALE_REPOS}" \
    --argjson errorRepos "${ERROR_REPOS}" \
    --argjson thresholdHours "${BORG_INBOUND_STALE_HOURS}" \
    --argjson repos "${REPOS_JSON}" \
    '{
        status: $status,
        last_check: $checked,
        error: $error,
        total_repos: $totalRepos,
        stale_repos: $staleRepos,
        error_repos: $errorRepos,
        threshold_hours: $thresholdHours,
        repos: $repos
    }' > "${BORG_INBOUND_STATUS_FILE}"

echo ""
echo "Status written to ${BORG_INBOUND_STATUS_FILE}"
cat "${BORG_INBOUND_STATUS_FILE}"

# ── Healthcheck ping ─────────────────────────────────────────────
if [ -n "${BORG_INBOUND_HEALTHCHECK_URL}" ]; then
    if [ "${CHECK_STATUS}" = "success" ]; then
        curl -m 10 --retry 5 -s "${BORG_INBOUND_HEALTHCHECK_URL}" > /dev/null || true
    else
        curl -m 10 --retry 5 -s "${BORG_INBOUND_HEALTHCHECK_URL}/fail" \
            --data-raw "${CHECK_ERROR}\n${STALE_SUMMARY} — Details: ${BORG_INBOUND_WEB_ADMIN_URL}" > /dev/null || true
    fi
fi

echo ""
echo "=========================================="
echo "Inbound borg check finished at $(date) — ${CHECK_STATUS}"
echo "=========================================="

if [ "${CHECK_STATUS}" = "error" ]; then
    exit 1
fi
