#!/bin/bash
# shellcheck disable=SC2059
set -e

YELLOW='\033[1;33m'
BRIGHT_MAGENTA='\033[1;95m'
RED='\033[0;31m'
NC='\033[0m' # NoColor

RESTART_UNHEALTHY=false
START_ACTION=false
STOP_ACTION=false
SLEEP_TIME=10
MOUNT=""
CATEGORY=""
CONTAINER_LIST_FILE=""
SINGLE_CONTAINER=""

NO_WAIT=false
UPDATE_GIT_REPOS=false
GET_UPDATES=false
NO_FAIL=false
NO_HEALTH_CHECK=false

QUIET=false

TEST_FAIL=false

LIST_MOUNTS=false

while test $# -gt 0
do
        case "$1" in
                --start) START_ACTION=true
                ;;
                --stop) STOP_ACTION=true
                ;;
                --restart-unhealthy) RESTART_UNHEALTHY=true
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
                --container)
                  shift
                  SINGLE_CONTAINER="$1"
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
                --quiet)
                  QUIET=true
                  ;;
                --no-health-check)
                  NO_HEALTH_CHECK=true
                  ;;
                --test-fail)
                  TEST_FAIL=true
                  ;;
                --list-mounts)
                  LIST_MOUNTS=true
                  ;;
        esac
        shift
done

if [[ ${TEST_FAIL} = true ]];then
  echo "FAILING due to TEST FAIL REQUEST!"
  exit 1
fi

if [[ ${START_ACTION} = false && ${STOP_ACTION} = false && ${RESTART_UNHEALTHY} = false && ${LIST_MOUNTS} = false ]];then
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
  echo "Finally, there is a --no-wait flag that will skip waiting for all containers to report healthy."
  echo "all-containers.sh --no-wait"
  echo ""
  echo "You can also list all local mount points used by containers:"
  echo "all-containers.sh --list-mounts"
  echo ""
  echo "Or list mount points for a single container:"
  echo "all-containers.sh --list-mounts --container <container-name>"
  echo ""
  echo "Mount permissions can be configured per-container using mount-permissions.yaml"
  echo "Files must be placed alongside compose.yaml in each container directory."
  echo "See example format in scripts/mount-permissions-example.yaml"
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

DIUN_UPDATE_FILE=""
# Path to the diun compose file
COMPOSE_FILE="$SCRIPT_DIR/diun/compose.yaml"
# Check if the compose file exists
if [ -f "$COMPOSE_FILE" ]; then

  # Extract the script volume path from the compose file
  # Look for the line that maps the script volume and extract the host path
  SCRIPT_VOLUME_PATH=$(grep -E "^\s*-\s*/.*:/script" "$COMPOSE_FILE" | sed 's/^\s*-\s*\([^:]*\):\/script.*/\1/')

  if [ -n "$SCRIPT_VOLUME_PATH" ]; then
    # Construct the full file path
    DIUN_UPDATE_FILE="$SCRIPT_VOLUME_PATH/pendingContainerUpdates.txt"
  fi
fi

resolve_to_absolute() {
  local path="$1"
  local base_dir="$2"

  if [[ -z "$path" ]]; then
    echo ""
    return
  fi

  if [[ "$path" == /* ]]; then
    echo "$path"
    return
  fi

  python3 -c "import os; print(os.path.abspath(os.path.join('$base_dir', '$path')))"
}

list_local_mounts() {
  local compose_file="$1"
  local base_dir="${2:-$(dirname "$compose_file")}"

  if [[ ! -f "$compose_file" ]]; then
    return
  fi

  local config_output
  config_output=$(docker --log-level ERROR compose -f "$compose_file" config 2>/dev/null) || return

  # Extract source: lines from volumes section - handle multi-line format
  # Format is:
  # volumes:
  #   - type: bind
  #     source: /path/to/source
  #     target: /path/to/target

  echo "$config_output" | grep -E "^\s+source:" | while read -r source_line; do
    local source
    source=$(echo "$source_line" | sed -n 's/.*source:\s*\(.*\)/\1/p' | xargs)

    if [[ -z "$source" ]]; then
      continue
    fi

    # Skip named volumes (don't start with /, ./, or ../)
    if [[ ! "$source" =~ ^(\.|\.\.|/) ]]; then
      continue
    fi

    resolve_to_absolute "$source" "$base_dir"
  done
}

apply_mount_permissions() {
  local config_file="$1"
  
  if [[ ! -f "$config_file" ]]; then
    return
  fi
  
  printf "${YELLOW}Applying mount permissions...${NC}\n"
  
  # Check if yq is available for YAML parsing
  if command -v yq &> /dev/null; then
    # Use yq for proper YAML parsing
    local mount_paths
    mount_paths=$(yq e '.mounts | keys' "$config_file" 2>/dev/null)
    
    while IFS= read -r mount_path; do
      if [[ -z "$mount_path" || "$mount_path" == "---" ]]; then
        continue
      fi
      
      # Trim whitespace
      mount_path=$(echo "$mount_path" | xargs)
      
      # Skip if empty after trimming
      [[ -z "$mount_path" ]] && continue
      
      # Get mode, owner, and recursive for this mount
      local mode owner recursive
      mode=$(yq e ".mounts[\"$mount_path\"].mode // \"\"" "$config_file" | xargs)
      owner=$(yq e ".mounts[\"$mount_path\"].owner // \"\"" "$config_file" | xargs)
      recursive=$(yq e ".mounts[\"$mount_path\"].recursive // \"false\"" "$config_file" | xargs)
      
      # Apply permissions
      apply_single_mount_permission "$mount_path" "$mode" "$owner" "$recursive"
    done <<< "$mount_paths"
  else
    # Fallback: parse YAML with grep/sed
    # Expected format:
    # mounts:
    #   /path/to/mount:
    #     mode: "755"
    #     owner: "user:group"
    #     recursive: true
    
    # Extract mount paths
    local mount_paths
    mount_paths=$(grep -E "^\s+/" "$config_file" | sed 's/:$//' | xargs)
    
    for mount_path in $mount_paths; do
      local mode owner recursive
      
      # Extract mode
      mode=$(grep -A1 "$mount_path:" "$config_file" | grep "mode:" | sed 's/.*mode:\s*"\?\([^"]*\)"\?.*/\1/' | xargs)
      
      # Extract owner
      owner=$(grep -A2 "$mount_path:" "$config_file" | grep "owner:" | sed 's/.*owner:\s*"\?\([^"]*\)"\?.*/\1/' | xargs)
      
      # Extract recursive
      recursive=$(grep -A3 "$mount_path:" "$config_file" | grep "recursive:" | sed 's/.*recursive:\s*\([a-z]*\)/\1/' | xargs)
      
      apply_single_mount_permission "$mount_path" "$mode" "$owner" "$recursive"
    done
  fi
}

apply_single_mount_permission() {
  local mount_path="$1"
  local mode="$2"
  local owner="$3"
  local recursive="$4"
  
  # Check if mount path exists
  if [[ ! -e "$mount_path" ]]; then
    printf "${RED}ERROR: Mount path $mount_path does not exist.${NC}\n"
    printf "${RED}Please create this directory before starting the container.${NC}\n"
    printf "${RED}Aborting.${NC}\n"
    exit 1
  fi
  
  # Build chmod command
  local chmod_args=""
  if [[ -n "$mode" ]]; then
    chmod_args="$mode"
  fi
  
  # Build chown command
  local chown_args=""
  if [[ -n "$owner" ]]; then
    chown_args="$owner"
  fi
  
  # Apply chmod if specified
  if [[ -n "$chmod_args" ]]; then
    local chmod_cmd="chmod"
    if [[ "$recursive" == "true" ]]; then
      chmod_cmd="chmod -R"
    fi
    
    printf "  ${YELLOW}chmod $chmod_args $mount_path${NC}"
    if [[ "$recursive" == "true" ]]; then
      printf " (recursive)"
    fi
    printf "\n"
    
    if ! $chmod_cmd "$chmod_args" "$mount_path" 2>/dev/null; then
      printf "${RED}ERROR: Failed to set mode $chmod_args on $mount_path${NC}\n"
      printf "${RED}Aborting.${NC}\n"
      exit 1
    fi
  fi
  
  # Apply chown if specified
  if [[ -n "$chown_args" ]]; then
    local chown_cmd="chown"
    if [[ "$recursive" == "true" ]]; then
      chown_cmd="chown -R"
    fi
    
    printf "  ${YELLOW}chown $chown_args $mount_path${NC}"
    if [[ "$recursive" == "true" ]]; then
      printf " (recursive)"
    fi
    printf "\n"
    
    if ! $chown_cmd "$chown_args" "$mount_path" 2>/dev/null; then
      printf "${RED}ERROR: Failed to set owner $chown_args on $mount_path${NC}\n"
      printf "${RED}Aborting.${NC}\n"
      exit 1
    fi
  fi
  
  # Verify permissions
  verify_mount_permission "$mount_path" "$mode" "$owner"
}

verify_mount_permission() {
  local mount_path="$1"
  local expected_mode="$2"
  local expected_owner="$3"
  
  if [[ -z "$expected_mode" && -z "$expected_owner" ]]; then
    return
  fi
  
  # Get actual permissions
  local actual_owner
  actual_owner=$(stat -c "%U:%G" "$mount_path" 2>/dev/null)
  
  local actual_mode
  actual_mode=$(stat -c "%a" "$mount_path" 2>/dev/null)
  
  local mode_ok=true
  local owner_ok=true
  
  if [[ -n "$expected_mode" && "$actual_mode" != "$expected_mode" ]]; then
    mode_ok=false
  fi
  
  if [[ -n "$expected_owner" && "$actual_owner" != "$expected_owner" ]]; then
    owner_ok=false
  fi
  
  if [[ "$mode_ok" == false || "$owner_ok" == false ]]; then
    printf "  ${RED}WARNING: Permission mismatch on $mount_path${NC}\n"
    [[ -n "$expected_mode" ]] && printf "    ${RED}Expected mode: $expected_mode, got: $actual_mode${NC}\n"
    [[ -n "$expected_owner" ]] && printf "    ${RED}Expected owner: $expected_owner, got: $actual_owner${NC}\n"
    printf "    ${RED}Please check and correct permissions manually.${NC}\n"
  else
    printf "  ${GREEN}Verified: $mount_path${NC}"
    [[ -n "$expected_mode" ]] && printf " (mode $actual_mode)"
    [[ -n "$expected_owner" ]] && printf " (owner $actual_owner)"
    printf "\n"
  fi
}

cd "${SCRIPT_DIR}" || exit

# Create and sort list
CONTAINER_LIST=()
for DIR in *;do
  if [[ -d "${SCRIPT_DIR}/${DIR}" ]] && [[ -e "${SCRIPT_DIR}/${DIR}/compose.yaml" ]];then
    # Skip folders that contain a _DISABLED_ file
    if [[ ${RESTART_UNHEALTHY} = false ]] &&[[ -e "${SCRIPT_DIR}/${DIR}/_DISABLED_" ]];then
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

# Fix any necessary file permissions
if [[ -e "${HOME}/credentials/1password-credentials.json" ]]; then
  chmod o+r "${HOME}/credentials/1password-credentials.json"
fi

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
elif [[ -n "${SINGLE_CONTAINER}" ]]; then
  # Ensure that the single container exists as a folder in the containers directory
  if [[ ! -d "${SCRIPT_DIR}/${SINGLE_CONTAINER}" ]] || [[ ! -e "${SCRIPT_DIR}/${SINGLE_CONTAINER}/compose.yaml" ]]; then
    printf "${RED}Error: Container directory ${SINGLE_CONTAINER} does not exist or does not contain a compose.yaml file${NC}\n"
    exit 1
  fi

  # Filter CONTAINER_LIST to only include the single specified container
  FILTERED_LIST=()
  for ENTRY in "${CONTAINER_LIST[@]}"; do
    CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
    if [[ "${CONTAINER_DIR}" == "${SINGLE_CONTAINER}" ]]; then
      FILTERED_LIST+=("${ENTRY}")
    fi
  done
  CONTAINER_LIST=("${FILTERED_LIST[@]}")
  RESTART_LIST_TEXT="the container ${SINGLE_CONTAINER}"
  RESTART_LIST_TEXT_UPPER="The container ${SINGLE_CONTAINER}"
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
  # The list needs to be reversed when performing stop actions only
  readarray -t SORTED_CONTAINER_LIST < <(printf '%s\0' "${CONTAINER_LIST[@]}" | sort -rz | xargs -0n1)
elif [[ ${RESTART_UNHEALTHY} = true ]];then
  if [[ ${QUIET} = false ]];then
    printf "${YELLOW}Restarting unhealthy containers in ${RESTART_LIST_TEXT}...${NC}\n"
  fi
  readarray -t SORTED_CONTAINER_LIST < <(printf '%s\0' "${CONTAINER_LIST[@]}" | sort -z | xargs -0n1)
fi

if [[ ${LIST_MOUNTS} = true && ${START_ACTION} = false ]]; then
  printf "${YELLOW}Local mount points:${NC}\n\n"

  for ENTRY in "${CONTAINER_LIST[@]}"; do
    CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
    if [[ -d "${SCRIPT_DIR}/${CONTAINER_DIR}" ]] && [[ -e "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" ]]; then
      cd "${SCRIPT_DIR}/${CONTAINER_DIR}"

      printf "${BRIGHT_MAGENTA}${CONTAINER_DIR}:${NC}\n"
      mounts=$(list_local_mounts "compose.yaml" ".")
      if [[ -n "$mounts" ]]; then
        printf "%s\n" "$mounts"
      else
        printf "  (no local mounts)\n"
      fi
      printf "\n"
    fi
  done

  printf "${YELLOW}Mount listing complete.${NC}\n"
  exit 0
fi

for ENTRY in "${SORTED_CONTAINER_LIST[@]}";do
  CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
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
    if [[ ${RESTART_UNHEALTHY} = true ]];then
      # Check if any containers are unhealthy
      UNHEALTHY_COUNT=$(docker --log-level ERROR compose ps -a --format '{{.Status}}' | grep -c -v "(healthy)" || true)
      if [[ ${UNHEALTHY_COUNT} -eq 0 ]];then
        # No unhealthy containers, skip to next
        continue
      else
        printf "${YELLOW} - ${CONTAINER_DIR} has ${UNHEALTHY_COUNT} unhealthy container(s), restarting...${NC}\n"
        # Call THIS script with correct parameters to stop and start this container only
        "${SCRIPT_DIR}/scripts/all-containers.sh" --stop --start --container "${CONTAINER_DIR}" --no-wait --no-health-check
      fi
    fi
    if [[ ${STOP_ACTION} = true ]];then
      # Run a pre-down health check to update the time out to reduce the noise of early failures
      if [[ ${START_ACTION} = true && ${NO_HEALTH_CHECK} = false && -e "${HOME}/containers/scripts/system-health-check.sh" ]];then
        set +e
        "${HOME}/containers/scripts/system-health-check.sh" --run-health-check
        set -e
      fi
      printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"
      docker --log-level ERROR compose down
    fi
    if [[ ${START_ACTION} = true ]];then
      if [[ $(docker --log-level ERROR compose ps | wc -l) -eq 1 ]];then
        printf "${BRIGHT_MAGENTA} - ${CONTAINER_DIR}${NC}\n"

        if [[ ${LIST_MOUNTS} = true ]]; then
          printf "${YELLOW}Mount points for ${CONTAINER_DIR}:${NC}\n"
          mounts=$(list_local_mounts "compose.yaml" ".")
          if [[ -n "$mounts" ]]; then
            printf "%s\n" "$mounts"
          else
            printf "  (no local mounts)\n"
          fi
          printf "\n"
        fi

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
          docker --log-level ERROR compose pull
          docker --log-level ERROR compose build
        fi

        # Apply mount permissions before starting containers
        if [[ -f "mount-permissions.yaml" ]]; then
          apply_mount_permissions "mount-permissions.yaml"
        fi

        # IF the following are true, we will run this via the 1Password CLI
        # 0. The 1password CLI is installed
        # 1. The user's home directory contains a credentials/1password-connect.env file
        # 2. The 1password container is already running (it should start first)
        # 3. There is a .env file link in the container folder
        # 4. The .env file contains at least one entry that starts with "op://"
        if [[ -x "$(command -v op)" ]] && [[ "$(docker ps --filter "name=1password-connect-api" --filter "status=running" -q)" != "" ]] && [[ -f "${HOME}/credentials/1password-connect.env" ]] && [[ -f "${SCRIPT_DIR}/${CONTAINER_DIR}/1password_credential_paths.env" ]] && grep -q "op://" "${SCRIPT_DIR}/${CONTAINER_DIR}/1password_credential_paths.env"; then
          printf "${YELLOW}  Resolving environment variables via 1Password CLI...${NC}\n"
          if [[ -d "${HOME}/.config/op" ]];then
            chmod go-rx "${HOME}/.config/op"
          fi
          export OP_CONNECT_HOST="http://127.0.0.1:9980/"
          OP_CONNECT_TOKEN=$(grep "OP_CONNECT_TOKEN=" "${HOME}/credentials/1password-connect.env" | cut -d "=" -f 2-)
          export OP_CONNECT_TOKEN
          /usr/bin/op run --env-file 1password_credential_paths.env -- docker compose up -d --wait
        else
          docker compose up -d --wait
        fi
        set -e
        if [[ ${CONTAINER_DIR} = "homepage" ]];then
          # This is my personal hack to get icons the way I want them in homepage.
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/* /app/public"
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/favicon.ico /app/public/homepage.ico"
          docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/apple-icon.png /app/public/apple-touch-icon.png"
        fi

        if [[ ${NO_WAIT} = false ]];then
          printf "${YELLOW} ...Waiting for all containers to report healthy...${NC}\n"
          while /usr/bin/docker --log-level ERROR ps -a --format '{{.Status}}' | grep -v "(healthy)" > /dev/null; do
            sleep 0.1;
          done;
          printf "${YELLOW} ...Continuing to next task in ${SLEEP_TIME} seconds...${NC}\n"
          sleep "${SLEEP_TIME}"
          printf "\n"
        fi

        # If the container came from a list of containers to process, we need to remove it from the file so we don't try to process it again.
        if [[ ${GET_UPDATES} = true && -n "${CONTAINER_LIST_FILE}" ]]; then
          sed -i "/^${CONTAINER_DIR}\$/d" "${CONTAINER_LIST_FILE}"
          # If the container list file is empty, delete it
          if [[ ! -s "$CONTAINER_LIST_FILE" ]]; then
              echo "$CONTAINER_LIST_FILE file is empty, deleting..."
              rm -rf "$CONTAINER_LIST_FILE"
          fi
        fi

        # Further, IF there is a DIUN Upgrade list file (which may be the same file) do the same!
        if [[ ${GET_UPDATES} = true && -n "${DIUN_UPDATE_FILE}"  && -e "${DIUN_UPDATE_FILE}" ]]; then
          sed -i "/^${CONTAINER_DIR}\$/d" "${DIUN_UPDATE_FILE}"
          # If the container list file is empty, delete it
          if [[ ! -s "$DIUN_UPDATE_FILE" ]]; then
              echo "$DIUN_UPDATE_FILE file is empty, deleting..."
              rm -rf "$DIUN_UPDATE_FILE"
          fi
        fi
      fi
    fi
  else
    printf "${RED} - ${CONTAINER_DIR} is not a valid container directory${NC}\n"
    exit 1
  fi
done

if [[ ${NO_WAIT} = false ]];then
  printf "${YELLOW}Waiting for all containers to report healthy on final pass...${NC}\n\n"
  while /usr/bin/docker --log-level ERROR ps -a --format '{{.Status}}' | grep -v "(healthy)" > /dev/null; do
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
fi


if [[ ${START_ACTION} = true && ${STOP_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been restarted.${NC}\n"
elif [[ ${STOP_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been stopped.${NC}\n"
elif [[ ${START_ACTION} = true ]];then
  printf "${YELLOW}${RESTART_LIST_TEXT_UPPER} have been started.${NC}\n"
fi

# Run my check script to go ahead and let everyone know we are back up.
if [[ ${START_ACTION} = true && ${NO_HEALTH_CHECK} = false && -e "${HOME}/containers/scripts/system-health-check.sh" ]];then
  "${HOME}/containers/scripts/system-health-check.sh" --run-health-check
fi
