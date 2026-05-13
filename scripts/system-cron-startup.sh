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

# Check NVIDIA driver state.
# Driver is installed from a .run file with DKMS; the postinst hook should
# rebuild it on kernel updates but sometimes silently fails. Try one
# non-destructive recovery via passwordless sudo (if configured) before alerting.
NVIDIA_LOG="/home/$CURRENT_USER/logs/system-cron-startup.log"
nvidia_alert=""
nvidia_status=""

if ! command -v nvidia-smi > /dev/null 2>&1; then
  # If DKMS knows about nvidia but nvidia-smi is missing, the userspace install
  # is broken. Otherwise this isn't a GPU host — stay quiet.
  if command -v dkms > /dev/null 2>&1 && dkms status 2>/dev/null | grep -q '^nvidia/'; then
    nvidia_alert="WARNING: nvidia-smi is missing but DKMS knows about the nvidia module.
The NVIDIA userspace tools were uninstalled or were never installed alongside the kernel module.
To fix, run as root:
  sudo /opt/nvidia/NVIDIA-Linux-x86_64-*.run --dkms
  sudo /opt/nvidia/nvidia-patch/patch.sh"
  fi
elif ! nvidia-smi > /dev/null 2>&1; then
  running_kernel=$(uname -r)
  dkms_state=""
  if command -v dkms > /dev/null 2>&1; then
    dkms_state=$(dkms status 2>/dev/null | grep -E '^nvidia/' || true)
  fi
  recovered=0
  # Case A: DKMS shows the module built for the running kernel — just modprobe.
  if echo "$dkms_state" | grep -F "$running_kernel" | grep -q installed; then
    if sudo -n modprobe nvidia 2> /dev/null && sleep 1 && nvidia-smi > /dev/null 2>&1; then
      recovered=1
      nvidia_status="Recovered NVIDIA driver via 'modprobe nvidia' (module was built but not loaded)."
    fi
  # Case B: DKMS source registered but not built for the running kernel — try autoinstall once.
  elif [[ -n "$dkms_state" ]]; then
    if sudo -n dkms autoinstall -k "$running_kernel" 2> /dev/null \
       && sudo -n modprobe nvidia 2> /dev/null \
       && sleep 1 && nvidia-smi > /dev/null 2>&1; then
      recovered=1
      nvidia_status="Recovered NVIDIA driver via 'dkms autoinstall' + 'modprobe' (kernel was updated since driver was last built)."
    fi
  fi
  if [[ "$recovered" -eq 0 ]]; then
    nvidia_alert="WARNING: NVIDIA driver is not loaded! GPU containers (jellyfin, obsidian, secure-browser) will fail to start.
Running kernel: $running_kernel
DKMS state:
${dkms_state:-  (dkms not installed or no nvidia module registered)}

Automatic recovery was attempted but failed (or passwordless sudo is not configured for modprobe/dkms).
To fix, run as root:
  sudo /opt/nvidia/NVIDIA-Linux-x86_64-*.run --dkms
  sudo /opt/nvidia/nvidia-patch/patch.sh"
  fi
else
  # nvidia-smi works. Check that the NVENC patch is still in place.
  driver_version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2> /dev/null | head -1 | tr -d ' ')
  if [[ -n "$driver_version" ]]; then
    patched_lib="/usr/lib/x86_64-linux-gnu/libnvidia-encode.so.$driver_version"
    unpatched_backup="/opt/nvidia/libnvidia-encode-backup/libnvidia-encode.so.$driver_version"
    if [[ -f "$patched_lib" && -f "$unpatched_backup" ]] && cmp -s "$patched_lib" "$unpatched_backup"; then
      nvidia_alert="WARNING: NVIDIA driver is loaded but the NVENC patch has been reverted.
Driver version: $driver_version
The library at $patched_lib matches the unpatched backup at $unpatched_backup.
GPU encoding session limits will apply — jellyfin transcoding to multiple devices may fail.
To fix, run as root:
  sudo /opt/nvidia/nvidia-patch/patch.sh"
    fi
  fi
  if [[ -z "$nvidia_alert" ]]; then
    nvidia_status="NVIDIA driver loaded and NVENC patch in place."
  fi
fi

if [[ -n "$nvidia_alert" ]]; then
  echo "$nvidia_alert" >> "$NVIDIA_LOG"
  echo "$nvidia_alert" | mail -s "$HOSTNAME - NVIDIA driver issue at boot" "$CURRENT_USER"
elif [[ -n "$nvidia_status" ]]; then
  echo "$nvidia_status" >> "$NVIDIA_LOG"
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
