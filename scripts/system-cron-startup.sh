#!/usr/bin/env bash
# shellcheck disable=SC2129,SC2002

# Get the current user dynamically since $USER is not set in cron
CURRENT_USER=$(whoami)

printf "%s booting up now.\n\nTo watch the startup progress:\nLog into the system and run:\n\n tail -f /home/%s/logs/system-cron-startup.log\n" "$HOSTNAME" "$CURRENT_USER" | mail -s "$HOSTNAME just booted" "$CURRENT_USER"

if ! [ -d "/home/$CURRENT_USER/logs" ]; then
    mkdir -p "/home/$CURRENT_USER/logs"
fi

# Give the system a little time to finish booting
echo "Waiting for 30 seconds before starting up..." > "/home/$CURRENT_USER/logs/system-cron-startup.log"
sleep 30

# Clean up docker containers if the system went down hard
"/home/$CURRENT_USER/containers/scripts/all-containers.sh" --stop >> "/home/$CURRENT_USER/logs/system-cron-startup.log"

# Now start everything
"/home/$CURRENT_USER/containers/scripts/all-containers.sh" --start --no-wait >> "/home/$CURRENT_USER/logs/system-cron-startup.log"

if [[ -e "/home/$CURRENT_USER/Metatron/start-pm2.sh" ]]; then
  # Start the Metatron and other Node.js processes
  # THIS IS A PERSONAL SCRIPT THAT I RUN ON MY SYSTEM, I DO NOT EXPECT YOU TO HAVE IT.
  "/home/$CURRENT_USER/Metatron/start-pm2.sh" >> "/home/$CURRENT_USER/logs/system-cron-startup.log"
fi

echo "System startup complete." > "/home/$CURRENT_USER/logs/system-cron-startup.log"

cat "/home/$CURRENT_USER/logs/system-cron-startup.log" | mail -s "$HOSTNAME - All services started" "$CURRENT_USER"
