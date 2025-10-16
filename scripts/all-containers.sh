#!/bin/bash
# shellcheck disable=SC2059
set -e

YELLOW='\033[1;33m'
BRIGHT_MAGENTA='\033[1;95m'
RED='\033[0;31m'
NC='\033[0m' # NoColor

START_ACTION=false
STOP_ACTION=false
SLEEP_TIME=10
MOUNT=""
CATEGORY=""
CONTAINER_LIST_FILE=""

NO_WAIT=false
UPDATE_GIT_REPOS=false
GET_UPDATES=false
NO_FAIL=false

while test $# -gt 0
do
        case "$1" in
                --start) START_ACTION=true
                ;;
                --stop) STOP_ACTION=true
                ;;
                --sleep)
                  shift
                  SLEEP_TIME=$1
                  ;;
                --mount)
                  shift
                  MOUNT=$1
                  ;;
                --category)
                  shift
                  CATEGORY="$1"
                  ;;
                --container-list)
                  shift
                  CONTAINER_LIST_FILE="$1"
                  ;;
                --no-wait)
                  NO_WAIT=true
                  ;;
                --update-git-repos)
                  UPDATE_GIT_REPOS=true
                  ;;
                --get-updates)
                  GET_UPDATES=true
                  ;;
                --no-fail)
                  NO_FAIL=true
                  ;;
        esac
        shift
done

if [[ ${START_ACTION} = false && ${STOP_ACTION} = false ]];then
  echo ""
  echo "If you want to skip a folder, and just not run that container, you can create a _DISABLED_ file in the folder."
  echo ""
  echo "You must an action of either start or stop like this:"
  echo "all-containers.sh --start"
  echo "or"
  echo "all-containers.sh --stop"
  echo ""
  echo "You can also specify BOTH stop and start to stop and start each container one at a time."
  echo "Then if you include the --update-git-repos and --get-updates flags, it will update the git repos and get updates for each container one at a time."
  echo ""
  echo "You can also adjust the sleep time between starting containers. Default is 10 seconds."
  echo "all-containers.sh --start --sleep 20"
  echo ""
  echo "You can also specify to only STOP containers which reference a given mount text in their compose.yaml files."
  echo "all-containers.sh --stop --mount 250a"
  echo ""
  echo "You can also specify to only STOP containers which reference a given category in their compose.yaml files based on the homepage.group tag."
  echo "all-containers.sh --stop --category \"System Monitoring\""
  echo ""
  echo "You can also specify a file containing a list of container directories to process."
  echo "all-containers.sh --start --container-list my-containers.txt"
  echo ""
  echo "You can also update all git repositories in all containers by running:"
  echo "all-containers.sh --update-git-repos"
  echo ""
  echo "You can also get updates for all containers by running:"
  echo "all-containers.sh --get-updates"
  echo ""
  echo "Finally, there is a --fast flag that will skip waiting for all containers to report healthy."
  echo "all-containers.sh --fast"
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

# We moved the script down one level to the scripts directory, so we need to go up one level to get to the containers directory
SCRIPT_DIR="$(dirname "$SCRIPT_DIR")"

cd "${SCRIPT_DIR}" || exit

# Create and sort list
CONTAINER_LIST=()
for DIR in *;do
  if [[ -d "${SCRIPT_DIR}/${DIR}" ]] && [[ -e "${SCRIPT_DIR}/${DIR}/compose.yaml" ]];then
    # Skip folders that contain a _DISABLED_ file
    if [[ -e "${SCRIPT_DIR}/${DIR}/_DISABLED_" ]];then
      continue
    fi
    STRIPPED_DIR=${DIR%*/}
    ORDER="a"
    if [[ -e "${SCRIPT_DIR}/${DIR}/.start-order" ]];then
      ORDER=$(< "${SCRIPT_DIR}/${DIR}/.start-order")
    fi
    CONTAINER_LIST+=("${ORDER}/${STRIPPED_DIR}")
  fi
done

RESTART_LIST_TEXT="all containers"
RESTART_LIST_TEXT_UPPER="All containers"

# If a container list file is provided, read it and filter the container list
if [[ -n "${CONTAINER_LIST_FILE}" ]]; then
  if [[ ! -f "${CONTAINER_LIST_FILE}" ]]; then
    printf "${RED}Error: Container list file ${CONTAINER_LIST_FILE} does not exist${NC}\n"
    exit 1
  fi
  
  # Read the container list file into an array
  mapfile -t ALLOWED_DIRS < "${CONTAINER_LIST_FILE}"
  
  # Ensure that each entry in the CONTAINER_LIST exists as a folder in the containers directory
  for ENTRY in "${ALLOWED_DIRS[@]}"; do
    CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
    if [[ ! -d "${SCRIPT_DIR}/${CONTAINER_DIR}" ]] || [[ ! -e "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" ]]; then
      printf "${RED}Error: Container directory ${CONTAINER_DIR} does not exist or does not contain a compose.yaml file${NC}\n"
      exit 1
    fi
  done

  # Filter CONTAINER_LIST to only include directories in the file list
  FILTERED_LIST=()
  for ENTRY in "${CONTAINER_LIST[@]}"; do
    CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
    if [[ " ${ALLOWED_DIRS[*]} " == *" ${CONTAINER_DIR} "* ]]; then
      FILTERED_LIST+=("${ENTRY}")
    fi
  done
  CONTAINER_LIST=("${FILTERED_LIST[@]}")
  RESTART_LIST_TEXT="the containers listed in ${CONTAINER_LIST_FILE}"
  RESTART_LIST_TEXT_UPPER="The containers listed in ${CONTAINER_LIST_FILE}"
fi

if [[ ${START_ACTION} = true && ${STOP_ACTION} = true ]];then
  if [[ ${GET_UPDATES} = true ]];then
    printf "${YELLOW}Pulling updates and rebuilding ${RESTART_LIST_TEXT}${NC}\n\n"
  else
    printf "${YELLOW}Restarting ${RESTART_LIST_TEXT}${NC}\n\n"
  fi
  readarray -t SORTED_CONTAINER_LIST < <(printf '%s\0' "${CONTAINER_LIST[@]}" | sort -z | xargs -0n1)
elif [[ ${START_ACTION} = true ]];then
  printf "${YELLOW}Starting ${RESTART_LIST_TEXT}...${NC}\n"
  readarray -t SORTED_CONTAINER_LIST < <(printf '%s\0' "${CONTAINER_LIST[@]}" | sort -z | xargs -0n1)
elif [[ ${STOP_ACTION} = true ]];then
  if [[ ${MOUNT} != "" ]];then
    printf "${YELLOW}Stopping containers that reference /mnt/${MOUNT}...${NC}\n"
  elif [[ ${CATEGORY} != "" ]];then
    printf "${YELLOW}Stopping containers that reference the category ${CATEGORY}...${NC}\n"
  else
    printf "${YELLOW}Stopping ${RESTART_LIST_TEXT}...${NC}\n"
  fi
  readarray -t SORTED_CONTAINER_LIST < <(printf '%s\0' "${CONTAINER_LIST[@]}" | sort -rz | xargs -0n1)
fi

for ENTRY in "${SORTED_CONTAINER_LIST[@]}";do
  CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
  if [[ -d "${SCRIPT_DIR}/${CONTAINER_DIR}" ]] && [[ -e "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" ]];then

    # Check for a reference to a tailscale.env file in the local folder by looking for
    # env_file: tailscale.env in the compose.yaml file
    if grep -q "env_file: tailscale.env" "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml"; then
      # Check that a tailscale.env file exists in the local folder
      if [[ ! -f "${SCRIPT_DIR}/${CONTAINER_DIR}/tailscale.env" ]]; then
        printf "${RED}     Error: tailscale.env file not found in ${CONTAINER_DIR}\n${NC}"
        # Check for such a file in the user's home folder under the credentials folder
        if [[ -f "${HOME}/credentials/tailscale.env" ]]; then
          printf "${YELLOW}     Found tailscale.env file in ${HOME}/credentials/\n     Adding a symbolic link to it here...${NC}\n"
          ln -s "${HOME}/credentials/tailscale.env" "${SCRIPT_DIR}/${CONTAINER_DIR}/tailscale.env"
        fi
      fi
    fi


    if [[ ${MOUNT} != "" ]];then
      if [[ $(grep -v for-homepage "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" | grep -v ScanHere | grep -c "/mnt/${MOUNT}/") -eq 0 ]];then
        continue
      fi
    elif [[ ${CATEGORY} != "" ]];then
      if [[ $(grep -c "homepage.group=${CATEGORY}" "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml") -eq 0 ]];then
        continue
      fi
    fi
    cd "${SCRIPT_DIR}/${CONTAINER_DIR}"
    if [[ ${STOP_ACTION} = true ]];then
      # Run a pre-down health check to update the time out to reduce the noise of early failures
      if [[ ${START_ACTION} = true && -e "${HOME}/containers/scripts/system-health-check.sh" ]];then
        "${HOME}/containers/scripts/system-health-check.sh" --run-health-check
      fi
      printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"
      docker compose down
    fi
    if [[ ${START_ACTION} = true ]];then
      if [[ $(docker compose ps | wc -l) -eq 1 ]];then
        printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"

        if [[ ${UPDATE_GIT_REPOS} = true ]];then
        # Update any git repositories in the directory
          set +e
          find . -name ".git" -type d -exec sh -c '
            printf "${YELLOW}  Updating git repository in ${1%/*}${NC}\n"
            cd "${1%/*}" || continue
            git pull
            cd "${SCRIPT_DIR}/${CONTAINER_DIR}" || exit
          ' sh {} \; 2>/dev/null;
          set -e
          if [[ -e site/my-digital-garden/.git ]];then
            printf "${YELLOW}  Updating git repository in site/my-digital-garden${NC}\n"
            cd site/my-digital-garden || continue
            git pull
            printf "${YELLOW}    Updating dependencies in site/my-digital-garden${NC}\n"
            rm -rf node_modules
            rm package-lock.json
            npm i
            printf "${YELLOW}    Rebuilding site/my-digital-garden${NC}\n"
            npm run build
            /usr/bin/chmod -R o+rX dist
            cd "${SCRIPT_DIR}/${CONTAINER_DIR}" || exit
          fi
        fi
        if [[ ${NO_FAIL} = true ]];then
          set +e
        fi
        if [[ ${GET_UPDATES} = true ]];then
          printf "${YELLOW}  Pulling updates and rebuilding...${NC}\n"
          docker compose pull
          docker compose build
        fi
        docker compose up -d --wait
        set -e
        if [[ ${CONTAINER_DIR} = "homepage" ]];then
          # This is my personal hack to get icons the way I want them in homepage.
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/* /app/public"
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/favicon.ico /app/public/homepage.ico"
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/apple-icon.png /app/public/apple-touch-icon.png"
        fi

        if [[ ${NO_WAIT} = false ]];then
          printf "${YELLOW} ...Waiting for all containers to report healthy...${NC}\n"
          while /usr/bin/docker ps -a | tail -n +2 | grep -v "(healthy)" > /dev/null; do
            sleep 0.1;
          done;
          printf "${YELLOW} ...Continuing to next task in ${SLEEP_TIME} seconds...${NC}\n"
          sleep "${SLEEP_TIME}"
          printf "\n"
        fi

        # If the container came from a list of containers to process, we need to remove it from the file so we don't try to process it again.
        if [[ -n "${CONTAINER_LIST_FILE}" ]]; then
          sed -i "/^${CONTAINER_DIR}\$/d" "${CONTAINER_LIST_FILE}"
          # If the container list file is empty, delete it
          if [[ ! -s "$CONTAINER_LIST_FILE" ]]; then
              echo "$CONTAINER_LIST_FILE file is empty, deleting..."
              rm -rf "$CONTAINER_LIST_FILE"
          fi
        fi
      fi
    fi
  else
    printf "${RED} - ${CONTAINER_DIR} is not a valid container directory${NC}\n"
    exit 1
  fi
done

printf "${YELLOW}Waiting for all containers to report healthy on final pass...${NC}\n\n"
while /usr/bin/docker ps -a | tail -n +2 | grep -v "(healthy)" > /dev/null; do
  sleep 0.1;
done;

if [[ ${START_ACTION} = true ]];then
  printf "${YELLOW}Performing post-start chores${NC}\n"
  # Prune images now to clear any left over after upgrades.
  # This ensures all images we don't use are pruned, but none that we do use
  docker image prune -af

  # Remove unnamed and unused volumes that get left behind
  docker volume prune -af

  # Remove unused networks that get left behind
  docker network prune -f
fi

if [[ ${START_ACTION} = true && ${STOP_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been restarted.${NC}\n"
elif [[ ${STOP_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been stopped.${NC}\n"
elif [[ ${START_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been started.${NC}\n"
fi

# Run my check script to go ahead and let everyone know we are back up.
if [[ ${START_ACTION} = true && -e "${HOME}/containers/scripts/system-health-check.sh" ]];then
  "${HOME}/containers/scripts/system-health-check.sh" --run-health-check
fi
