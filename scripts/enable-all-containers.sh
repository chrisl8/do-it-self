#!/bin/bash

# Script to remove _DISABLED_ files from all directories containing compose.yaml files
# This effectively re-enables all Docker Compose services

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINERS_DIR="$(dirname "$SCRIPT_DIR")"

echo "Looking for _DISABLED_ files in: $CONTAINERS_DIR"
echo "----------------------------------------"

# Create temporary file to store _DISABLED_ file paths
TEMP_FILE=$(mktemp)
find "$CONTAINERS_DIR" -maxdepth 2 -name "_DISABLED_" -type f > "$TEMP_FILE"

# Count total files
total=$(wc -l < "$TEMP_FILE")

if [ $total -eq 0 ]; then
    echo "No disabled containers found. All containers are already enabled."
    rm "$TEMP_FILE"
    exit 0
fi

echo "Found $total disabled containers"
echo "----------------------------------------"

# Process each file
count=0
while IFS= read -r disabled_file; do
    if [ -n "$disabled_file" ]; then
        dir_path="$(dirname "$disabled_file")"
        dir_name="$(basename "$dir_path")"
        
        count=$((count + 1))
        
        rm "$disabled_file"
        echo "[$count/$total] $dir_name - enabled ✓"
    fi
done < "$TEMP_FILE"

# Clean up temporary file
rm "$TEMP_FILE"

echo "----------------------------------------"
echo "Complete! Enabled $total container directories."
echo ""
echo "To disable all containers again, run:"
echo "  $SCRIPT_DIR/disable_all_containers.sh"