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

# Restart unhealthy containers automatically
# but don't run it recursively!
if [[ ${ALL_CONTAINERS_IS_RUNNING} = false ]];then
  "${HOME}/containers/scripts/all-containers.sh" --restart-unhealthy --quiet --no-wait
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
if ! [[ -e /tmp/docker-ps-wc-previous.txt ]]; then
  docker ps -a | wc -l > /tmp/docker-ps-wc-previous.txt
fi
docker ps -a | wc -l > /tmp/docker-ps-wc-now.txt
if ! diff /tmp/docker-ps-wc-previous.txt /tmp/docker-ps-wc-now.txt > /dev/null; then
  PREVIOUS_COUNT=$(</tmp/docker-ps-wc-previous.txt)
  NOW_COUNT=$(</tmp/docker-ps-wc-now.txt)
  echo "Docker Container count has changed from $PREVIOUS_COUNT to $NOW_COUNT"
  echo ""
  mv /tmp/docker-ps-wc-now.txt /tmp/docker-ps-wc-previous.txt
fi

# Check Tailscale health
if [ -e /usr/bin/tailscale ]; then
  if [ -n "$EXCLUDED_DEVICES_FOR_EMAIL" ]; then
    TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_EMAIL")
  else
    TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline)
  fi

  if [ -n "$TAILSCALE_ISSUES" ]; then
    # Wait 15 seconds and check again as often there are transient issues with tailscale status reporting
    sleep 15
    if [ -n "$EXCLUDED_DEVICES_FOR_EMAIL" ]; then
      TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_EMAIL")
    else
      TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline)
    fi
    if [ -n "$TAILSCALE_ISSUES" ]; then
      echo ""
      echo "Tailscale issues detected:"
      echo "$TAILSCALE_ISSUES"
      echo ""
      if [ -n "$EXCLUDED_DEVICES_FOR_ERROR_COUNT" ] && [ -n "$EXCLUDED_DEVICES_FOR_EMAIL" ]; then
        TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_ERROR_COUNT|$EXCLUDED_DEVICES_FOR_EMAIL")
      elif [ -n "$EXCLUDED_DEVICES_FOR_ERROR_COUNT" ]; then
        TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_ERROR_COUNT")
      elif [ -n "$EXCLUDED_DEVICES_FOR_EMAIL" ]; then
        TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline | grep -vE "$EXCLUDED_DEVICES_FOR_EMAIL")
      else
        TAILSCALE_ISSUES=$(/usr/bin/tailscale status | grep offline)
      fi
      if [ -n "$TAILSCALE_ISSUES" ]; then
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
