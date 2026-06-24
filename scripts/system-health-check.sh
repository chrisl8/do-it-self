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

# Local append-only alert log. healthchecks.io records WHEN we ping /fail but not
# WHY (fail pings carry no body), and the cause text below is otherwise only
# emailed via cron -> postfix -> Fastmail, leaving nothing reviewable on the box.
# `note` mirrors a line to stdout (so cron still emails it) AND to ALERT_BUFFER,
# which is persisted to ALERT_LOG (and sent as the /fail ping body) on failure.
ALERT_LOG="${HOME}/logs/health-check-alerts.log"
ALERT_BUFFER=""
note() { echo "$1"; ALERT_BUFFER+="${1}"$'\n'; }

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
    note "ESCALATION: ${STREAK_NAME} has been unhealthy for ${STREAK[$STREAK_NAME]} consecutive checks -- not self-healing, needs attention (${SUSPEND_NOTE})"
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
  note "Unhealthy containers detected:"
  note "$DOCKER_ISSUES"
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

  # First pass plus a 15s re-probe: `tailscale status` frequently reports a peer
  # offline for a few seconds during a coordination refresh, so a single sample
  # is not trustworthy. EMAIL_EXCLUDE drops peers we don't own / can't fix.
  TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EMAIL_EXCLUDE")
  if [ -n "$TAILSCALE_ISSUES" ]; then
    # Wait 15 seconds and check again as often there are transient issues with tailscale status reporting
    sleep 15
    TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EMAIL_EXCLUDE")
  fi

  # --- Tailscale offline-streak gating ------------------------------------
  # A momentary loss of THIS host's tailscaled map-poll (the control-plane
  # long-poll; journal warnable `not-in-map-poll`) freezes every peer's
  # "last seen" clock, so a single cycle can show many peers "offline" at once
  # even though nothing is actually down -- they all self-heal within a cycle.
  # Paging on that is crying wolf. So, exactly like the container UNHEALTHY_STREAK
  # logic above, only count a peer as a real error once it has been offline for
  # TAILSCALE_OFFLINE_STREAK_THRESHOLD *consecutive* cycles (default 2 ~= 30m at
  # the */15 cron; override in healthcheck.conf). Per-peer counters live in
  # HEALTH_STATE_DIR and reset the instant a peer returns. Every raw observation
  # -- paged or not -- is appended to TS_TREND_LOG so the underlying blip pattern
  # stays diagnosable, alongside the WAN reachability logger that records which
  # network layer blipped.
  TAILSCALE_OFFLINE_STREAK_THRESHOLD="${TAILSCALE_OFFLINE_STREAK_THRESHOLD:-2}"
  TS_STREAK_FILE="${HEALTH_STATE_DIR}/tailscale-offline-streaks.txt"
  TS_TREND_LOG="${HOME}/logs/tailscale-offline-trend.log"

  if [ -n "$TAILSCALE_ISSUES" ]; then
    # Record every observation (append-only, self-trimmed) regardless of whether
    # it will page -- this is the raw data set for diagnosing the recurring blips.
    mkdir -p "$(dirname "$TS_TREND_LOG")"
    { printf '===== %s =====\n' "$(date '+%F %T %Z')"
      printf '%s\n' "$TAILSCALE_ISSUES"; } >> "$TS_TREND_LOG"
    if [ "$(wc -l < "$TS_TREND_LOG" 2>/dev/null || echo 0)" -gt 5000 ]; then
      tail -n 2000 "$TS_TREND_LOG" > "${TS_TREND_LOG}.tmp" && mv "${TS_TREND_LOG}.tmp" "$TS_TREND_LOG"
    fi
  fi

  # Error-eligible offline peers = those not on the error-exclude list, keyed by
  # hostname (column 2 of `tailscale status`).
  TS_ERROR_NAMES=$(printf '%s\n' "$TAILSCALE_ISSUES" | grep -vE "$ERROR_EXCLUDE" | awk 'NF{print $2}')

  declare -A TS_STREAK
  if [[ -e "${TS_STREAK_FILE}" ]]; then
    while read -r TS_NAME TS_COUNT; do
      [[ -n "${TS_NAME}" ]] && TS_STREAK["${TS_NAME}"]="${TS_COUNT}"
    done < "${TS_STREAK_FILE}"
  fi

  declare -A TS_OFFLINE_NOW
  while read -r TS_NAME; do
    [[ -n "${TS_NAME}" ]] && TS_OFFLINE_NOW["${TS_NAME}"]=1
  done < <(printf '%s\n' "$TS_ERROR_NAMES")

  # Reset counters for peers that recovered or dropped off the list; increment
  # the still-offline ones.
  for TS_NAME in "${!TS_STREAK[@]}"; do
    [[ -z "${TS_OFFLINE_NOW[$TS_NAME]:-}" ]] && unset 'TS_STREAK[$TS_NAME]'
  done
  for TS_NAME in "${!TS_OFFLINE_NOW[@]}"; do
    TS_STREAK["${TS_NAME}"]=$(( ${TS_STREAK[$TS_NAME]:-0} + 1 ))
  done

  # Persist counters and collect any peer that has crossed the threshold.
  : > "${TS_STREAK_FILE}"
  TS_SUSTAINED=""
  for TS_NAME in "${!TS_STREAK[@]}"; do
    echo "${TS_NAME} ${TS_STREAK[$TS_NAME]}" >> "${TS_STREAK_FILE}"
    if (( TS_STREAK[$TS_NAME] >= TAILSCALE_OFFLINE_STREAK_THRESHOLD )); then
      TS_SUSTAINED+="  ${TS_NAME} (offline ${TS_STREAK[$TS_NAME]} consecutive checks)"$'\n'
    fi
  done
  [[ -s "${TS_STREAK_FILE}" ]] || rm -f "${TS_STREAK_FILE}"

  # Only NOW -- past the streak threshold -- treat it as a real, page-worthy
  # error, and enrich the alert with on-box diagnostics so the page explains
  # which layer is at fault without a human having to dig.
  if [ -n "$TS_SUSTAINED" ]; then
    echo ""
    note "Tailscale peers offline past ${TAILSCALE_OFFLINE_STREAK_THRESHOLD} consecutive checks (sustained -- not a momentary blip):"
    note "$TS_SUSTAINED"
    NETCHECK_OUT=$(/usr/bin/tailscale netcheck 2>/dev/null | grep -iE 'DERP|IPv4:|UDP:|MappingVaries|PortMapping|latency' | head -12)
    if [ -n "$NETCHECK_OUT" ]; then
      note "tailscale netcheck:"
      note "$NETCHECK_OUT"
    fi
    if [ -f "${HOME}/logs/wan-reachability.log" ]; then
      note "recent WAN reachability (gw=LAN wan=internet ctrl=tailscale control plane):"
      note "$(tail -n 12 "${HOME}/logs/wan-reachability.log")"
    fi
    echo ""
    ERROR_COUNT=$((ERROR_COUNT + 1))
  fi
fi

# Check Tailscale auth key expiry. Uses the preflight helper to query the
# Tailscale API for the key's expiration date. The preflight surfaces an
# advisory once the key is within 14 days of expiry (also shown in the web
# admin); here we only ALARM -- page healthchecks.io + email -- once it is
# within AUTH_KEY_EXPIRY_ALARM_DAYS (default 10), and then at most once per
# 24h so it does not nag every 15-minute cycle for days on end.
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
      # Only ALARM within the (narrower) alarm window. The preflight already
      # gates its advisory at <=14 days; we narrow the active page/email to
      # <=10 so the passive dashboard hint can lead the alarm.
      AUTH_KEY_EXPIRY_ALARM_DAYS="${AUTH_KEY_EXPIRY_ALARM_DAYS:-10}"
      if [[ "$EXPIRY_DAYS" =~ ^[0-9]+$ ]] && (( EXPIRY_DAYS <= AUTH_KEY_EXPIRY_ALARM_DAYS )); then
        # Throttle: without this the warning fires every */15 cycle (~96x/day)
        # for up to AUTH_KEY_EXPIRY_ALARM_DAYS days. Warn at most once per 24h via
        # a stamp in HEALTH_STATE_DIR -- loud enough to act on, not a nag.
        EXPIRY_STAMP="${HEALTH_STATE_DIR}/auth-key-expiry-last-warned"
        NOW_EPOCH=$(date +%s)
        LAST_WARNED=0
        [[ -f "$EXPIRY_STAMP" ]] && LAST_WARNED=$(cat "$EXPIRY_STAMP" 2>/dev/null || echo 0)
        [[ "$LAST_WARNED" =~ ^[0-9]+$ ]] || LAST_WARNED=0
        if (( NOW_EPOCH - LAST_WARNED >= 86400 )); then
          echo ""
          note "Tailscale auth key expiry warning:"
          note "  Key expires in ${EXPIRY_DAYS} days. Mint a new one at:"
          note "  https://login.tailscale.com/admin/settings/keys"
          echo ""
          echo "$NOW_EPOCH" > "$EXPIRY_STAMP"
          ERROR_COUNT=$((ERROR_COUNT + 1))
        fi
      fi
    fi
  fi
fi

if [ $ERROR_COUNT -gt 0 ]; then
  # Persist the cause locally (timestamped, append-only) so recent alerts stay
  # reviewable on the box even after the cron email is gone.
  mkdir -p "$(dirname "$ALERT_LOG")"
  { printf '===== %s (%d issue(s)) =====\n' "$(date '+%F %T %Z')" "$ERROR_COUNT"
    printf '%s\n' "$ALERT_BUFFER"; } >> "$ALERT_LOG"
  # Keep the log bounded with a cheap self-trim.
  if [ "$(wc -l < "$ALERT_LOG" 2>/dev/null || echo 0)" -gt 5000 ]; then
    tail -n 2000 "$ALERT_LOG" > "${ALERT_LOG}.tmp" && mv "${ALERT_LOG}.tmp" "$ALERT_LOG"
  fi
  if [ -n "$HEALTHCHECK_PING_KEY" ]; then
    # Send the cause as the ping body so the healthchecks.io dashboard/API records
    # WHY we failed, not just that we did (fail pings were previously bodyless).
    curl -m 10 --retry 5 -s --data-raw "$ALERT_BUFFER" "https://hc-ping.com/$HEALTHCHECK_PING_KEY/fail" > /dev/null
  fi
  exit 1
fi

if [ -n "$HEALTHCHECK_PING_KEY" ]; then
  curl -m 10 --retry 5 -s "https://hc-ping.com/$HEALTHCHECK_PING_KEY" > /dev/null
fi
