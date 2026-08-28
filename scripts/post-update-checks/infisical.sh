#!/usr/bin/env bash
# Post-update maintenance check for the infisical container. Invoked
# automatically by scripts/all-containers.sh after a successful
# `--get-updates` pull/build/restart of infisical. Never fails the update
# run: any internal problem is recorded into the findings file instead of
# propagated as a non-zero exit.
#
# Why infisical gets its own checker (see [[project_webadmin_env_leak_infisical_upgrade]]
# in memory): infisical runs an irreversible DB migration on every startup and
# every other container's secrets flow through it. Docker's own healthcheck
# only curls /api/status, which can report healthy even when something more
# specific broke (e.g. a machine-identity/token incompatibility after a major
# version bump). This script instead re-runs the exact `infisical export`
# call all-containers.sh itself relies on to inject shared secrets -- if that
# doesn't work post-update, nothing downstream will either.
set -u

CONTAINER="infisical"
FINDINGS_DIR="${HOME}/logs/post-update-checks"
FINDINGS_FILE="${FINDINGS_DIR}/infisical.json"
CRED_FILE="${HOME}/credentials/infisical.env"

mkdir -p "${FINDINGS_DIR}"

write_findings() {
  local status="$1" note="$2"
  jq -n \
    --arg timestamp "$(date -Iseconds)" \
    --arg status "${status}" \
    --arg note "${note}" \
    '{timestamp: $timestamp, status: $status, note: $note}' \
    > "${FINDINGS_FILE}"
}

# Wait for docker's own healthcheck first -- no point probing the API before
# that passes.
ATTEMPTS=0
MAX_ATTEMPTS=30 # 30 * 10s = 5 minutes
HEALTH=""
while [[ ${ATTEMPTS} -lt ${MAX_ATTEMPTS} ]]; do
  HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null)
  [[ "${HEALTH}" = "healthy" ]] && break
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 10
done

if [[ "${HEALTH}" != "healthy" ]]; then
  write_findings "error" "infisical did not report healthy within 5 minutes after update; check it by hand."
  exit 0
fi

if [[ ! -f "${CRED_FILE}" ]]; then
  write_findings "error" "No ${CRED_FILE} found -- cannot verify secret export after update."
  exit 0
fi

RESTART_COUNT=$(docker inspect --format '{{.RestartCount}}' "${CONTAINER}" 2>/dev/null || echo 0)

# shellcheck disable=SC1090
source "${CRED_FILE}"
export INFISICAL_TOKEN INFISICAL_API_URL
INFISICAL_ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"

EXPORT_OUTPUT=""
EXPORT_EXIT=1
if [[ -x "$(command -v infisical)" ]]; then
  EXPORT_OUTPUT="$(infisical export ${INFISICAL_ARGS} --path="/shared" --format=dotenv-export 2>&1)"
  EXPORT_EXIT=$?
fi

if [[ ${EXPORT_EXIT} -ne 0 ]] || [[ -z "${EXPORT_OUTPUT}" ]]; then
  write_findings "attention" "infisical is healthy but 'infisical export --path=/shared' failed or returned nothing (exit ${EXPORT_EXIT}). Every other container's secret injection depends on this -- investigate before updating anything else. Output: ${EXPORT_OUTPUT}"
  exit 0
fi

if [[ ${RESTART_COUNT} -gt 0 ]]; then
  write_findings "attention" "infisical is healthy and secrets export fine, but it restarted ${RESTART_COUNT} time(s) during this update -- worth a look at 'docker logs infisical' for why."
  exit 0
fi

write_findings "clean" "Healthy, no restarts, and 'infisical export --path=/shared' succeeded."
exit 0
