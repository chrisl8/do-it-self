#!/usr/bin/env bash
# Post-update maintenance check for the nextcloud container. Invoked
# automatically by scripts/all-containers.sh after a successful
# `--get-updates` pull/build/restart of nextcloud. Never fails the update
# run: any internal problem is recorded into the findings file instead of
# propagated as a non-zero exit.
#
# What this covers automatically:
#   - waits for Nextcloud to finish any post-upgrade occ upgrade and come
#     back out of maintenance mode
#   - runs the idempotent occ housekeeping commands Nextcloud's own upgrade
#     docs recommend after every update (missing indices/columns/primary keys)
#   - scans nextcloud.log for new error-or-worse entries since the last check
# What it can't cover (still needs a human glance once per update):
#   - Settings > Overview admin warnings (PHP opcache, .htaccess, memory
#     caching, etc.) have no clean headless equivalent, so a reminder link is
#     always included in the findings.
set -u

CONTAINER="nextcloud"
STATE_DIR="${HOME}/.local/state/containers/post-update-checks"
FINDINGS_DIR="${HOME}/logs/post-update-checks"
WATERMARK_FILE="${STATE_DIR}/nextcloud-log-watermark"
FINDINGS_FILE="${FINDINGS_DIR}/nextcloud.json"
LOG_PATH_IN_CONTAINER="/var/www/html/data/nextcloud.log"

mkdir -p "${STATE_DIR}" "${FINDINGS_DIR}"

occ() {
  docker exec -u www-data "${CONTAINER}" php occ "$@" 2>&1
}

write_findings() {
  local status="$1" note="$2" occ_version="$3" maintenance_json="$4" new_errors_json="$5" reminder_url="$6"
  jq -n \
    --arg timestamp "$(date -Iseconds)" \
    --arg status "${status}" \
    --arg note "${note}" \
    --arg occVersion "${occ_version}" \
    --argjson maintenanceCommandsRan "${maintenance_json}" \
    --argjson newLogErrors "${new_errors_json}" \
    --arg reminderUrl "${reminder_url}" \
    '{timestamp: $timestamp, status: $status, note: $note, occVersion: $occVersion, maintenanceCommandsRan: $maintenanceCommandsRan, newLogErrors: $newLogErrors, reminderUrl: $reminderUrl}' \
    > "${FINDINGS_FILE}"
}

# Build the admin-overview reminder link from the tailnet's MagicDNS suffix,
# same lookup container-update-reminder.sh already uses.
TS_DOMAIN=$(tailscale status --json 2>/dev/null | grep -oP '"MagicDNSSuffix":\s*"\K[^"]+' | head -1)
if [[ -n "${TS_DOMAIN}" ]]; then
  REMINDER_URL="https://nextcloud.${TS_DOMAIN}/settings/admin/overview"
else
  REMINDER_URL="https://nextcloud.<your-tailnet>.ts.net/settings/admin/overview"
fi

# Wait for Nextcloud to be installed and out of maintenance mode. A major
# version bump runs its own occ upgrade on container start, which can take a
# while, so this is bounded but generous.
ATTEMPTS=0
MAX_ATTEMPTS=60 # 60 * 10s = 10 minutes
STATUS_OUTPUT=""
while [[ ${ATTEMPTS} -lt ${MAX_ATTEMPTS} ]]; do
  STATUS_OUTPUT="$(occ status)"
  if grep -q "installed: true" <<< "${STATUS_OUTPUT}" && grep -q "maintenance: false" <<< "${STATUS_OUTPUT}"; then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 10
done

if ! grep -q "installed: true" <<< "${STATUS_OUTPUT}" || ! grep -q "maintenance: false" <<< "${STATUS_OUTPUT}"; then
  write_findings "error" "Nextcloud did not report installed/out-of-maintenance within 10 minutes after update; check it by hand." "" "[]" "[]" "${REMINDER_URL}"
  exit 0
fi

OCC_VERSION=$(grep -oP "versionstring:\s*\K.+" <<< "${STATUS_OUTPUT}" | tr -d '[:space:]')

# Idempotent, upstream-recommended post-upgrade housekeeping. db:add-missing-
# indices is silent when nothing is missing; db:add-missing-columns and
# db:add-missing-primary-keys always print a trailing "Done." even when there
# was nothing to do, so that line is stripped before judging whether anything
# actually happened.
MAINTENANCE_JSON="[]"
for CMD in db:add-missing-indices db:add-missing-columns db:add-missing-primary-keys; do
  OUTPUT="$(occ "${CMD}")"
  MEANINGFUL="$(grep -v '^Done\.$' <<< "${OUTPUT}" | tr -d '[:space:]')"
  CHANGED="false"
  if [[ -n "${MEANINGFUL}" ]]; then
    CHANGED="true"
  fi
  MAINTENANCE_JSON=$(jq -c --arg cmd "${CMD}" --arg output "${OUTPUT}" --argjson changed "${CHANGED}" \
    '. += [{command: $cmd, changed: $changed, output: $output}]' <<< "${MAINTENANCE_JSON}")
done

# Scan for new error-or-worse (level >= 3) log entries since the last check,
# using a byte-offset watermark so re-runs only look at what's new.
NEW_ERRORS_JSON="[]"
LOG_SIZE=$(docker exec -u www-data "${CONTAINER}" stat -c %s "${LOG_PATH_IN_CONTAINER}" 2>/dev/null || echo 0)
LAST_WATERMARK=0
[[ -f "${WATERMARK_FILE}" ]] && LAST_WATERMARK=$(cat "${WATERMARK_FILE}")
[[ "${LAST_WATERMARK}" =~ ^[0-9]+$ ]] || LAST_WATERMARK=0

if [[ ${LOG_SIZE} -gt ${LAST_WATERMARK} ]]; then
  NEW_LOG_LINES=$(docker exec -u www-data "${CONTAINER}" tail -c "+$((LAST_WATERMARK + 1))" "${LOG_PATH_IN_CONTAINER}" 2>/dev/null)
  NEW_ERRORS_JSON=$(jq -c '[.level, .app, .message] | {level: .[0], app: .[1], message: .[2]}' <<< "${NEW_LOG_LINES}" 2>/dev/null \
    | jq -c 'select(.level >= 3)' \
    | jq -s '.' 2>/dev/null || echo "[]")
  [[ -z "${NEW_ERRORS_JSON}" ]] && NEW_ERRORS_JSON="[]"
fi
# LOG_SIZE resets to 0 if the file was rotated/truncated since last check;
# don't let a shrunk watermark wedge future scans.
if [[ ${LOG_SIZE} -lt ${LAST_WATERMARK} ]]; then
  LOG_SIZE=0
fi
echo "${LOG_SIZE}" > "${WATERMARK_FILE}"

STATUS="clean"
NOTE="No maintenance actions needed and no new errors found."
if grep -q '"changed":true' <<< "${MAINTENANCE_JSON}" || [[ "${NEW_ERRORS_JSON}" != "[]" ]]; then
  STATUS="attention"
  NOTE="Post-update maintenance ran and/or new log errors were found; also give ${REMINDER_URL} a glance."
fi

write_findings "${STATUS}" "${NOTE}" "${OCC_VERSION}" "${MAINTENANCE_JSON}" "${NEW_ERRORS_JSON}" "${REMINDER_URL}"
exit 0
