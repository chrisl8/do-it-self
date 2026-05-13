#!/usr/bin/env bash
# shellcheck disable=SC2129
set -euo pipefail

# Run OS package upgrades with NVIDIA-aware pre/post checks.
# - Disables unattended-upgrades if it has drifted back on (this script is the
#   only sanctioned upgrade path so the DKMS verification gate always runs).
# - Refuses to start if the NVIDIA driver is already broken.
# - Detects new kernel installs; forces dkms autoinstall and verifies the
#   nvidia module built before recommending a reboot.

CURRENT_USER=$(whoami)
LOG_DIR="/home/${CURRENT_USER}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/system-os-upgrades-$(date +%Y%m%d-%H%M%S).log"

# Tee all output to the log file.
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "=== system-os-upgrades.sh started at $(date) on ${HOSTNAME} ==="
echo "Log: ${LOG_FILE}"

# --- Pre-flight: enforce unattended-upgrades is disabled ---
# Idempotent: fixes drift silently and logs the correction. This script must
# be the only path that installs upgrades on this host so the DKMS gate runs.
echo ""
echo "--- Pre-flight: ensure unattended-upgrades is disabled ---"
need_disable=0
if systemctl is-enabled --quiet unattended-upgrades.service 2>/dev/null; then
    need_disable=1
fi
if systemctl is-enabled --quiet apt-daily-upgrade.timer 2>/dev/null; then
    need_disable=1
fi
periodic=$(apt-config dump APT::Periodic::Unattended-Upgrade 2>/dev/null | awk -F'"' '{print $2}')
if [[ "${periodic}" != "0" ]]; then
    need_disable=1
fi
if [[ "${need_disable}" -eq 1 ]]; then
    echo "Detected unattended-upgrades drift; disabling now."
    sudo systemctl disable --now unattended-upgrades.service 2>&1 || true
    sudo systemctl disable --now apt-daily-upgrade.timer apt-daily-upgrade.service 2>&1 || true
    sudo tee /etc/apt/apt.conf.d/20auto-upgrades > /dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Download-Upgradeable-Packages "0";
APT::Periodic::AutocleanInterval "0";
APT::Periodic::Unattended-Upgrade "0";
EOF
    echo "unattended-upgrades disabled."
else
    echo "unattended-upgrades is already disabled."
fi

# --- Pre-flight: NVIDIA driver health (only on hosts with NVIDIA) ---
echo ""
echo "--- Pre-flight: NVIDIA driver health ---"
has_nvidia=0
if command -v nvidia-smi > /dev/null 2>&1; then
    has_nvidia=1
    if ! nvidia-smi > /dev/null 2>&1; then
        echo "ERROR: nvidia-smi is installed but failing. The driver is already broken."
        echo "Fix the driver before running this script. See docs/MAINTENANCE.md."
        exit 1
    fi
    echo "nvidia-smi: OK"
    if command -v dkms > /dev/null 2>&1; then
        running_kernel=$(uname -r)
        if ! dkms status 2>/dev/null | grep -E '^nvidia/' | grep -F "${running_kernel}" | grep -q installed; then
            echo "ERROR: dkms does not show nvidia installed for the running kernel (${running_kernel})."
            echo "Fix DKMS state before running this script."
            dkms status 2>/dev/null || true
            exit 1
        fi
        echo "dkms: nvidia installed for ${running_kernel}"
    fi
else
    echo "No nvidia-smi on this host; skipping NVIDIA checks."
fi

# --- Snapshot kernel state ---
echo ""
echo "--- Pre-upgrade kernel snapshot ---"
kernels_before=$(dpkg-query -W -f='${Package}\n' 'linux-image-*' 2>/dev/null | sort || true)
echo "${kernels_before}"

# --- apt sequence ---
echo ""
echo "--- apt: autoremove (pre) ---"
sudo apt -y autoremove
echo ""
echo "--- apt: update ---"
sudo apt update
echo ""
echo "--- apt: upgrade ---"
sudo apt -y upgrade
echo ""
echo "--- apt: autoremove (post) ---"
sudo apt -y autoremove

# --- Detect kernel change ---
echo ""
echo "--- Post-upgrade kernel snapshot ---"
kernels_after=$(dpkg-query -W -f='${Package}\n' 'linux-image-*' 2>/dev/null | sort || true)
echo "${kernels_after}"

# New, versioned kernel packages (skip meta-packages like linux-image-generic).
new_kernels=$(comm -13 <(echo "${kernels_before}") <(echo "${kernels_after}") \
    | grep -E '^linux-image-[0-9]' || true)

reboot_ok=1
if [[ -n "${new_kernels}" ]]; then
    echo ""
    echo "--- New kernel package(s) installed: ${new_kernels} ---"
    if [[ "${has_nvidia}" -eq 1 ]]; then
        for pkg in ${new_kernels}; do
            kver="${pkg#linux-image-}"
            echo ""
            echo "Forcing 'dkms autoinstall -k ${kver}' to ensure NVIDIA module is built…"
            sudo dkms autoinstall -k "${kver}" 2>&1 || true
            if ! dkms status 2>/dev/null | grep -E '^nvidia/' | grep -F "${kver}" | grep -q installed; then
                echo ""
                echo "==========================================================================="
                echo "ERROR: DKMS did NOT build the NVIDIA module for kernel ${kver}."
                echo "DO NOT REBOOT. Re-run the NVIDIA installer first:"
                echo "  sudo /opt/nvidia/NVIDIA-Linux-x86_64-*.run --dkms"
                echo "  sudo /opt/nvidia/nvidia-patch/patch.sh"
                echo "Then re-run this script to verify."
                echo "==========================================================================="
                reboot_ok=0
            else
                echo "DKMS: nvidia installed for ${kver}"
            fi
        done
    else
        echo "No NVIDIA on this host; skipping DKMS verification."
    fi
else
    echo "No new kernel installed."
fi

# --- Final verdict ---
echo ""
echo "=== system-os-upgrades.sh finished at $(date) ==="
if [[ "${reboot_ok}" -eq 1 ]]; then
    echo ""
    if [[ -n "${new_kernels}" ]]; then
        echo "A new kernel was installed. You should now reboot:"
        echo "  scripts/system-graceful-shutdown.sh --reboot"
    else
        echo "No kernel change. Reboot is not required (but harmless)."
    fi
    echo ""
    echo "Log: ${LOG_FILE}"
    exit 0
else
    echo ""
    echo "Log: ${LOG_FILE}"
    exit 2
fi
