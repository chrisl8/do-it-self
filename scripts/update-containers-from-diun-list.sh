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
FILE_PATH="$SCRIPT_VOLUME_PATH/pendingContainerUpdates.txt"

echo "Using file path: $FILE_PATH"

# Check if the pendingContainerUpdates.txt file exists
if [[ ! -f "$FILE_PATH" ]]; then
    echo "$FILE_PATH file does not exist, exiting..."
    exit 1
fi

# If the file is empty, exit
if [[ ! -s "$FILE_PATH" ]]; then
    echo "$FILE_PATH file is empty, exiting..."
    rm -rf "$FILE_PATH"
    exit 0
fi

"/home/$USER/containers/scripts/all-containers.sh" --update-git-repos --get-updates --sleep 1 --stop --start --container-list "$FILE_PATH"

# Only remove the file if the all-containers command was successful
if [ $? -eq 0 ]; then
    rm -rf "$FILE_PATH"
fi
