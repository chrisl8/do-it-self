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
FILE_PATH="$SCRIPT_VOLUME_PATH/pendingContainerUpdates.txt"

echo "Using file path: $FILE_PATH"

# Check if the pendingContainerUpdates.txt file exists
if [ ! -f "$FILE_PATH" ]; then
    echo "$FILE_PATH file does not exist, exiting..."
    exit 1
fi

"/home/$USER/containers/scripts/all-containers.sh" --update-git-repos --get-updates --sleep 1 --stop --start --container-list "$FILE_PATH"

rm -rf "$FILE_PATH"
