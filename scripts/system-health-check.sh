#!/bin/bash

ALL_CONTAINERS_IS_RUNNING=false
if pgrep -f all-containers.sh > /dev/null; then
  ALL_CONTAINERS_IS_RUNNING=true
fi

# If all-containers.sh is running, then just exit,
# unless this script was called BY all-containers.sh itself using the --run-health-check option
# In that case we want to do the health check as normal
if [[ ${ALL_CONTAINERS_IS_RUNNING} = true ]];then
  # This way we don't spam healthcheck.io with pings when the system is doing container updates,
  # meanwhile if the updates take too long healthcheck.io will still alert us after it fails to get a ping
  if [ "$1" != "--run-health-check" ]; then
    exit 0
  fi
fi

EXCLUDED_DEVICES_FOR_EMAIL=""
EXCLUDED_DEVICES_FOR_ERROR_COUNT=""

HEALTH_STATE_DIR="${HOME}/.local/state/containers"
mkdir -p "$HEALTH_STATE_DIR"

# If you want to exclude some tailscale devices from being checked or flagging things as "down", then add it to a file called `excluded_devices.conf` in this directory
# with contents that look like this:
# EXCLUDED_DEVICES_FOR_EMAIL="my-computer1|my-computer2|my-phone"
# EXCLUDED_DEVICES_FOR_ERROR_COUNT="this-server|something-else"

# Load excluded devices configuration from config file
EXCLUDED_DEVICES_CONFIG_FILE="$(dirname "$0")/excluded_devices.conf"

if [ -f "$EXCLUDED_DEVICES_CONFIG_FILE" ]; then
    # Source the config file to get the excluded devices
    # shellcheck source=excluded_devices.conf
    . "$EXCLUDED_DEVICES_CONFIG_FILE"
fi

# For the healthcheck.io ping, you must get a key from that site for yourself, and add it to a file called `healthcheck.conf` in this directory
# with contents that look like this:
# HEALTHCHECK_PING_KEY=YOUR_HEALTHCHECK_PING_KEY

# Load healthcheck.io ping key from config file
HEALTHCHECK_CONFIG_FILE="$(dirname "$0")/healthcheck.conf"
HEALTHCHECK_PING_KEY=""

if [ -f "$HEALTHCHECK_CONFIG_FILE" ]; then
    # Source the config file to get the ping key
    # shellcheck source=healthcheck.conf
    . "$HEALTHCHECK_CONFIG_FILE"
fi

# Only send healthcheck ping if we have a valid key
if [ -n "$HEALTHCHECK_PING_KEY" ]; then
    curl -m 10 --retry 5 -s "https://hc-ping.com/$HEALTHCHECK_PING_KEY/start" > /dev/null
fi

ERROR_COUNT=0

# --- Unhealthy-streak escalation ------------------------------------------
# Track how many consecutive health-check cycles each compose project has been
# unhealthy. Once a project crosses UNHEALTHY_STREAK_THRESHOLD cycles it is
# clearly not self-healing, so we (a) stop the futile 15-minute restart loop for
# it -- which also needlessly bounces its DB sidecars -- by handing
# all-containers.sh a skip-list, and (b) raise a distinct, greppable alert.
# Counters live in HEALTH_STATE_DIR (same idiom as the docker-ps-wc files below)
# and reset automatically when a project goes healthy or disappears (its key is
# simply dropped). Override the threshold in healthcheck.conf if desired
# (default 3 cycles ~= 45 minutes at the */15 cron).
UNHEALTHY_STREAK_THRESHOLD="${UNHEALTHY_STREAK_THRESHOLD:-3}"
# Suspension is NOT permanent. Once over threshold we skip the every-15-min
# restart, but every UNHEALTHY_RETRY_INTERVAL cycles we let ONE attempt through.
# Without this, a project that crossed the threshold while its root cause was
# active (e.g. a DNS outage that left gluetun/ts sidecars unhealthy) stays
# skip-listed forever -- it can't go healthy without a restart, but the restart
# is suspended because it isn't healthy: a deadlock that only manual
# intervention breaks. The periodic retry lets a since-cleared root cause
# self-heal. (default 8 cycles ~= 2h at the */15 cron.)
UNHEALTHY_RETRY_INTERVAL="${UNHEALTHY_RETRY_INTERVAL:-8}"
STREAK_FILE="${HEALTH_STATE_DIR}/unhealthy-streaks.txt"
SKIP_FILE="${HEALTH_STATE_DIR}/unhealthy-skip-list.txt"

declare -A STREAK
if [[ -e "${STREAK_FILE}" ]]; then
  while read -r STREAK_NAME STREAK_COUNT; do
    [[ -n "${STREAK_NAME}" ]] && STREAK["${STREAK_NAME}"]="${STREAK_COUNT}"
  done < "${STREAK_FILE}"
fi

# Current set of unhealthy compose projects: any container in the project whose
# status is not "(healthy)". Non-compose containers (empty project label) are
# ignored -- all-containers.sh cannot act on them anyway.
declare -A UNHEALTHY_NOW
# Delimit with '|' rather than a tab: `read` strips leading IFS *whitespace*, so
# a leading tab would NOT yield an empty first field for a label-less container
# (it would mis-parse the status as the project). '|' is non-whitespace, so a
# leading '|' correctly produces an empty project. Neither project names nor
# docker status strings ever contain '|'.
while IFS='|' read -r UNHEALTHY_PROJECT UNHEALTHY_STATUS; do
  [[ -z "${UNHEALTHY_PROJECT}" ]] && continue
  if [[ "${UNHEALTHY_STATUS}" != *"(healthy)"* ]]; then
    UNHEALTHY_NOW["${UNHEALTHY_PROJECT}"]=1
  fi
done < <(/usr/bin/docker ps -a --format '{{.Label "com.docker.compose.project"}}|{{.Status}}')

# Drop counters for projects that recovered or disappeared (the reset), then
# increment counters for the currently-unhealthy ones.
for STREAK_NAME in "${!STREAK[@]}"; do
  [[ -z "${UNHEALTHY_NOW[$STREAK_NAME]:-}" ]] && unset 'STREAK[$STREAK_NAME]'
done
for UNHEALTHY_PROJECT in "${!UNHEALTHY_NOW[@]}"; do
  STREAK["${UNHEALTHY_PROJECT}"]=$(( ${STREAK[$UNHEALTHY_PROJECT]:-0} + 1 ))
done

# Persist counters and build the skip-list; emit a distinct escalation alert for
# each project that has crossed the threshold.
: > "${STREAK_FILE}"
: > "${SKIP_FILE}"
for STREAK_NAME in "${!STREAK[@]}"; do
  echo "${STREAK_NAME} ${STREAK[$STREAK_NAME]}" >> "${STREAK_FILE}"
  if (( STREAK[$STREAK_NAME] >= UNHEALTHY_STREAK_THRESHOLD )); then
    # Suspend the restart loop EXCEPT on a periodic retry cycle, so a project
    # whose root cause has since cleared can still recover on its own. On a
    # retry cycle we leave it OFF the skip-list, so --restart-unhealthy attempts
    # one (recreating) --stop --start; if it's still broken it lands back here.
    if (( STREAK[$STREAK_NAME] % UNHEALTHY_RETRY_INTERVAL == 0 )); then
      SUSPEND_NOTE="auto-restart suspended; retrying once this cycle"
    else
      echo "${STREAK_NAME}" >> "${SKIP_FILE}"
      SUSPEND_NOTE="auto-restart suspended"
    fi
    echo ""
    echo "ESCALATION: ${STREAK_NAME} has been unhealthy for ${STREAK[$STREAK_NAME]} consecutive checks -- not self-healing, needs attention (${SUSPEND_NOTE})"
    echo ""
    ERROR_COUNT=$((ERROR_COUNT + 1))
  fi
done
# Leave no empty skip file behind.
[[ -s "${SKIP_FILE}" ]] || rm -f "${SKIP_FILE}"

# Restart unhealthy containers automatically
# but don't run it recursively!
if [[ ${ALL_CONTAINERS_IS_RUNNING} = false ]];then
  if [[ -s "${SKIP_FILE}" ]]; then
    "${HOME}/containers/scripts/all-containers.sh" --restart-unhealthy --quiet --no-wait --skip-container-list "${SKIP_FILE}"
  else
    "${HOME}/containers/scripts/all-containers.sh" --restart-unhealthy --quiet --no-wait
  fi
fi

# Ensure web-admin is running (idempotent - does nothing if already running)
"${HOME}/containers/scripts/start-web-admin.sh" start

# Check for unhealthy containers
DOCKER_ISSUES=$(/usr/bin/docker ps -a | tail -n +2 | grep -v "(healthy)")

if [ -n "$DOCKER_ISSUES" ]; then
  echo ""
  echo "Unhealthy containers detected:"
  echo "$DOCKER_ISSUES"
  echo ""
  ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# Check for changes in container count
if ! [[ -e "${HEALTH_STATE_DIR}/docker-ps-wc-previous.txt" ]]; then
  docker ps -a | wc -l > "${HEALTH_STATE_DIR}/docker-ps-wc-previous.txt"
fi
docker ps -a | wc -l > "${HEALTH_STATE_DIR}/docker-ps-wc-now.txt"
if ! diff "${HEALTH_STATE_DIR}/docker-ps-wc-previous.txt" "${HEALTH_STATE_DIR}/docker-ps-wc-now.txt" > /dev/null; then
  PREVIOUS_COUNT=$(<"${HEALTH_STATE_DIR}/docker-ps-wc-previous.txt")
  NOW_COUNT=$(<"${HEALTH_STATE_DIR}/docker-ps-wc-now.txt")
  echo "Docker Container count has changed from $PREVIOUS_COUNT to $NOW_COUNT"
  echo ""
  mv "${HEALTH_STATE_DIR}/docker-ps-wc-now.txt" "${HEALTH_STATE_DIR}/docker-ps-wc-previous.txt"
fi

# Check Tailscale health
if [ -e /usr/bin/tailscale ]; then
  # Tailscale renders shared-in nodes from foreign tailnets with their full FQDN
  # (e.g. "admin.hedgehog-avior.ts.net") in `tailscale status` output, while
  # own-tailnet nodes show only the short hostname. Exclude foreign-tailnet
  # nodes — we don't own them and can't fix them when they go offline.
  FOREIGN_TS_PATTERN='\.ts\.net'

  EMAIL_EXCLUDE="$FOREIGN_TS_PATTERN"
  [ -n "$EXCLUDED_DEVICES_FOR_EMAIL" ] && EMAIL_EXCLUDE="${EMAIL_EXCLUDE}|${EXCLUDED_DEVICES_FOR_EMAIL}"

  ERROR_EXCLUDE="$EMAIL_EXCLUDE"
  [ -n "$EXCLUDED_DEVICES_FOR_ERROR_COUNT" ] && ERROR_EXCLUDE="${ERROR_EXCLUDE}|${EXCLUDED_DEVICES_FOR_ERROR_COUNT}"

  TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EMAIL_EXCLUDE")
  if [ -n "$TAILSCALE_ISSUES" ]; then
    # Wait 15 seconds and check again as often there are transient issues with tailscale status reporting
    sleep 15
    TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EMAIL_EXCLUDE")
    if [ -n "$TAILSCALE_ISSUES" ]; then
      echo ""
      echo "Tailscale issues detected:"
      echo "$TAILSCALE_ISSUES"
      echo ""
      TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$ERROR_EXCLUDE")
      if [ -n "$TAILSCALE_ISSUES" ]; then
        ERROR_COUNT=$((ERROR_COUNT + 1))
      fi
    fi
  fi
fi

# Check Tailscale auth key expiry. Uses the preflight helper to query the
# Tailscale API for the key's expiration date. If the key expires within
# 14 days, treat it as an error so healthchecks.io fires a notification.
PREFLIGHT_SCRIPT="$(dirname "$0")/lib/tailscale-preflight.js"
INFISICAL_CRED_FILE="${HOME}/credentials/infisical.env"
if command -v node &>/dev/null && \
   [ -f "$PREFLIGHT_SCRIPT" ] && \
   command -v infisical &>/dev/null && \
   [ -f "$INFISICAL_CRED_FILE" ] && \
   docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
  # shellcheck disable=SC1090
  source "$INFISICAL_CRED_FILE"
  export INFISICAL_TOKEN INFISICAL_API_URL
  INFISICAL_ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
  # shellcheck disable=SC2086
  eval "$(infisical export ${INFISICAL_ARGS} --path="/shared" --format=dotenv-export 2>/dev/null)"
  if [ -n "${TS_API_TOKEN:-}" ]; then
    PREFLIGHT_JSON=$(TS_API_TOKEN="$TS_API_TOKEN" TS_AUTHKEY="${TS_AUTHKEY:-}" node "$PREFLIGHT_SCRIPT" --json 2>/dev/null) || true
    if [ -n "$PREFLIGHT_JSON" ]; then
      EXPIRY_DAYS=$(echo "$PREFLIGHT_JSON" | jq -r '.checks[] | select(.name == "Auth key expiry") | .expiresInDays // empty' 2>/dev/null)
      if [ -n "$EXPIRY_DAYS" ]; then
        echo ""
        echo "Tailscale auth key expiry warning:"
        echo "  Key expires in ${EXPIRY_DAYS} days. Mint a new one at:"
        echo "  https://login.tailscale.com/admin/settings/keys"
        echo ""
        ERROR_COUNT=$((ERROR_COUNT + 1))
      fi
    fi
  fi
fi

if [ $ERROR_COUNT -gt 0 ]; then
  if [ -n "$HEALTHCHECK_PING_KEY" ]; then
    curl -m 10 --retry 5 -s "https://hc-ping.com/$HEALTHCHECK_PING_KEY/fail" > /dev/null
  fi
  exit 1
fi

if [ -n "$HEALTHCHECK_PING_KEY" ]; then
  curl -m 10 --retry 5 -s "https://hc-ping.com/$HEALTHCHECK_PING_KEY" > /dev/null
fi
