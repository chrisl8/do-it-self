#!/usr/bin/env bash

# Help Nextcloud perform its duties
if docker ps | grep -v "\-db" | grep -v "\-ts" | grep -v whiteboard | grep nextcloud | grep "(healthy)" > /dev/null; then
  docker exec -u www-data nextcloud php cron.php
fi
