#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Go up one level to the containers directory
CONTAINERS_DIR="$(dirname "$SCRIPT_DIR")"
# Resolve the diun script volume path from its generated .env file.
# The diun compose.yaml uses ${VOL_DIUN_SCRIPT}/container-mounts/diun/script:/script,
# and VOL_DIUN_SCRIPT is set by scripts/generate-env.js based on container-registry.yaml.
DIUN_ENV_FILE="$CONTAINERS_DIR/diun/.env"
if [ ! -f "$DIUN_ENV_FILE" ]; then
    echo "Diun .env file not found at $DIUN_ENV_FILE, exiting..."
    exit 1
fi

# shellcheck disable=SC1090
set -a; source "$DIUN_ENV_FILE"; set +a

SCRIPT_VOLUME_PATH="${VOL_DIUN_SCRIPT:-$HOME/container-data}/container-mounts/diun/script"

# Construct the full file path
PENDING_UPDATES_FILE="$SCRIPT_VOLUME_PATH/pendingContainerUpdates.txt"

if [[ -e "$PENDING_UPDATES_FILE" ]]; then
  # Get the current user dynamically since $USER is not set in cron
  CURRENT_USER=$(whoami)
  echo "Pending container updates found"
  cat "$PENDING_UPDATES_FILE"
  echo ""
  echo "/home/$CURRENT_USER/containers/scripts/update-containers-from-diun-list.sh"
  exit 1
fi
