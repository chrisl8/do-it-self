#!/bin/bash

FILE_PATH="/mnt/2000/container-mounts/diun/script/pendingContainerUpdates.txt"

# Check if the pendingContainerUpdates.txt file exists
if [ ! -f "$FILE_PATH" ]; then
    echo "$FILE_PATH file does not exist, exiting..."
    exit 1
fi

./allContainers.sh --update-git-repos --get-updates --sleep 1 --stop --start --container-list $FILE_PATH

rm -rf $FILE_PATH
