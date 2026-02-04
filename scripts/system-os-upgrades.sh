#!/usr/bin/env bash
# shellcheck disable=SC2129,SC2002
set -e

# Clean up unneeded packages before upgrading them
sudo apt -y autoremove
# Get updates from Ubuntu's site
sudo apt update
# Upgrade
sudo apt -y upgrade
# Clean up packages that became unneeded due to upgrades
sudo apt -y autoremove

echo ""
echo "You should now reboot the system by running:"
echo "system-graceful-shutdown.sh --reboot"