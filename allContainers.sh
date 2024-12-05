#!/bin/bash
# shellcheck disable=SC2059
set -e

YELLOW='\033[1;33m'
BRIGHT_MAGENTA='\033[1;95m'
NC='\033[0m' # NoColor

ACTION=""
SLEEP_TIME=10
MOUNT=""

while test $# -gt 0
do
        case "$1" in
                --start) ACTION=start
                ;;
                --stop) ACTION=stop
                ;;
                --sleep)
                  shift
                  SLEEP_TIME=$1
                  ;;
                --mount)
                  shift
                  MOUNT=$1
                  ;;
        esac
        shift
done

if [[ ${ACTION} = "" ]];then
  echo "You must an action of either start or stop like this:"
  echo "allContainers.sh --start"
  echo "or"
  echo "allContainers.sh --stop"
  echo ""
  echo "You can also adjust the sleep time between starting containers. Default is 10 seconds."
  echo "allContainers.sh --start --sleep 20"
  echo ""
  echo "You can also specify to only STOP containers which reference a given mount text in their compose.yaml files."
  echo "allContainers.sh --stop --mount 250a"
  exit
fi

# Grab and save the path to this script
# http://stackoverflow.com/a/246128
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative symlink, we need to resolve it relative to the path where the symlink file was located
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
#echo "${SCRIPT_DIR}" # For debugging

if [[ ${ACTION} = "start" ]];then
  printf "${YELLOW}Starting all containers...${NC}\n"
fi
if [[ ${ACTION} = "stop" ]];then
  if [[ ${MOUNT} != "" ]];then
    printf "${YELLOW}Stopping containers that reference /mnt/${MOUNT}...${NC}\n"
  else
    printf "${YELLOW}Stopping all containers...${NC}\n"
  fi
fi

cd "${SCRIPT_DIR}" || exit
for dir in *;do
  if [[ -d "${SCRIPT_DIR}/${dir}" ]] && [[ -e "${SCRIPT_DIR}/${dir}/compose.yaml" ]];then
    dir=${dir%*/}
    if [[ ${MOUNT} != "" ]];then
      if [[ $(grep -v for-homepage "${SCRIPT_DIR}/${dir}/compose.yaml" | grep -v photon_data | grep -v ScanHere | grep -c "/mnt/${MOUNT}/") -eq 0 ]];then
        continue
      fi
    fi
    cd "${SCRIPT_DIR}/${dir}"
    if [[ ${ACTION} = "start" ]];then
      if [[ $(docker compose ps | wc -l) -eq 1 ]];then
        printf "${BRIGHT_MAGENTA} - ${dir}${NC}\n"
        # TODO: Check if containers needing git clones exist?
        # Update any git repositories in the directory
        for dir in $(find . -name ".git" -type d 2>/dev/null); do
          echo "Updating git repository in ${dir%/*}"
          cd "${dir%/*}" || continue
          git pull
          cd - > /dev/null || exit
        done
        docker compose pull
        docker compose build
        docker compose up -d
        if [[ ${dir} = "homepage" ]];then
          # This is my personal hack to get icons the way I want them in homepage.
          docker exec homepage sh -c "cp /app/public/images/favicons/* /app/public"
          docker exec homepage sh -c "cp /app/public/images/favicons/favicon.ico /app/public/homepage.ico"
          docker exec homepage sh -c "cp /app/public/images/favicons/apple-icon.png /app/public/apple-touch-icon.png"
        fi
        sleep ${SLEEP_TIME}
      fi
    fi
    if [[ ${ACTION} = "stop" ]];then
      printf "${BRIGHT_MAGENTA} - ${dir}${NC}\n"
      docker compose down
    fi
  fi
done

if [[ ${ACTION} = "start" ]];then
  printf "${YELLOW}Performing post-start chores${NC}\n"
  # Prune images now to clear any left over after upgrades.
  # This ensures all images we don't use are pruned, but none that we do use
  docker image prune -af

  # Remove unnamed and unused volumes that get left behind
  docker volume prune -af

  # Remove unused networks that get left behind
  docker network prune -f

  printf "${YELLOW}All containers started${NC}\n"
fi

if [[ ${ACTION} = "stop" ]];then
  printf "${YELLOW}All containers stopped.${NC}\n"
fi
