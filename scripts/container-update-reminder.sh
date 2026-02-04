#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Go up one level to the containers directory
CONTAINERS_DIR="$(dirname "$SCRIPT_DIR")"
# Path to the diun compose file
COMPOSE_FILE="$CONTAINERS_DIR/diun/compose.yaml"

# Check if the compose file exists
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Compose file not found at $COMPOSE_FILE, exiting..."
    exit 1
fi

# Extract the script volume path from the compose file
# Look for the line that maps the script volume and extract the host path
SCRIPT_VOLUME_PATH=$(grep -E "^\s*-\s*/.*:/script" "$COMPOSE_FILE" | sed 's/^\s*-\s*\([^:]*\):\/script.*/\1/')

if [ -z "$SCRIPT_VOLUME_PATH" ]; then
    echo "Could not find script volume mapping in $COMPOSE_FILE, exiting..."
    exit 1
fi

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
