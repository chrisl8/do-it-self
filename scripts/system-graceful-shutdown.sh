#!/usr/bin/env bash
# shellcheck disable=SC2129,SC2002
set -e

REBOOT=false
HALT=false
ACTION=unspecified

while test $# -gt 0
do
        case "$1" in
                --reboot) REBOOT=true
                ;;
                --halt) HALT=true
                ;;
                -r) REBOOT=true
                ;;
                -h) HALT=true
                ;;
        esac
        shift
done

if [[ "${REBOOT}" = "false" ]] && [[ "${HALT}" = "false" ]];then
  echo "You must provide an action as either --reboot or --halt."
  echo "Or you can use -r or -h."
  exit 1
elif [[ "${REBOOT}" = "true" ]] && [[ "${HALT}" = "true" ]];then
  echo "You must provide ONLY ONE ACTION!"
  exit 1
elif [[ "${REBOOT}" = "true" ]];then
  ACTION=reboot
elif [[ "${HALT}" = "true" ]];then
  ACTION=reboot
else
  echo "Something isn't right here, this should never happen."
  exit 1
fi

# Test sudo access once at the start - required for chown operations
# Test specifically for /usr/bin/chown since sudoers may allow only specific commands
if ! sudo -l | grep "shutdown" > /dev/null; then
  printf "${RED}NOTE: sudo access required for shutdown operations.${NC}\n"
  printf "${RED}You CAN configure passwordless sudo for /usr/bin/shutdown.${NC}\n"
  printf "${RED}First run: sudo su -\n"
  printf "${RED}Then run: visudo\n"
  printf "${RED}Then add this line to the bottom of the file and save and close:\n"
  printf "${RED}  $(whoami) ALL=(ALL) NOPASSWD: /usr/sbin/shutdown${NC}\n\n"
  printf "${RED}Script will continue, but you will be asked for your root password later.${NC}\n"
fi

echo "Performing graceful system $ACTION..."

# Get the current user dynamically since $USER is not set in cron
CURRENT_USER=$(whoami)

"/home/$CURRENT_USER/containers/scripts/all-containers.sh" --stop --no-wait --no-health-check
if [ $? -eq 0 ]; then
  pm2 stop all
  if [[ "$ACTION" == "halt" ]];then
    sudo /usr/sbin/shutdown -h now
  elif [[ "$ACTION" == "reboot" ]];then
    sudo /usr/sbin/shutdown -r now
  fi
fi
