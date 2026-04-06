#!/bin/bash
# Migrates secrets from 1Password Connect to Infisical.
# Reads each container's 1password_credential_paths.env file,
# resolves the op:// references via the 1Password CLI,
# and writes the values to Infisical.
#
# Prerequisites:
# - 1Password Connect API must be running
# - ~/credentials/1password-connect.env must exist
# - Infisical must be running
# - ~/credentials/infisical.env must exist
# - infisical CLI must be installed
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Shared variables that go into /shared instead of per-container folders
SHARED_VARS="TS_AUTHKEY TS_DOMAIN HOST_NAME"

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v op &>/dev/null; then
  printf "${RED}1Password CLI (op) is not installed.${NC}\n"
  exit 1
fi

if ! command -v infisical &>/dev/null; then
  printf "${RED}Infisical CLI is not installed.${NC}\n"
  exit 1
fi

if [[ ! -f "${HOME}/credentials/1password-connect.env" ]]; then
  printf "${RED}Missing: ~/credentials/1password-connect.env${NC}\n"
  exit 1
fi

if [[ ! -f "${HOME}/credentials/infisical.env" ]]; then
  printf "${RED}Missing: ~/credentials/infisical.env${NC}\n"
  echo "Run scripts/setup-infisical.sh first."
  exit 1
fi

# Set up 1Password
export OP_CONNECT_HOST="http://127.0.0.1:9980/"
OP_CONNECT_TOKEN=$(grep "OP_CONNECT_TOKEN=" "${HOME}/credentials/1password-connect.env" | cut -d "=" -f 2-)
export OP_CONNECT_TOKEN

# Set up Infisical
# shellcheck disable=SC1091
source "${HOME}/credentials/infisical.env"
export INFISICAL_TOKEN INFISICAL_API_URL

echo ""
echo "=== Migrating secrets from 1Password to Infisical ==="
echo ""

MIGRATED=0
FAILED=0
SHARED_DONE=false

for env_file in "${SCRIPT_DIR}"/*/1password_credential_paths.env; do
  [[ -f "$env_file" ]] || continue
  container_name=$(basename "$(dirname "$env_file")")

  echo "Processing: ${container_name}"

  while IFS= read -r line; do
    # Skip comments and empty lines
    [[ -z "$line" || "$line" == \#* ]] && continue

    # Parse VAR_NAME="op://vault/item/field" or VAR_NAME:="op://..."
    var_name=$(echo "$line" | sed 's/:*=.*//')
    op_ref=$(echo "$line" | sed 's/^[^=]*=//; s/^"//; s/"$//')

    # Skip if not an op:// reference
    [[ "$op_ref" != op://* ]] && continue

    # Resolve the secret from 1Password
    set +e
    value=$(op read "$op_ref" 2>/dev/null)
    exit_code=$?
    set -e

    if [[ $exit_code -ne 0 || -z "$value" ]]; then
      printf "  ${YELLOW}SKIP: %s (could not resolve from 1Password)${NC}\n" "$var_name"
      FAILED=$((FAILED + 1))
      continue
    fi

    # Determine target folder
    target_folder="/${container_name}"
    for shared_var in $SHARED_VARS; do
      if [[ "$var_name" == "$shared_var" ]]; then
        target_folder="/shared"
        break
      fi
    done

    # Write to Infisical (skip shared vars if already done)
    if [[ "$target_folder" == "/shared" && "$SHARED_DONE" == true ]]; then
      continue
    fi

    set +e
    infisical secrets set "${var_name}=${value}" \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path="${target_folder}" \
      --env=prod \
      --domain="${INFISICAL_API_URL}" 2>/dev/null
    set -e

    printf "  ${GREEN}%s -> %s${NC}\n" "$var_name" "$target_folder"
    MIGRATED=$((MIGRATED + 1))

  done < "$env_file"

  # Mark shared vars as done after processing the first container that has them
  SHARED_DONE=true
done

echo ""
echo "============================================"
printf "${GREEN}Migration complete!${NC}\n"
echo "============================================"
echo ""
echo "  Migrated: ${MIGRATED} secrets"
echo "  Skipped:  ${FAILED} (could not resolve)"
echo ""
echo "You can verify secrets in the Infisical web UI."
echo "Once confirmed, you can disable the 1Password container."
echo ""
