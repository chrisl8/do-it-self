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

# Check if the NVIDIA GPU driver is loaded
# The driver is installed from a .run file and must be reinstalled after kernel updates.
# DKMS should handle this automatically, but warn if it didn't.
if command -v nvidia-smi > /dev/null 2>&1; then
  if ! nvidia-smi > /dev/null 2>&1; then
    NVIDIA_WARNING="WARNING: NVIDIA driver is not loaded! GPU containers (jellyfin, obsidian, secure-browser) will fail to start.
The kernel was likely updated since the driver was last installed.
To fix, run as root:
  /opt/nvidia/NVIDIA-Linux-x86_64-575.64.05.run --dkms
  /opt/nvidia/nvidia-patch/patch.sh"
    echo "$NVIDIA_WARNING" >> "/home/$CURRENT_USER/logs/system-cron-startup.log"
    echo "$NVIDIA_WARNING" | mail -s "$HOSTNAME - NVIDIA driver not loaded after boot!" "$CURRENT_USER"
  else
    echo "NVIDIA driver is loaded." >> "/home/$CURRENT_USER/logs/system-cron-startup.log"
  fi
fi

# Clean up docker containers if the system went down hard
"/home/$CURRENT_USER/containers/scripts/all-containers.sh" --stop >> "/home/$CURRENT_USER/logs/system-cron-startup.log" 2>&1

# Now start everything
"/home/$CURRENT_USER/containers/scripts/all-containers.sh" --start --no-wait >> "/home/$CURRENT_USER/logs/system-cron-startup.log" 2>&1

# Start web-admin
"/home/$CURRENT_USER/containers/scripts/start-web-admin.sh" start >> "/home/$CURRENT_USER/logs/system-cron-startup.log" 2>&1

# Optional hook for personal or site-specific startup tasks.
# Runs after containers and web-admin are up. Output goes to the same log and email.
# This file is gitignored — create it on your system if you need it.
POST_STARTUP_HOOK="/home/$CURRENT_USER/containers/scripts/post-startup-hook.sh"
if [[ -x "$POST_STARTUP_HOOK" ]]; then
  "$POST_STARTUP_HOOK" >> "/home/$CURRENT_USER/logs/system-cron-startup.log" 2>&1
fi

echo "System startup complete." >> "/home/$CURRENT_USER/logs/system-cron-startup.log" 2>&1

cat "/home/$CURRENT_USER/logs/system-cron-startup.log" | mail -s "$HOSTNAME - All services started" "$CURRENT_USER"
