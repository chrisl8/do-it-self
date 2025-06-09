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
        esac
        shift
done

if [[ ${START_ACTION} = false && ${STOP_ACTION} = false ]];then
  echo "You must an action of either start or stop like this:"
  echo "allContainers.sh --start"
  echo "or"
  echo "allContainers.sh --stop"
  echo ""
  echo "You can also specify BOTH stop and start to stop and start each container one at a time."
  echo "Then if you include the --update-git-repos and --get-updates flags, it will update the git repos and get updates for each container one at a time."
  echo ""
  echo "You can also adjust the sleep time between starting containers. Default is 10 seconds."
  echo "allContainers.sh --start --sleep 20"
  echo ""
  echo "You can also specify to only STOP containers which reference a given mount text in their compose.yaml files."
  echo "allContainers.sh --stop --mount 250a"
  echo ""
  echo "You can also specify to only STOP containers which reference a given category in their compose.yaml files based on the homepage.group tag."
  echo "allContainers.sh --stop --category \"System Monitoring\""
  echo ""
  echo "You can also specify a file containing a list of container directories to process."
  echo "allContainers.sh --start --container-list my-containers.txt"
  echo ""
  echo "You can also update all git repositories in all containers by running:"
  echo "allContainers.sh --update-git-repos"
  echo ""
  echo "You can also get updates for all containers by running:"
  echo "allContainers.sh --get-updates"
  echo ""
  echo "Finaly, there is a --fast flag that will skip waiting for all containers to report healthy."
  echo "allContainers.sh --fast"
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

cd "${SCRIPT_DIR}" || exit

# Create and sort list
CONTAINER_LIST=()
for DIR in *;do
  if [[ -d "${SCRIPT_DIR}/${DIR}" ]] && [[ -e "${SCRIPT_DIR}/${DIR}/compose.yaml" ]];then
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
  
  # Filter CONTAINER_LIST to only include directories in the file list
  FILTERED_LIST=()
  for ENTRY in "${CONTAINER_LIST[@]}"; do
    CONTAINER_DIR="$(echo $ENTRY | cut -d "/" -f 2)"
    if [[ " ${ALLOWED_DIRS[*]} " =~ " ${CONTAINER_DIR} " ]]; then
      FILTERED_LIST+=("${ENTRY}")
    fi
  done
  CONTAINER_LIST=("${FILTERED_LIST[@]}")
  RESTART_LIST_TEXT="the containers in ${CONTAINER_LIST_FILE}"
  RESTART_LIST_TEXT_UPPER="The containers in ${CONTAINER_LIST_FILE}"
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
  CONTAINER_DIR="$(echo $ENTRY | cut -d "/" -f 2)"
  if [[ -d "${SCRIPT_DIR}/${CONTAINER_DIR}" ]] && [[ -e "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" ]];then
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
      printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"
      docker compose down
    fi
    if [[ ${START_ACTION} = true ]];then
      if [[ $(docker compose ps | wc -l) -eq 1 ]];then
        printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"

        # Check if the compose file has any user directives, and if so, ensure they are set up correctly
        if [[ $(grep -c "user:" "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml") -gt 0 ]];then
          # If it does, make sure that:
          # 0. That there is only one user and group ID used, not multiple
          USER_IDS=$(grep -o 'user:.*[0-9]*:[0-9]*' "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" | tr -d ' ' | cut -d':' -f 2,3 | tr ':' '\n')
          if [[ $(echo "${USER_IDS}" | tr ' ' '\n' | sort -u | wc -l) -ne 1 ]];then
            printf "${RED}Error: Multiple user and group IDs are used in ${CONTAINER_DIR}/compose.yaml${NC}\n"
            exit 1
          fi
          USER_ID=$(echo "${USER_IDS}" | tr ' ' '\n' | sort -u)
          # 1. The user exists
          if ! getent passwd "${USER_ID}" >/dev/null; then
            printf "${RED}Error: User ID ${USER_ID} specified in ${CONTAINER_DIR}/compose.yaml does not exist on the system${NC}\n"
            printf "${YELLOW}To fix this, create the user with:${NC}\n"
            printf "sudo useradd --no-create-home --uid ${USER_ID} ${CONTAINER_DIR}-docker\n"
            exit 1
          fi
          USER_NAME=$(getent passwd "${USER_ID}" | cut -d':' -f1)
          # 2. The user name corresponds to the container folder name plus -docker on the end.
          if [[ "${CONTAINER_DIR}-docker" != "${USER_NAME}" ]];then
            printf "${RED}Error: User ID ${USER_ID} name ${USER_NAME} does not correspond to the container folder name ${CONTAINER_DIR}-docker${NC}\n"
            exit 1
          fi
          # 3. That the group by the same name exists
          if ! getent group "${USER_ID}" >/dev/null; then
            printf "${RED}Error: Group ${USER_ID} specified in ${CONTAINER_DIR}/compose.yaml does not exist on the system${NC}\n"
            exit 1
          fi
          # 4. That the user is added to the group
          if ! groups "${USER_NAME}" | cut -d':' -f 2 | grep -q "\b${USER_NAME}\b"; then
            printf "${RED}Error: User ${USER_NAME} is not a member of group ${USER_NAME}${NC}\n"
            printf "${YELLOW}To fix this, add the user to the group with:${NC}\n"
            printf "sudo usermod -aG ${USER_NAME} ${USER_NAME}\n"
            exit 1
          fi
          # Finally, if any mounts exist for this container, make sure that the user owns them.
          # Check for any mount points in the compose file
          MOUNT_POINTS=$(grep -E '^\s*-\s*/mnt/[^:]+:' "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" | awk -F: '{print $1}' | sed 's/.*- //')
          
          # Define special cases with their expected group IDs
          declare -A SPECIAL_CASES=(
            ["obsidian-babel-livesync"]=""  # Skip ownership check
            ["nextcloud"]=""                 # Skip ownership check
            ["kanboard"]=""                  # Skip ownership check
            ["freshrss"]="33"               # www-data group
          )

          if [[ -n "${MOUNT_POINTS}" ]]; then
            while IFS= read -r MOUNT_POINT; do
              if [[ -d "${MOUNT_POINT}" ]]; then
                CURRENT_OWNER=$(stat -c '%u:%g' "${MOUNT_POINT}")
                EXPECTED_GROUP="${SPECIAL_CASES[$CONTAINER_DIR]:-$USER_ID}"
                
                # Skip check if container is in special cases with empty group
                if [[ -z "${SPECIAL_CASES[$CONTAINER_DIR]}" ]]; then
                  continue
                fi
                
                # Check ownership
                if [[ "${CURRENT_OWNER}" != "${USER_ID}:${EXPECTED_GROUP}" ]]; then
                  printf "${RED}Error: Mount point ${MOUNT_POINT} has incorrect ownership${NC}\n"
                  printf "${YELLOW}To fix this, change the ownership with:${NC}\n"
                  if [[ "${CONTAINER_DIR}" == "freshrss" ]]; then
                    printf "sudo chown -R ${USER_ID}:www-data ${MOUNT_POINT}\n"
                  else
                    printf "sudo chown -R ${USER_ID}:${USER_ID} ${MOUNT_POINT}\n"
                  fi
                  exit 1
                fi
              else
                printf "${RED}Error: Mount point ${MOUNT_POINT} does not exist${NC}\n"
                printf "${YELLOW}To fix this, create the directory with:${NC}\n"
                printf "sudo mkdir -p ${MOUNT_POINT}\n"
                printf "sudo chown ${USER_ID}:${USER_ID} ${MOUNT_POINT}\n"
                exit 1
              fi
            done <<< "${MOUNT_POINTS}"
          fi
        fi

        if [[ ${UPDATE_GIT_REPOS} = true ]];then
        # Update any git repositories in the directory
          for GIT_DIR in $(find . -name ".git" -type d 2>/dev/null); do
            printf "${YELLOW}  Updating git repository in ${GIT_DIR%/*}${NC}\n"
            cd "${GIT_DIR%/*}" || continue
            git pull
            cd "${SCRIPT_DIR}/${CONTAINER_DIR}" || exit
          done
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
        if [[ ${GET_UPDATES} = true ]];then
          printf "${YELLOW}  Pulling updates and rebuilding...${NC}\n"
          docker compose pull
          docker compose build
        fi
        docker compose up -d
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
      fi
    fi
  else
    printf "${RED} - ${CONTAINER_DIR} is not a valid container directory${NC}\n"
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
if [[ -e "${HOME}/Scripts/containerCheckups.sh" ]];then
  "${HOME}/Scripts/containerCheckups.sh"
fi
