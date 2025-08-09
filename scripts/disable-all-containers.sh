#!/bin/bash

# Script to add _DISABLED_ file to all directories containing compose.yaml files
# This effectively disables all Docker Compose services

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERS_DIR="$(dirname "$SCRIPT_DIR")"
echo "CONTAINERS_DIR: $CONTAINERS_DIR"

echo "Looking for compose.yaml files in: $CONTAINERS_DIR"
echo "----------------------------------------"

# Create temporary file to store compose.yaml file paths
TEMP_FILE=$(mktemp)
find "$CONTAINERS_DIR" -maxdepth 2 -name "compose.yaml" -type f > "$TEMP_FILE"

# Count total files
total=$(wc -l < "$TEMP_FILE")
echo "Found $total directories with compose.yaml files"
echo "----------------------------------------"

# Process each file
count=0
while IFS= read -r compose_file; do
    if [ -n "$compose_file" ]; then
        dir_path="$(dirname "$compose_file")"
        dir_name="$(basename "$dir_path")"
        disabled_file="$dir_path/_DISABLED_"
        
        count=$((count + 1))
        
        if [ -f "$disabled_file" ]; then
            echo "[$count/$total] $dir_name - already disabled (skipping)"
        else
            touch "$disabled_file"
            echo "[$count/$total] $dir_name - disabled ✓"
        fi
    fi
done < "$TEMP_FILE"

# Clean up temporary file
rm "$TEMP_FILE"

echo "----------------------------------------"
echo "Complete! Disabled $total container directories."
echo ""
echo "To re-enable a specific container, remove its _DISABLED_ file:"
echo "  rm /path/to/container/_DISABLED_"
echo ""
echo "To re-enable all containers, run:"
echo "  find '$CONTAINERS_DIR' -name '_DISABLED_' -type f -delete"