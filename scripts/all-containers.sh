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
# Hard ceiling (seconds) shared by both `docker compose up --wait-timeout` and
# the host-wide "wait for containers to settle" loops below. The timeout only
# bites when a container is wedged mid-start, so it just needs to comfortably
# exceed the slowest healthcheck start_period (currently 600s for dawarich
# app/sidekiq); set too low it would turn a slow-but-fine start into a failure.
HEALTH_WAIT_TIMEOUT=900
MOUNT=""
CONTAINER_LIST_FILE=""
SKIP_CONTAINER_LIST_FILE=""
SINGLE_CONTAINER=""

NO_WAIT=false
UPDATE_GIT_REPOS=false
GET_UPDATES=false
# --no-fail is now a no-op (start is always resilient), kept for backward compatibility
# shellcheck disable=SC2034
NO_FAIL=false
NO_HEALTH_CHECK=false

QUIET=false

TEST_FAIL=false

LIST_MOUNTS=false
VALIDATE_ONLY=false

FAILED_CONTAINERS=()

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
                --container-list)
                  shift
                  CONTAINER_LIST_FILE="$1"
                  ;;
                --skip-container-list)
                  shift
                  SKIP_CONTAINER_LIST_FILE="$1"
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
                  # shellcheck disable=SC2034
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
                --validate-only)
                  VALIDATE_ONLY=true
                  START_ACTION=true
                  ;;
        esac
        shift
done

if [[ ${TEST_FAIL} = true ]];then
  echo "FAILING due to TEST FAIL REQUEST!"
  exit 1
fi

if [[ ${START_ACTION} = false && ${STOP_ACTION} = false && ${RESTART_UNHEALTHY} = false && ${LIST_MOUNTS} = false && ${UPDATE_GIT_REPOS} = false ]];then
  echo ""
  echo "Containers are enabled/disabled via the web admin Configuration tab (or by editing user-config.yaml directly)."
  echo ""
  echo "You must an action of either start or stop like this:"
  echo "all-containers.sh --start"
  echo "or"
  echo "all-containers.sh --stop"
  echo ""
  echo "You can also specify BOTH stop and start to stop and start each container one at a time."
  echo "Then if you include the --update-git-repos and --get-updates flags, it will update the git repos and get updates for each container one at a time."
  echo ""
  echo "Note: a single '--start --container <name>' is gated on dependencies and can be a no-op"
  echo "when the stack is only partly up. If Infisical (the secret store) is not running, any"
  echo "container that pulls shared/secret vars from it is SKIPPED rather than started with empty"
  echo "values -- this includes Infisical's own start path. To reliably (re)start one container,"
  echo "use '--stop --start --container <name>', which recreates just that compose project."
  echo ""
  echo "You can also adjust the sleep time between starting containers. Default is 10 seconds."
  echo "all-containers.sh --start --sleep 20"
  echo ""
  echo "You can also specify to only STOP containers which reference a given mount text in their compose.yaml files."
  echo "all-containers.sh --stop --mount 250a"
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
  echo ""
  echo "You can validate container configuration without starting anything:"
  echo "all-containers.sh --validate-only"
  echo "all-containers.sh --validate-only --container <container-name>"
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

# When pulling image updates, persist the whole run to a dated log so a failure
# that later self-heals can still be diagnosed (cron otherwise discards this
# output entirely). TTY-aware: tee to the terminal for interactive runs but
# redirect straight to the file under cron. Gated on --get-updates so ordinary
# start/stop/restart runs -- including the every-15-minute health-check restart
# -- do not write here. Self-pruned below (no root/logrotate dependency); the
# logs are date-stamped, so retention is just a find-delete of old files.
if [[ ${GET_UPDATES} = true ]]; then
  mkdir -p "${HOME}/logs"
  find "${HOME}/logs" -maxdepth 1 -name 'container-updates-*.log' -mtime +90 -delete 2>/dev/null || true
  UPDATE_LOG="${HOME}/logs/container-updates-$(date +%Y%m%d).log"
  if [ -t 1 ]; then
    exec > >(tee -a "${UPDATE_LOG}") 2>&1
  else
    exec >> "${UPDATE_LOG}" 2>&1
  fi
  echo ""
  echo "=========================================="
  echo "all-containers.sh --get-updates -- $(date)"
  echo "=========================================="
fi

DIUN_UPDATE_FILE=""
# Resolve the diun script volume path from its generated .env file.
# The diun compose.yaml uses ${VOL_DIUN_SCRIPT}/container-mounts/diun/script:/script,
# and VOL_DIUN_SCRIPT is set by scripts/generate-env.js based on container-registry.yaml.
DIUN_ENV_FILE="$SCRIPT_DIR/diun/.env"
if [ -f "$DIUN_ENV_FILE" ]; then
  # Read only VOL_DIUN_SCRIPT directly. A full `set -a; source` would
  # auto-export every variable in diun/.env (e.g. HOMEPAGE_GROUP=System
  # Monitoring), which then overrides each container's own .env during
  # `docker compose up` since shell-exported vars win over .env values.
  VOL_DIUN_SCRIPT=$(grep '^VOL_DIUN_SCRIPT=' "$DIUN_ENV_FILE" | cut -d= -f2-)
  SCRIPT_VOLUME_PATH="${VOL_DIUN_SCRIPT:-$HOME/container-data}/container-mounts/diun/script"
  DIUN_UPDATE_FILE="$SCRIPT_VOLUME_PATH/pendingContainerUpdates.txt"
fi

# Block until no container is still in the "(health: starting)" phase, i.e. the
# system has settled. Only *running* containers can be starting, so we scan
# `docker ps` (not `-a`).
#
# This deliberately waits ONLY on the transient "starting" state. The previous
# implementation waited for every container to read "(healthy)" via
# `grep -v "(healthy)"`, which meant any container that can never reach
# "(healthy)" -- one stuck in Created (a half-finished `compose up`), Exited,
# Restarting, unhealthy, or simply running without a healthcheck -- looped
# forever. (A `Created` dawarich sidekiq/ts pair wedged a whole update run this
# way.) Those states are "settled but unhappy"; we stop waiting and let the
# caller's system-health-check surface them rather than hanging here.
#
# A hard timeout backstops even the legitimate-but-slow case (a container whose
# start_period never elapses, or a healthcheck that flaps through "starting").
# $1 (optional): context label included in the timeout message.
wait_for_containers_to_settle() {
  local label="${1:-}"
  local deadline=$((SECONDS + HEALTH_WAIT_TIMEOUT))
  while /usr/bin/docker --log-level ERROR ps --format '{{.Status}}' | grep -q "(health: starting)"; do
    if (( SECONDS >= deadline )); then
      printf "${RED} ...Timed out after %ss waiting for containers to settle${label:+ (%s)}; continuing anyway:${NC}\n" "${HEALTH_WAIT_TIMEOUT}" "${label}"
      /usr/bin/docker --log-level ERROR ps --format '{{.Names}}\t{{.Status}}' | grep "(health: starting)" || true
      return 0
    fi
    sleep 0.5
  done
}

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

  realpath -m "$base_dir/$path"
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

resolve_mount_path() {
  # Expand ~ / $HOME / ${VOL_*} variables in a mount path so the same
  # mount-permissions.yaml works on every host. Sources the local .env
  # if present so ${VOL_*} from generate-env.js are in scope. Trusted-input:
  # the path comes from a YAML file checked into the repo.
  local raw_path="$1"

  # Strip surrounding quotes (yq returns paths without quotes; the fallback
  # parser may include them).
  raw_path="${raw_path#\"}"
  raw_path="${raw_path%\"}"
  raw_path="${raw_path#\'}"
  raw_path="${raw_path%\'}"

  # Source .env (in pwd) so ${VOL_*} variables defined by generate-env.js
  # are in scope for the eval below. Ignore failures. Note: must use "./.env"
  # — bash's `source` searches PATH (not pwd) when the filename has no slash.
  if [[ -f "./.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "./.env" 2>/dev/null || true
    set +a
  fi

  # Replace literal ~ with $HOME up front so we don't depend on tilde
  # expansion inside parameter-expansion defaults like ${X:-~/foo}.
  raw_path="${raw_path//\~/$HOME}"

  # Expand ${VAR} and ${VAR:-default} references without eval.
  local expanded="$raw_path"
  while [[ "$expanded" =~ \$\{([A-Za-z_][A-Za-z_0-9]*)(:-([^}]*))?\} ]]; do
    local var_name="${BASH_REMATCH[1]}"
    local default_val="${BASH_REMATCH[3]}"
    local replacement="${!var_name:-$default_val}"
    expanded="${expanded//${BASH_REMATCH[0]}/$replacement}"
  done
  echo "$expanded"
}

apply_mount_permissions() {
  local config_file="$1"

  if [[ ! -f "$config_file" ]]; then
    return
  fi

  # Test sudo access once at the start - required for chown operations
  # Test specifically for /usr/bin/chown since sudoers may allow only specific commands
  if ! sudo -n /usr/bin/chown nobody /dev/null 2>/dev/null; then
    printf "${RED}ERROR: sudo access required for chown operations.${NC}\n"
    printf "${RED}Please configure passwordless sudo for /usr/bin/chown.${NC}\n"
    printf "${RED}Add to /etc/sudoers:${NC}\n"
    printf "${RED}  $(whoami) ALL=(ALL) NOPASSWD: /usr/bin/chown${NC}\n"
    printf "${RED}Aborting.${NC}\n"
    exit 1
  fi

  printf "${YELLOW}Applying mount permissions...${NC}\n"

  # Check if yq is available for YAML parsing
  if command -v yq &> /dev/null; then
    # Use yq for proper YAML parsing. Emit all fields together via to_entries
    # so we don't have to substitute the path back into a yq query (which
    # would mis-handle paths containing $, : etc).
    local entries
    # Use "-" as placeholder for empty fields so bash read doesn't collapse
    # consecutive tab delimiters (which would shift fields left).
    entries=$(yq e '.mounts | to_entries | .[] | (.key + "\t" + (.value.mode // "-") + "\t" + (.value.owner // "-") + "\t" + ((.value.recursive // false) | tostring))' "$config_file" 2>/dev/null)

    while IFS=$'\t' read -r mount_path mode owner recursive; do
      [[ -z "$mount_path" ]] && continue
      # Convert placeholder back to empty
      [[ "$mode" == "-" ]] && mode=""
      [[ "$owner" == "-" ]] && owner=""

      # Resolve ~/$HOME/${VOL_*} variables in the path
      local resolved_path
      resolved_path=$(resolve_mount_path "$mount_path")

      # Apply permissions
      apply_single_mount_permission "$resolved_path" "$mode" "$owner" "$recursive"
    done <<< "$entries"
  else
    # Fallback: hand-rolled state-machine parser. Handles the limited
    # mount-permissions.yaml format used in this repo:
    #   mounts:
    #     <path>:                                <- 2-space indent, ":" terminator
    #       mode: "755"                          <- 4-space indent
    #       owner: "user:group"
    #       recursive: true
    #
    # Paths may be absolute (/mnt/...), tilde-prefixed (~/foo), or
    # quoted with shell-style variables ("${VOL_X:-~/foo}/bar").
    local -a entry_paths=()
    local -a entry_modes=()
    local -a entry_owners=()
    local -a entry_recursives=()
    local idx=-1
    local in_mounts=0
    local line key value p

    while IFS= read -r line || [[ -n "$line" ]]; do
      # Strip trailing CR (in case of CRLF)
      line="${line%$'\r'}"
      # Skip blank lines and comments
      [[ -z "${line//[[:space:]]/}" ]] && continue
      [[ "$line" =~ ^[[:space:]]*# ]] && continue

      # Top-level "mounts:" key opens the section
      if [[ "$line" =~ ^mounts: ]]; then
        in_mounts=1
        continue
      fi
      [[ $in_mounts -eq 0 ]] && continue

      # Mount path entry: exactly 2-space indent, ends with ":"
      if [[ "$line" =~ ^[[:space:]]{2}[^[:space:]].*:[[:space:]]*$ ]]; then
        idx=$((idx + 1))
        p="${line#  }"
        p="${p%:}"
        entry_paths[idx]="$p"
        entry_modes[idx]=""
        entry_owners[idx]=""
        entry_recursives[idx]="false"
        continue
      fi

      # Attribute line: 4-space indent, "key: value"
      if [[ $idx -ge 0 ]] && [[ "$line" =~ ^[[:space:]]{4}([a-z]+):[[:space:]]*(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        # Strip surrounding double quotes
        value="${value%\"}"
        value="${value#\"}"
        case "$key" in
          mode) entry_modes[idx]="$value" ;;
          owner) entry_owners[idx]="$value" ;;
          recursive) entry_recursives[idx]="$value" ;;
        esac
      fi
    done < "$config_file"

    local i resolved_path
    for ((i = 0; i <= idx; i++)); do
      resolved_path=$(resolve_mount_path "${entry_paths[i]}")
      apply_single_mount_permission "$resolved_path" "${entry_modes[i]}" "${entry_owners[i]}" "${entry_recursives[i]}"
    done
  fi
}

apply_single_mount_permission() {
  local mount_path="$1"
  local mode="$2"
  local owner="$3"
  local recursive="$4"

  # Create the mount path if missing. Without this, Docker would auto-create
  # the bind-mount source as root:root on first run, defeating the chown
  # below. Try without sudo first; fall back to sudo for cases where a
  # parent dir was previously created as root by Docker.
  if [[ ! -e "$mount_path" ]]; then
    printf "  ${YELLOW}mkdir -p $mount_path${NC}\n"
    if ! mkdir -p "$mount_path" 2>/dev/null; then
      if ! sudo mkdir -p "$mount_path" 2>/dev/null; then
        printf "${RED}ERROR: Failed to create mount path $mount_path${NC}\n"
        return 1
      fi
    fi
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
    local -a chmod_cmd=(chmod)
    if [[ "$recursive" == "true" ]]; then
      chmod_cmd=(chmod -R)
    fi

    printf "  ${YELLOW}chmod $chmod_args $mount_path${NC}"
    if [[ "$recursive" == "true" ]]; then
      printf " (recursive)"
    fi
    printf "\n"

    if ! "${chmod_cmd[@]}" "$chmod_args" "$mount_path" 2>/dev/null; then
      # Retry with sudo — Docker often creates mount subdirs as root
      if ! sudo "${chmod_cmd[@]}" "$chmod_args" "$mount_path" 2>/dev/null; then
        printf "${RED}WARNING: Failed to set mode $chmod_args on $mount_path, continuing...${NC}\n"
        return 1
      fi
    fi
  fi

  # Apply chown if specified
  if [[ -n "$chown_args" ]]; then
    local -a chown_cmd=(sudo /usr/bin/chown)
    if [[ "$recursive" == "true" ]]; then
      chown_cmd=(sudo /usr/bin/chown -R)
    fi

    printf "  ${YELLOW}chown $chown_args $mount_path${NC}"
    if [[ "$recursive" == "true" ]]; then
      printf " (recursive)"
    fi
    printf "\n"

    if ! "${chown_cmd[@]}" "$chown_args" "$mount_path" 2>/dev/null; then
      printf "${RED}WARNING: Failed to set owner $chown_args on $mount_path, continuing...${NC}\n"
      return 1
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
  
  # Get actual permissions — both name and numeric forms so the check
  # works regardless of whether mount-permissions.yaml uses "1000:1000"
  # or "chrisl8:chrisl8".
  local actual_owner_name actual_owner_numeric
  actual_owner_name=$(stat -c "%U:%G" "$mount_path" 2>/dev/null)
  actual_owner_numeric=$(stat -c "%u:%g" "$mount_path" 2>/dev/null)

  local actual_mode
  actual_mode=$(stat -c "%a" "$mount_path" 2>/dev/null)

  local mode_ok=true
  local owner_ok=true

  if [[ -n "$expected_mode" && "$actual_mode" != "$expected_mode" ]]; then
    mode_ok=false
  fi

  if [[ -n "$expected_owner" && "$actual_owner_name" != "$expected_owner" && "$actual_owner_numeric" != "$expected_owner" ]]; then
    owner_ok=false
  fi
  local actual_owner="$actual_owner_name"
  
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

# Remove a container's entry from a pending-update tracking file. This is
# pure bookkeeping that runs AFTER the real update work (pull/build) has
# already succeeded, so a write failure here must NEVER abort the run (we
# are under `set -e`) and leave the container stopped mid-deploy.
#
# DIUN auto-creates its /script bind-mount dir as root:root (it runs as
# root), but this script runs as the host user (uid 1000). `sed -i` stages
# its temp file in the target's DIRECTORY, so it fails with "Permission
# denied" on a root-owned dir -- which previously killed the whole script
# before --start. We instead rewrite the file in place (needs write on the
# file only, not its dir), fall back to sudo, and warn rather than abort.
clear_container_from_tracking_file() {
  local file="$1" entry="$2"
  [[ -n "${file}" && -e "${file}" ]] || return 0
  # `|| true`: grep -v exits 1 when it filters out *every* line (empty
  # result), which would otherwise trip `set -e` and abort the deploy.
  local remaining
  remaining=$(grep -v "^${entry}\$" "${file}" 2>/dev/null || true)
  if [[ -z "${remaining}" ]]; then
    if [[ -e "${file}" ]]; then
      echo "${file} would be empty, deleting..."
      rm -f "${file}" 2>/dev/null || sudo rm -f "${file}" 2>/dev/null || \
        printf "${YELLOW}  WARNING: could not remove tracking file ${file} (continuing)${NC}\n"
    fi
    return 0
  fi
  if ! printf '%s\n' "${remaining}" > "${file}" 2>/dev/null; then
    if ! printf '%s\n' "${remaining}" | sudo tee "${file}" >/dev/null 2>&1; then
      printf "${YELLOW}  WARNING: could not update tracking file ${file} (continuing)${NC}\n"
    fi
  fi
  return 0
}

cd "${SCRIPT_DIR}" || exit

# Ensure the shared caddy-net Docker network exists for caddy + web services
if [[ ${START_ACTION} = true ]]; then
  if ! docker network inspect caddy-net &>/dev/null; then
    docker network create --label keep caddy-net
  fi
  # Shared network so Nextcloud and the Euro-Office document server talk
  # directly over the local bridge (no Tailscale hop) for file fetch/save +
  # command service. The "keep" label exempts it from the prune below.
  if ! docker network inspect office-shared &>/dev/null; then
    docker network create --label keep office-shared
  fi
fi

# Determine which containers are enabled (per registry + user-config).
# Falls back to "all containers" if the helper isn't available.
ENABLED_LIST=""
LIST_HELPER="${SCRIPT_DIR}/scripts/list-enabled-containers.js"
if [[ -x "$(command -v node)" ]] && [[ -f "${LIST_HELPER}" ]]; then
  ENABLED_LIST=$(node "${LIST_HELPER}" 2>/dev/null || true)
fi

# Remove cron jobs for disabled containers (only on --start)
CRON_HELPER="${SCRIPT_DIR}/scripts/manage-cron-jobs.js"
if [[ ${START_ACTION} = true ]] && [[ -n "${ENABLED_LIST}" ]] && [[ -x "$(command -v node)" ]] && [[ -f "${CRON_HELPER}" ]]; then
  for DIR in *; do
    if [[ -d "${SCRIPT_DIR}/${DIR}" ]] && [[ -e "${SCRIPT_DIR}/${DIR}/compose.yaml" ]]; then
      STRIPPED_DIR=${DIR%*/}
      if ! echo "${ENABLED_LIST}" | grep -qx "${STRIPPED_DIR}"; then
        set +e
        node "${CRON_HELPER}" remove "${STRIPPED_DIR}" 2>/dev/null
        set -e
      fi
    fi
  done
fi

# Create and sort list
CONTAINER_LIST=()
for DIR in *;do
  if [[ -d "${SCRIPT_DIR}/${DIR}" ]] && [[ -e "${SCRIPT_DIR}/${DIR}/compose.yaml" ]];then
    STRIPPED_DIR=${DIR%*/}
    # Skip containers not in the enabled list (only if we have a list).
    if [[ -n "${ENABLED_LIST}" ]]; then
      if ! echo "${ENABLED_LIST}" | grep -qx "${STRIPPED_DIR}"; then
        continue
      fi
    fi
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
if [[ -e "${HOME}/credentials/infisical.env" ]]; then
  chmod 600 "${HOME}/credentials/infisical.env"
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

# If a skip-container-list file is provided, remove those directories from the
# working list. The health check uses this to stop restart-looping containers it
# has declared "stuck" (unhealthy for too many consecutive cycles, not
# self-healing) -- see UNHEALTHY_STREAK_THRESHOLD in system-health-check.sh.
if [[ -n "${SKIP_CONTAINER_LIST_FILE}" && -f "${SKIP_CONTAINER_LIST_FILE}" ]]; then
  mapfile -t SKIP_DIRS < "${SKIP_CONTAINER_LIST_FILE}"
  if [[ ${#SKIP_DIRS[@]} -gt 0 ]]; then
    FILTERED_LIST=()
    for ENTRY in "${CONTAINER_LIST[@]}"; do
      CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
      if [[ " ${SKIP_DIRS[*]} " == *" ${CONTAINER_DIR} "* ]]; then
        continue
      fi
      FILTERED_LIST+=("${ENTRY}")
    done
    CONTAINER_LIST=("${FILTERED_LIST[@]}")
  fi
fi

# If filtering left nothing to act on -- e.g. the requested --container is
# disabled (only enabled containers are added to CONTAINER_LIST above), or a
# skip-list/list-file excluded everything -- there is no work to do. Bail out
# cleanly here. Otherwise we fall through to the readarray blocks below where
# `printf '%s\0' "${CONTAINER_LIST[@]}"` on an EMPTY array still emits one
# empty record, which sort/xargs turn into a single empty element. That empty
# element then trips the main loop's " - is not a valid container directory"
# branch and exits 1 -- a confusing false failure (this is exactly how an
# "Update All" of the disabled-but-running filez stack reported a bogus
# failure from the web admin).
if [[ ${#CONTAINER_LIST[@]} -eq 0 ]]; then
  printf "${YELLOW}No matching enabled containers to act on; nothing to do.${NC}\n"
  exit 0
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

# Standalone --update-git-repos: clone missing repos or pull existing ones,
# then exit. When combined with --start/--stop the per-container logic below
# handles it instead.
GIT_REPOS_HELPER="${SCRIPT_DIR}/scripts/list-git-repos.js"
if [[ ${UPDATE_GIT_REPOS} = true && ${START_ACTION} = false && ${STOP_ACTION} = false ]]; then
  printf "${YELLOW}Cloning/updating external git repositories...${NC}\n"
  if [[ -x "$(command -v node)" ]] && [[ -f "${GIT_REPOS_HELPER}" ]]; then
    while IFS=$'\t' read -r REPO_CONTAINER REPO_SUBDIR REPO_URL REPO_BRANCH REPO_SHALLOW; do
      REPO_DIR="${SCRIPT_DIR}/${REPO_CONTAINER}/${REPO_SUBDIR}"
      if [[ -d "${REPO_DIR}/.git" ]]; then
        printf "${YELLOW}  Updating %s/%s${NC}\n" "${REPO_CONTAINER}" "${REPO_SUBDIR}"
        cd "${REPO_DIR}"
        git pull || printf "${RED}  Failed to update %s/%s${NC}\n" "${REPO_CONTAINER}" "${REPO_SUBDIR}"
        cd "${SCRIPT_DIR}"
      else
        printf "${YELLOW}  Cloning %s into %s/%s${NC}\n" "${REPO_URL}" "${REPO_CONTAINER}" "${REPO_SUBDIR}"
        CLONE_ARGS=()
        if [[ "${REPO_SHALLOW}" = "true" ]]; then
          CLONE_ARGS+=(--depth 1)
        fi
        # list-git-repos.js outputs "-" for empty fields (branch, shallow)
        # because bash read with IFS=$'\t' collapses consecutive tabs.
        if git clone "${CLONE_ARGS[@]}" "${REPO_URL}" "${REPO_DIR}"; then
          if [[ -n "${REPO_BRANCH}" && "${REPO_BRANCH}" != "-" ]]; then
            cd "${REPO_DIR}"
            git checkout "${REPO_BRANCH}"
            cd "${SCRIPT_DIR}"
          fi
        else
          printf "${RED}  Failed to clone %s/%s${NC}\n" "${REPO_CONTAINER}" "${REPO_SUBDIR}"
        fi
      fi
    done < <(node "${GIT_REPOS_HELPER}" 2>/dev/null)
  else
    printf "${RED}  Node.js or list-git-repos.js not available, skipping.${NC}\n"
  fi
  printf "${YELLOW}Git repository update complete.${NC}\n"
  exit 0
fi

# ── Tailscale preflight (before any container starts) ─────────────────
# If Infisical has a TS_API_TOKEN, run the Tailscale API preflight to
# catch ACL / auth-key misconfigurations early. Soft-skip on missing token
# (existing installs that predate this feature won't have one yet).
PREFLIGHT_SCRIPT="${SCRIPT_DIR}/scripts/lib/tailscale-preflight.js"
if [[ ${START_ACTION} = true ]] && \
   [[ "${SKIP_PREFLIGHT:-}" != "true" ]] && \
   [[ -x "$(command -v infisical)" ]] && \
   [[ -x "$(command -v node)" ]] && \
   [[ -f "${PREFLIGHT_SCRIPT}" ]] && \
   [[ -f "${HOME}/credentials/infisical.env" ]] && \
   docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
  # shellcheck disable=SC1091
  source "${HOME}/credentials/infisical.env"
  export INFISICAL_TOKEN INFISICAL_API_URL
  INFISICAL_ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
  # shellcheck disable=SC2086
  PREFLIGHT_TOKEN=$(infisical secrets get TS_API_TOKEN ${INFISICAL_ARGS} --path=/shared --silent --plain 2>/dev/null) || true
  if [[ -n "${PREFLIGHT_TOKEN}" ]]; then
    export TS_API_TOKEN="${PREFLIGHT_TOKEN}"
    # Also export TS_AUTHKEY and TS_DOMAIN for the auth-key and HTTPS checks
    # shellcheck disable=SC2086
    eval "$(infisical export ${INFISICAL_ARGS} --path="/shared" --format=dotenv-export 2>/dev/null)"
    set +e
    node "${PREFLIGHT_SCRIPT}" --quiet
    PREFLIGHT_EXIT=$?
    set -e
    if [[ ${PREFLIGHT_EXIT} -ne 0 ]]; then
      printf "${RED}Tailscale preflight failed. Fix the above and re-run.${NC}\n"
      exit 1
    fi
  fi
fi

for ENTRY in "${SORTED_CONTAINER_LIST[@]}";do
  CONTAINER_DIR="$(echo "$ENTRY" | cut -d "/" -f 2)"
  if [[ -d "${SCRIPT_DIR}/${CONTAINER_DIR}" ]] && [[ -e "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" ]];then

    if [[ ${MOUNT} != "" ]];then
      if [[ $(grep -v for-homepage "${SCRIPT_DIR}/${CONTAINER_DIR}/compose.yaml" | grep -v ScanHere | grep -c "/mnt/${MOUNT}/") -eq 0 ]];then
        continue
      fi
    fi
    cd "${SCRIPT_DIR}/${CONTAINER_DIR}"

    # Generate .env early so docker compose ps/down/up can parse the
    # compose.yaml (volume specs reference vars like TS_STATE_HOST_DIR
    # that live in .env). Without this, a missing .env causes
    # "invalid spec" errors and the container gets silently skipped.
    REGISTRY_FILE="${SCRIPT_DIR}/container-registry.yaml"
    USER_CONFIG_FILE="${SCRIPT_DIR}/user-config.yaml"
    GENERATE_ENV_SCRIPT="${SCRIPT_DIR}/scripts/generate-env.js"
    if [[ -f "${REGISTRY_FILE}" ]] && [[ -f "${USER_CONFIG_FILE}" ]] && [[ -x "$(command -v node)" ]] && [[ -f "${GENERATE_ENV_SCRIPT}" ]]; then
      set +e
      node "${GENERATE_ENV_SCRIPT}" "${CONTAINER_DIR}" --quiet 2>/dev/null
      set -e
    fi

    # Drift guard: the root compose.yaml is a gitignored RENDER of the module
    # source (see docs/MODULES.md). Edits made HERE instead of in the module are
    # silently overwritten on the next `module.sh update` -- the exact trap that
    # lost the recon recyclarr service. Warn loudly on start so a non-durable
    # root edit is caught now rather than vanishing later. Warn-only: never block
    # startup. compose.override.yaml is a separate file and is not compared.
    if [[ ${START_ACTION} = true ]]; then
      MODULE_SRC=""
      for MOD_DIR in "${SCRIPT_DIR}"/.modules/*/; do
        if [[ -f "${MOD_DIR}${CONTAINER_DIR}/compose.yaml" ]]; then
          MODULE_SRC="${MOD_DIR}${CONTAINER_DIR}/compose.yaml"
          break
        fi
      done
      if [[ -n "${MODULE_SRC}" ]] && ! diff -q "${MODULE_SRC}" "compose.yaml" >/dev/null 2>&1; then
        printf "${YELLOW}  WARNING: ${CONTAINER_DIR}/compose.yaml differs from its module source -- the root copy is a gitignored render and will be OVERWRITTEN on the next module update.${NC}\n"
        printf "${YELLOW}  Reconcile: 'scripts/module.sh dev-sync ${CONTAINER_DIR}' to push root edits into the module (or re-render if the module is newer). Source: ${MODULE_SRC#"${SCRIPT_DIR}"/}${NC}\n"
      fi
    fi

    if [[ ${RESTART_UNHEALTHY} = true ]];then
      # Check if any containers are unhealthy
      UNHEALTHY_COUNT=$(docker --log-level ERROR compose ps -a --format '{{.Status}}' | grep -c -v "(healthy)" || true)
      if [[ ${UNHEALTHY_COUNT} -eq 0 ]];then
        # No unhealthy containers, skip to next
        continue
      else
        printf "${YELLOW} - ${CONTAINER_DIR} has ${UNHEALTHY_COUNT} unhealthy container(s), restarting...${NC}\n"
        # Capture the failed container's logs/health BEFORE the restart below.
        # The recursive --stop --start runs `docker compose down`, which removes
        # the containers and destroys their logs -- so without this snapshot a
        # service that fails and later self-heals leaves nothing to diagnose.
        # Best-effort only: a capture failure must never abort the restart.
        set +e
        SNAP_DIR="${HOME}/logs/unhealthy-snapshots"
        mkdir -p "${SNAP_DIR}"
        SNAP_FILE="${SNAP_DIR}/${CONTAINER_DIR}-$(date +%Y%m%d-%H%M%S).log"
        {
          echo "=== unhealthy snapshot: ${CONTAINER_DIR} -- $(date) ==="
          echo "--- docker compose ps -a ---"
          docker --log-level ERROR compose ps -a
          echo "--- docker compose logs --no-color --tail=300 ---"
          docker --log-level ERROR compose logs --no-color --tail=300
          echo "--- docker inspect health (per service) ---"
          docker --log-level ERROR compose ps -aq | while read -r SNAP_CID; do
            [[ -z "${SNAP_CID}" ]] && continue
            echo "## $(docker inspect --format '{{.Name}}' "${SNAP_CID}")"
            docker inspect --format '{{json .State.Health}}' "${SNAP_CID}" 2>/dev/null
          done
        } >> "${SNAP_FILE}" 2>&1
        # Keep the snapshots directory bounded.
        find "${SNAP_DIR}" -type f -name '*.log' -mtime +14 -delete 2>/dev/null
        set -e
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
      # Announce any orphan containers the --remove-orphans below will delete --
      # a running container whose service is no longer in compose.yaml (e.g. a
      # service dropped from a module update). Without this, such a container is
      # removed silently; surfacing it means a clobbered service announces itself
      # instead of just vanishing.
      while IFS=$'\t' read -r ORPHAN_NAME ORPHAN_SVC; do
        [[ -z "${ORPHAN_SVC}" ]] && continue
        if ! grep -qE "^  ${ORPHAN_SVC}:" compose.yaml 2>/dev/null; then
          printf "${YELLOW}  NOTE: removing orphan ${ORPHAN_NAME} -- service '${ORPHAN_SVC}' is no longer in ${CONTAINER_DIR}/compose.yaml. If unintended, it was likely dropped from the module; restore it there.${NC}\n"
        fi
      done < <(docker ps -a --filter "label=com.docker.compose.project=${CONTAINER_DIR}" --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null)
      # --remove-orphans clears containers no longer defined in compose.yaml
      # (e.g. a service dropped from a module update). Without it, a lingering
      # orphan keeps the project non-empty, which trips the `compose ps | wc -l
      # -eq 1` gate below and silently skips `compose up` -- wedging the whole
      # stack's startup on every restart.
      docker --log-level ERROR compose down --remove-orphans
    fi
    if [[ ${START_ACTION} = true ]];then
      # Auto-clone any declared git_repos whose .git is missing. Runs on every
      # --start regardless of whether the container is currently running, so
      # the on-disk state always matches container-registry.yaml. Stateless:
      # a no-op when every declared repo is already present. Bind-mount targets
      # are live, so a clone here takes effect for the running container too
      # (e.g. homepage's dashboard-icons feeds web-admin's icon lookup).
      if [[ -x "$(command -v node)" ]] && [[ -f "${GIT_REPOS_HELPER}" ]]; then
        while IFS=$'\t' read -r _RC REPO_SUBDIR REPO_URL REPO_BRANCH REPO_SHALLOW; do
          if [[ ! -d "${REPO_SUBDIR}/.git" ]]; then
            printf "${YELLOW}  Cloning ${REPO_URL} into ${REPO_SUBDIR}${NC}\n"
            # Docker may have auto-created an empty bind-mount target; git
            # clone refuses non-empty dirs, so rmdir empty ones first.
            if [[ -d "${REPO_SUBDIR}" ]] && [[ -z "$(ls -A "${REPO_SUBDIR}" 2>/dev/null)" ]]; then
              rmdir "${REPO_SUBDIR}" 2>/dev/null || true
            fi
            CLONE_ARGS=()
            if [[ "${REPO_SHALLOW}" = "true" ]]; then
              CLONE_ARGS+=(--depth 1)
            fi
            if git clone "${CLONE_ARGS[@]}" "${REPO_URL}" "${REPO_SUBDIR}"; then
              # list-git-repos.js outputs "-" for empty branch; skip checkout then.
              if [[ -n "${REPO_BRANCH}" && "${REPO_BRANCH}" != "-" ]]; then
                cd "${REPO_SUBDIR}"
                git checkout "${REPO_BRANCH}"
                cd "${SCRIPT_DIR}/${CONTAINER_DIR}"
              fi
            else
              printf "${RED}  Failed to clone ${REPO_SUBDIR}${NC}\n"
              # Clean up any partial clone so the next start retries cleanly.
              if [[ -d "${REPO_SUBDIR}" ]] && [[ ! -d "${REPO_SUBDIR}/.git" ]]; then
                rm -rf "${REPO_SUBDIR}"
              fi
            fi
          fi
        done < <(node "${GIT_REPOS_HELPER}" --container "${CONTAINER_DIR}" 2>/dev/null)
      fi

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
          # Pull updates for existing git repos defined in container-registry.yaml.
          # Missing repos are cloned by the pre-gate auto-clone block above, so
          # this branch only handles refreshing existing checkouts.
          if [[ -x "$(command -v node)" ]] && [[ -f "${GIT_REPOS_HELPER}" ]]; then
            while IFS=$'\t' read -r _REPO_CONTAINER REPO_SUBDIR _REPO_URL _REPO_BRANCH _REPO_SHALLOW; do
              if [[ -d "${REPO_SUBDIR}/.git" ]]; then
                printf "${YELLOW}  Updating git repository in ${REPO_SUBDIR}${NC}\n"
                cd "${REPO_SUBDIR}"
                git pull || printf "${RED}  Failed to update ${REPO_SUBDIR}${NC}\n"
                cd "${SCRIPT_DIR}/${CONTAINER_DIR}"
              fi
            done < <(node "${GIT_REPOS_HELPER}" --container "${CONTAINER_DIR}" 2>/dev/null)
          fi
          # Special case: caddy/site/my-digital-garden requires npm rebuild after pull.
          # Wrap in set +e: a transient npm/network/build failure here should not abort
          # the whole container update — the existing dist/ keeps serving until the next
          # successful rebuild.
          if [[ -e site/my-digital-garden/.git ]];then
            printf "${YELLOW}  Updating git repository in site/my-digital-garden${NC}\n"
            set +e
            cd site/my-digital-garden
            DG_EXIT=$?
            if [[ ${DG_EXIT} -eq 0 ]]; then
              git pull
              printf "${YELLOW}    Updating dependencies in site/my-digital-garden${NC}\n"
              rm -rf node_modules
              rm -f package-lock.json
              npm i
              DG_EXIT=$?
              if [[ ${DG_EXIT} -eq 0 ]]; then
                printf "${YELLOW}    Rebuilding site/my-digital-garden${NC}\n"
                npm run build
                DG_EXIT=$?
                if [[ ${DG_EXIT} -eq 0 ]]; then
                  /usr/bin/chmod -R o+rX dist
                fi
              fi
              cd "${SCRIPT_DIR}/${CONTAINER_DIR}"
            fi
            if [[ ${DG_EXIT} -ne 0 ]]; then
              printf "${RED}  WARNING: my-digital-garden rebuild failed (exit code ${DG_EXIT}), continuing with existing dist/...${NC}\n"
            fi
            set -e
          fi
        fi
        if [[ ${GET_UPDATES} = true ]];then
          printf "${YELLOW}  Pulling updates and rebuilding...${NC}\n"
          set +e
          docker --log-level ERROR compose pull
          PULL_EXIT=$?
          set -e
          if [[ ${PULL_EXIT} -ne 0 ]]; then
            printf "${RED}  WARNING: pull failed for ${CONTAINER_DIR} (exit code ${PULL_EXIT}), continuing with existing images...${NC}\n"
          fi
          set +e
          docker --log-level ERROR compose build
          set -e

          # Clear this container from any pending-update tracking files now,
          # before `docker compose up --wait` runs. The pull/build above is the
          # actual "update" work; a later --wait timeout (common on multi-
          # container stacks where one healthcheck is slow) does not mean the
          # update failed, so it should not leave the entry stuck in the file.
          clear_container_from_tracking_file "${CONTAINER_LIST_FILE}" "${CONTAINER_DIR}"
          clear_container_from_tracking_file "${DIUN_UPDATE_FILE}" "${CONTAINER_DIR}"
        fi

        INFISICAL_CRED_FILE="${HOME}/credentials/infisical.env"

        # If this container references any shared variable that lives in
        # Infisical (TS_AUTHKEY, TS_DOMAIN, HOST_NAME), Infisical must be
        # reachable: those vars are injected into the shell env at start
        # time below via `infisical export --path=/shared`. Without
        # Infisical we have no source of truth, so fail clearly rather
        # than starting with empty values. DOCKER_GID is omitted from this
        # check because compose files use ${DOCKER_GID:-985} -- it has a
        # built-in fallback and won't break startup.
        if grep -qE '\$\{(TS_AUTHKEY|TS_DOMAIN|HOST_NAME)\}' compose.yaml 2>/dev/null; then
          if [[ ! -f "${INFISICAL_CRED_FILE}" ]] || ! docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
            printf "${RED}  SKIPPING ${CONTAINER_DIR}: Infisical must be running to start containers that use shared variables.${NC}\n"
            printf "${RED}  Shared variables (TS_AUTHKEY, TS_DOMAIN, HOST_NAME) are stored in Infisical only -- start Infisical first, then retry.${NC}\n"
            FAILED_CONTAINERS+=("${CONTAINER_DIR}")
            continue
          fi
        fi

        if [[ -f "${REGISTRY_FILE}" ]] && [[ -f "${USER_CONFIG_FILE}" ]] && [[ -x "$(command -v node)" ]] && [[ -f "${GENERATE_ENV_SCRIPT}" ]]; then
          # Only validate when Infisical is NOT available (secrets come from infisical run, not .env)
          if [[ ! -f "${INFISICAL_CRED_FILE}" ]] || ! docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
            set +e
            node "${GENERATE_ENV_SCRIPT}" "${CONTAINER_DIR}" --validate-only --quiet
            VALIDATE_EXIT=$?
            set -e
            if [[ ${VALIDATE_EXIT} -ne 0 ]]; then
              printf "${RED}  SKIPPING ${CONTAINER_DIR}: missing required configuration.${NC}\n"
              printf "${RED}  Run 'node scripts/generate-env.js ${CONTAINER_DIR} --validate-only' for details.${NC}\n"
              FAILED_CONTAINERS+=("${CONTAINER_DIR}")
              continue
            fi
          fi
        fi

        if [[ ${VALIDATE_ONLY} = true ]]; then
          printf "${YELLOW}  ${CONTAINER_DIR}: configuration valid${NC}\n"
          continue
        fi

        # Export Infisical /shared into the environment BEFORE the pre-start
        # hooks run. merge-homepage-config.js needs HOST_NAME / TS_DOMAIN from
        # /shared to substitute the placeholders in homepage/config-defaults/.
        # Without this, the merge produces literal `${HOST_NAME}.${TS_DOMAIN}`
        # in the rendered config and the homepage greeting/links break.
        # The container-specific /${CONTAINER_DIR} export still happens later,
        # right before docker compose up.
        INFISICAL_AVAILABLE=false
        INFISICAL_ARGS=""
        set +e
        if [[ -x "$(command -v infisical)" ]] && [[ "$(docker ps --filter "name=infisical" --filter "status=running" -q)" != "" ]] && [[ -f "${HOME}/credentials/infisical.env" ]]; then
          # shellcheck disable=SC1091
          source "${HOME}/credentials/infisical.env"
          export INFISICAL_TOKEN INFISICAL_API_URL
          INFISICAL_ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
          # shellcheck disable=SC2086
          eval "$(infisical export ${INFISICAL_ARGS} --path="/shared" --format=dotenv-export 2>/dev/null)"
          INFISICAL_AVAILABLE=true
        fi
        set -e

        # Apply mount permissions first — pre-start hooks (merge-homepage-config,
        # config-defaults handler) need write access to directories that Docker
        # may have created as root.
        if [[ -f "mount-permissions.yaml" ]]; then
          set +e
          apply_mount_permissions "mount-permissions.yaml"
          set -e
        fi

        # Per-container pre-start hooks.
        # homepage and beszel get their monitoring mounts regenerated from
        # user-config.yaml (writes a gitignored compose.override.yaml that
        # Docker Compose auto-loads).
        if [[ "${CONTAINER_DIR}" == "homepage" || "${CONTAINER_DIR}" == "beszel" ]]; then
          set +e
          node "${SCRIPT_DIR}/scripts/regenerate-monitoring-mounts.js"
          set -e
        fi
        # homepage also gets its config/ dir regenerated from
        # config-defaults/ + config-personal/.
        if [[ "${CONTAINER_DIR}" == "homepage" ]]; then
          set +e
          node "${SCRIPT_DIR}/scripts/merge-homepage-config.js" --quiet
          set -e
        fi
        # Generic config-defaults handler: any container (except homepage,
        # which has its own YAML merge script) that ships a config-defaults/
        # directory gets its files copied to the matching paths. Files in
        # config-personal/ take precedence, so users can override defaults
        # without touching git-tracked files.
        #
        # Clobber guard (dpkg-conffile model): only overwrite an existing
        # target while it still matches the content we last wrote there. If the
        # live file has diverged — edited by the user, or rewritten by the app
        # at runtime (as The Lounge does with config.js) — we refuse to replace
        # it with the packaged default and emit a notice instead. The "what we
        # last installed" hashes live at the repo root, outside the ephemeral
        # container dirs, so a module re-render can't lose them.
        if [[ -d "config-defaults" ]] && [[ "${CONTAINER_DIR}" != "homepage" ]]; then
          set +e
          state_base="${SCRIPT_DIR}/.config-defaults-state/${CONTAINER_DIR}"
          while IFS= read -r -d '' default_file; do
            rel_path="${default_file#config-defaults/}"
            target_dir="$(dirname "$rel_path")"
            [[ "$target_dir" != "." ]] && mkdir -p "$target_dir"
            if [[ -f "config-personal/${rel_path}" ]]; then
              source_file="config-personal/${rel_path}"
            else
              source_file="$default_file"
            fi
            state_file="${state_base}/${rel_path}.sha256"
            record_state() { mkdir -p "$(dirname "$state_file")"; sha256sum "$source_file" | cut -d' ' -f1 > "$state_file"; }
            # Nothing there yet: seed it and record what we wrote.
            if [[ ! -f "$rel_path" ]]; then
              if cp "$source_file" "$rel_path" 2>/dev/null; then record_state; else
                printf "${YELLOW}  warning: could not seed %s in %s (destination owned by another user — manual resync required)${NC}\n" "$rel_path" "${CONTAINER_DIR}" >&2
              fi
              continue
            fi
            # Already byte-identical to the source — keep the state marker fresh.
            if cmp -s "$source_file" "$rel_path"; then record_state; continue; fi
            # Target differs from the source. Safe to update only if the live
            # file is unchanged since we last wrote it (i.e. the packaged
            # default genuinely moved); otherwise leave the local copy alone.
            target_hash="$(sha256sum "$rel_path" | cut -d' ' -f1)"
            applied_hash=""
            [[ -f "$state_file" ]] && applied_hash="$(cat "$state_file" 2>/dev/null)"
            if [[ -n "$applied_hash" && "$target_hash" == "$applied_hash" ]]; then
              if cp "$source_file" "$rel_path" 2>/dev/null; then record_state; else
                printf "${YELLOW}  warning: could not update %s in %s (destination owned by another user — manual resync required)${NC}\n" "$rel_path" "${CONTAINER_DIR}" >&2
              fi
            else
              printf "${YELLOW}  notice: %s in %s differs from the packaged default and looks locally modified — leaving it untouched (not clobbering).${NC}\n" "$rel_path" "${CONTAINER_DIR}" >&2
              printf "${YELLOW}          adopt default: rm '%s/%s'  |  keep yours: cp it into '%s/config-personal/%s'${NC}\n" "${CONTAINER_DIR}" "$rel_path" "${CONTAINER_DIR}" "$rel_path" >&2
            fi
          done < <(find config-defaults -type f -print0)
          unset -f record_state 2>/dev/null
          set -e
        fi

        # Check host package dependencies (warn only, never blocks startup)
        HOST_PKG_HELPER="${SCRIPT_DIR}/scripts/check-host-packages.js"
        if [[ -x "$(command -v node)" ]] && [[ -f "${HOST_PKG_HELPER}" ]]; then
          set +e
          node "${HOST_PKG_HELPER}" "${CONTAINER_DIR}"
          set -e
        fi

        # Run one-time setup hooks (tracked in installed-modules.yaml)
        SETUP_HOOKS_HELPER="${SCRIPT_DIR}/scripts/run-setup-hooks.js"
        if [[ -x "$(command -v node)" ]] && [[ -f "${SETUP_HOOKS_HELPER}" ]]; then
          set +e
          node "${SETUP_HOOKS_HELPER}" "${CONTAINER_DIR}"
          set -e
        fi

        # If Infisical is available, also export the per-container secrets
        # before starting. /shared was already exported above.
        set +e
        if [[ "${INFISICAL_AVAILABLE}" = "true" ]]; then
          printf "${YELLOW}  Injecting secrets via Infisical...${NC}\n"
          # shellcheck disable=SC2086
          eval "$(infisical export ${INFISICAL_ARGS} --path="/${CONTAINER_DIR}" --format=dotenv-export 2>/dev/null)"
        fi
        # Pre-flight: catch the failure mode where compose.yaml bind-mounts a
        # host file that's missing or has been turned into an empty directory
        # by a previous Docker auto-create. Skips this container's start (does
        # not abort the batch) on failure.
        BIND_MOUNT_HELPER="${SCRIPT_DIR}/scripts/check-bind-mounts.js"
        if [[ -x "$(command -v node)" ]] && [[ -f "${BIND_MOUNT_HELPER}" ]]; then
          node "${BIND_MOUNT_HELPER}" "${CONTAINER_DIR}"
          BIND_MOUNT_EXIT=$?
          if [[ ${BIND_MOUNT_EXIT} -ne 0 ]]; then
            set -e
            printf "${RED} - ${CONTAINER_DIR} pre-flight bind-mount check failed (exit ${BIND_MOUNT_EXIT}); skipping start${NC}\n"
            FAILED_CONTAINERS+=("${CONTAINER_DIR}")
            continue
          fi
        fi
        # --wait-timeout bounds the per-project wait so a container whose
        # healthcheck never passes (flapping, or a start_period that never
        # elapses) surfaces as a clean start failure instead of blocking the
        # whole run. Must exceed the slowest start_period; reuses the same
        # ceiling as the host-wide settle loops.
        docker compose up -d --wait --wait-timeout "${HEALTH_WAIT_TIMEOUT}"
        COMPOSE_EXIT_CODE=$?
        set -e
        if [[ ${COMPOSE_EXIT_CODE} -ne 0 ]]; then
          # `docker compose up --wait` can time out while a dependency's
          # healthcheck is still failing -- classically a gluetun VPN sidecar
          # reconnecting after a network blip. When that happens, any app
          # container gated on it via `depends_on: condition: service_healthy`
          # is left in the `Created` state: compose made the container but never
          # started it. Nothing ever starts a `Created` container on its own, so
          # it sits dead until a human intervenes (this is exactly how
          # secure-browser/browser got orphaned and escalated). Force-start any
          # such orphans here: `docker compose start` ignores the
          # service_healthy gate, and a gluetun-gated app shares the sidecar's
          # network namespace -- with gluetun's kill-switch traffic stays
          # blocked (not leaked) until the VPN recovers -- so the container can
          # self-heal once the dependency comes back instead of escalating.
          set +e
          ORPHANED_CREATED=$(docker --log-level ERROR compose ps -a --format '{{.Name}}\t{{.Status}}' | awk -F'\t' '$2 ~ /^Created/ {print $1}')
          if [[ -n "${ORPHANED_CREATED}" ]]; then
            printf "${YELLOW} - ${CONTAINER_DIR} up timed out with containers stuck in Created (%s); force-starting so they can self-heal${NC}\n" "$(echo "${ORPHANED_CREATED}" | tr '\n' ' ')"
            docker --log-level ERROR compose start
          fi
          # Re-check: only the containers STILL in Created after the force-start
          # represent a real, unrecoverable failure (e.g. a bad image or a crash
          # before the namespace is up). If we cleared them, the per-container
          # healthcheck governs from here, so don't flag the project as failed.
          STILL_CREATED=$(docker --log-level ERROR compose ps -a --format '{{.Name}}\t{{.Status}}' | awk -F'\t' '$2 ~ /^Created/ {print $1}')
          set -e
          if [[ -n "${STILL_CREATED}" ]]; then
            printf "${RED} - ${CONTAINER_DIR} FAILED to start (exit code ${COMPOSE_EXIT_CODE})${NC}\n"
            FAILED_CONTAINERS+=("${CONTAINER_DIR}")
            continue
          fi
          printf "${YELLOW} - ${CONTAINER_DIR} up timed out (exit code ${COMPOSE_EXIT_CODE}) but no containers left in Created; continuing${NC}\n"
        fi
        if [[ ${CONTAINER_DIR} = "homepage" ]];then
          # Personal favicon overlay: if the user has dropped favicon files
          # into the bind-mounted homepage/images/favicons/ dir on the host,
          # copy them to /app/public so homepage serves them as site icons.
          # Skipped silently when the dir is empty or missing (fresh installs
          # have nothing in homepage/images/ except a .gitkeep). Wrapped in
          # set +e so a failure here can never abort the broader start loop
          # before the next container in the list runs.
          set +e
          if docker exec homepage sh -c '[ -d /app/public/images/favicons ] && [ -n "$(ls -A /app/public/images/favicons 2>/dev/null)" ]' 2>/dev/null; then
            docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/* /app/public" 2>/dev/null
            docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/favicon.ico /app/public/homepage.ico" 2>/dev/null
            docker exec --user 0 homepage sh -c "cp /app/public/images/favicons/apple-icon.png /app/public/apple-touch-icon.png" 2>/dev/null
          fi
          set -e
        fi

        # Install cron jobs declared by this container (after successful start)
        if [[ -x "$(command -v node)" ]] && [[ -f "${CRON_HELPER}" ]]; then
          set +e
          node "${CRON_HELPER}" sync "${CONTAINER_DIR}"
          set -e
        fi

        if [[ ${NO_WAIT} = false ]];then
          printf "${YELLOW} ...Waiting for all containers to report healthy...${NC}\n"
          wait_for_containers_to_settle "after ${CONTAINER_DIR}"
          printf "${YELLOW} ...Continuing to next task in ${SLEEP_TIME} seconds...${NC}\n"
          sleep "${SLEEP_TIME}"
          printf "\n"
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
  wait_for_containers_to_settle "final pass"

  if [[ ${START_ACTION} = true ]];then
    printf "${YELLOW}Performing post-start chores${NC}\n"
    # Prune images now to clear any left over after upgrades.
    # This ensures all images we don't use are pruned, but none that we do use
    docker image prune -af

    # Remove build cache that accumulates from docker build
    docker builder prune -af

    # Remove unnamed and unused volumes that get left behind
    docker volume prune -af

    # Remove unused networks that get left behind
    # The "label!=keep" filter preserves shared external networks like caddy-net
    docker network prune -f --filter "label!=keep"
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
# The system health check is a global concern (whole-tailnet status,
# container count drift, healthchecks.io ping). When starting a single
# container it just produces noise from unrelated state — and worse,
# any offline tailnet device elsewhere causes it to exit non-zero,
# which under set -e fails the whole script and causes the caller
# (web admin "Start All", per-container restart) to mark a perfectly
# healthy start as failed. Skip it in single-container mode.
if [[ ${START_ACTION} = true && ${NO_HEALTH_CHECK} = false && -z "${SINGLE_CONTAINER}" && -e "${HOME}/containers/scripts/system-health-check.sh" ]];then
  "${HOME}/containers/scripts/system-health-check.sh" --run-health-check
fi

# Report any containers that failed to start
if [[ ${#FAILED_CONTAINERS[@]} -gt 0 ]]; then
  printf "${RED}The following containers failed to start:${NC}\n"
  for FAILED in "${FAILED_CONTAINERS[@]}"; do
    printf "${RED} - ${FAILED}${NC}\n"
  done
  exit 1
fi
