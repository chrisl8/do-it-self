#!/usr/bin/env bash

echo "$HOSTNAME booting up now..." | mail -s "$HOSTNAME just booted" "$USER"

if ! [ -d "/home/$USER/logs" ]; then
    mkdir -p "/home/$USER/logs"
fi

# Give the system a little time to finish booting
echo "Waiting for 30 seconds before starting up..." > "/home/$USER/logs/system-cron-startup.log"
sleep 30

# Clean up docker containers if the system went down hard
/home/$USER/containers/scripts/all-containers.sh --stop >> "/home/$USER/logs/system-cron-startup.log"

# Now start everything
/home/$USER/containers/scripts/all-containers.sh --start --no-wait >> "/home/$USER/logs/system-cron-startup.log"

# Start the Metratron and other Node.js processes
# THIS IS A PERSONAL SCRIPT THAT I RUN ON MY SYSTEM, YOU WILL PROBABLY WANT TO REMOVE THIS LINE!
/home/$USER/Metatron/startpm2.sh >> "/home/$USER/logs/system-cron-startup.log"

cat "/home/$USER/logs/system-cron-startup.log" | mail -s "$HOSTNAME - All services started" "$USER"
