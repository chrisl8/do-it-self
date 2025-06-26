#!/bin/bash

# Check if the pendingContainerUpdates.txt file exists
if [ ! -f "/script/pendingContainerUpdates.txt" ]; then
    echo "pendingContainerUpdates.txt file does not exist, exiting..."
    exit 1
fi

./allContainers.sh --update-git-repos --get-updates --sleep 1 --stop --start --container-list /mnt/2000/container-mounts/diun/script/pendingContainerUpdate
s.txt

rm -rf /mnt/2000/container-mounts/diun/script/pendingContainerUpdates.txt
