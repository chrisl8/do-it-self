#!/bin/bash
# Spins up a Hetzner Cloud server, runs the full setup, validates, and optionally tears down.
#
# Prerequisites:
#   - hcloud CLI installed and authenticated (hcloud context create)
#   - An SSH key registered with Hetzner (hcloud ssh-key list)
#
# Usage:
#   scripts/hetzner-test.sh                    # Full test cycle (create, test, destroy)
#   scripts/hetzner-test.sh --keep             # Leave server running after test
#   scripts/hetzner-test.sh --destroy          # Destroy the test server
#   scripts/hetzner-test.sh --retest           # Re-run tests on existing server
#   scripts/hetzner-test.sh --browse           # Open SOCKS proxy after tests for manual browsing
#   scripts/hetzner-test.sh --type cx32        # Use a different server type
#   scripts/hetzner-test.sh --ts-key KEY       # Provide Tailscale auth key
#
# IMPORTANT: --ts-key requires an auth key created with the `tag:container`
# ACL tag. Every container sidecar in this repo advertises that tag, and the
# Tailscale control plane will reject registration without it. Create the key
# in the Tailscale admin console (Settings → Keys → Generate auth key), check
# `tag:container` under tags before generating, and ensure `tag:container`
# is defined in your tailnet ACL policy. The key SHOULD be reusable so all 40+
# container sidecars can register with it.
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

SERVER_NAME="do-it-self-test"
SERVER_TYPE="cpx32"
IMAGE="ubuntu-24.04"
LOCATION="nbg1"
KEEP=false
KEEP_IF_FAILS=true
DESTROY_ONLY=false
RETEST=false
BROWSE=false
TS_KEY=""
TS_API_TOKEN=""
TS_TAILNET="-"
LOG_DIR="/tmp/hetzner-test-logs"
AT_JOB_FILE="/tmp/hetzner-test-at-job"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=true ;;
    --no-keep-if-fails) KEEP_IF_FAILS=false ;;
    --destroy) DESTROY_ONLY=true ;;
    --retest) RETEST=true ;;
    --browse) BROWSE=true ;;
    --type) shift; SERVER_TYPE="$1" ;;
    --ts-key) shift; TS_KEY="$1" ;;
    --ts-api-token) shift; TS_API_TOKEN="$1" ;;
    --ts-tailnet) shift; TS_TAILNET="$1" ;;
    --location) shift; LOCATION="$1" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# setup.sh requires both TS_AUTHKEY and TS_API_TOKEN (Tailscale is a hard
# prerequisite, and the API token drives the preflight checks that catch
# ACL / auth-key misconfigurations). Destroy-only and retest paths don't
# run setup.sh and so don't need either key.
if [[ "$DESTROY_ONLY" != true ]] && [[ "$RETEST" != true ]]; then
  if [[ -z "$TS_KEY" ]] || [[ -z "$TS_API_TOKEN" ]]; then
    printf "${RED}Both --ts-key and --ts-api-token are required.${NC}\n"
    printf "setup.sh requires a Tailscale auth key and an API access token.\n"
    printf "Both are created at: https://login.tailscale.com/admin/settings/keys\n\n"
    printf "  --ts-key tskey-auth-...        Auth key (Reusable=ON, Tags=tag:container)\n"
    printf "  --ts-api-token tskey-api-...   API token (scroll to 'API access tokens')\n"
    exit 1
  fi
fi

# Delete every Tailscale device that belongs to a test run: the host VM
# (matched by hostname == $SERVER_NAME, or name starting with "$SERVER_NAME.")
# AND every container sidecar (matched by the "tag:container" tag, which
# every sidecar in this repo advertises and which the host VM also inherits
# from the tagged auth key). Used as a pre-build sweep, in --destroy, and on
# the success path so nodes from prior runs never accumulate. No-op when
# --ts-api-token was not provided. Assumes a dedicated test tailnet — see
# docs/TESTING.md "Use a separate test tailnet".
cleanup_tailscale_nodes() {
  if [[ -z "$TS_API_TOKEN" ]]; then
    return 0
  fi
  printf "${YELLOW}Checking for stale Tailscale test nodes...${NC}\n"
  local node_ids
  node_ids=$(curl -sf -H "Authorization: Bearer ${TS_API_TOKEN}" \
    "https://api.tailscale.com/api/v2/tailnet/${TS_TAILNET}/devices?fields=all" 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);(j.devices||[]).filter(x=>x.hostname==='${SERVER_NAME}'||(x.name||'').startsWith('${SERVER_NAME}.')||(x.tags||[]).includes('tag:container')).forEach(dev=>console.log(dev.id+'\t'+(dev.hostname||dev.name||'?')));}catch(e){}});" 2>/dev/null)
  if [[ -z "$node_ids" ]]; then
    printf "${GREEN}No stale Tailscale test nodes found.${NC}\n"
    return 0
  fi
  while IFS=$'\t' read -r node_id node_label; do
    [[ -z "$node_id" ]] && continue
    if curl -sf -X DELETE \
      -H "Authorization: Bearer ${TS_API_TOKEN}" \
      "https://api.tailscale.com/api/v2/device/${node_id}" > /dev/null 2>&1; then
      printf "${GREEN}Tailscale node %s (%s) removed.${NC}\n" "$node_id" "$node_label"
    else
      printf "${YELLOW}Failed to remove Tailscale node %s (%s).${NC}\n" "$node_id" "$node_label"
    fi
  done <<< "$node_ids"
}

cancel_auto_destroy() {
  if [[ -f "$AT_JOB_FILE" ]]; then
    local JOB_ID
    JOB_ID=$(cat "$AT_JOB_FILE")
    if [[ -n "$JOB_ID" ]] && atrm "$JOB_ID" 2>/dev/null; then
      printf "${GREEN}Cancelled scheduled auto-destroy (job %s).${NC}\n" "$JOB_ID"
    fi
    rm -f "$AT_JOB_FILE"
  fi
}

schedule_auto_destroy() {
  if ! command -v at &>/dev/null; then
    printf "${YELLOW}at command not installed — no auto-destroy timer. Remember to destroy manually.${NC}\n"
    printf "Install with: sudo apt install at\n"
    return
  fi
  local AT_OUTPUT
  AT_OUTPUT=$(at now + 2 hours 2>&1 <<DESTROY
"${SCRIPT_DIR}/hetzner-test.sh" --destroy --ts-api-token "${TS_API_TOKEN}" --ts-tailnet "${TS_TAILNET}" > /dev/null 2>&1
rm -f "${AT_JOB_FILE}"
DESTROY
  )
  local JOB_ID
  JOB_ID=$(echo "$AT_OUTPUT" | grep -oP 'job \K\d+')
  local JOB_TIME
  JOB_TIME=$(echo "$AT_OUTPUT" | grep -oP 'at \K.*')
  if [[ -n "$JOB_ID" ]]; then
    echo "$JOB_ID" > "$AT_JOB_FILE"
    printf "${YELLOW}Auto-destroy scheduled for %s (job %s). Cancel with: atrm %s${NC}\n" "$JOB_TIME" "$JOB_ID" "$JOB_ID"
  fi
}

# Check prerequisites
if ! command -v hcloud &>/dev/null; then
  printf "${RED}hcloud CLI not installed.${NC}\n"
  echo "Install: sudo apt install hcloud-cli"
  echo "Then: hcloud context create do-it-self-test"
  exit 1
fi

# Destroy mode
if [[ "$DESTROY_ONLY" == true ]]; then
  cancel_auto_destroy
  printf "${YELLOW}Destroying server %s...${NC}\n" "$SERVER_NAME"
  hcloud server delete "$SERVER_NAME" 2>/dev/null || echo "Server not found"
  cleanup_tailscale_nodes
  printf "${GREEN}Done.${NC}\n"
  exit 0
fi

# Get SSH key name (use the last/most-recent one, since names can contain spaces)
SSH_KEY=$(hcloud ssh-key list -o noheader -o columns=name | tail -1)
if [[ -z "$SSH_KEY" ]]; then
  printf "${RED}No SSH keys registered with Hetzner.${NC}\n"
  echo "Add one: hcloud ssh-key create --name mykey --public-key-from-file ~/.ssh/id_ed25519.pub"
  exit 1
fi
printf "${GREEN}Using SSH key: %s${NC}\n" "$SSH_KEY"

# Pre-flight: warn about local changes that won't be on the test server.
# The test VM pulls setup.sh from GitHub and clones the repo from there,
# so uncommitted or unpushed changes won't be tested.
if [[ "$RETEST" != true ]]; then
  WARNINGS=""

  UNCOMMITTED=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | head -5)
  if [[ -n "$UNCOMMITTED" ]]; then
    WARNINGS="${WARNINGS}\n  ${YELLOW}Uncommitted changes:${NC}\n"
    while IFS= read -r line; do
      WARNINGS="${WARNINGS}    ${line}\n"
    done <<< "$UNCOMMITTED"
    TOTAL=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | wc -l)
    if [[ $TOTAL -gt 5 ]]; then
      WARNINGS="${WARNINGS}    ... and $((TOTAL - 5)) more\n"
    fi
  fi

  UNPUSHED=$(git -C "$REPO_DIR" log '@{u}..HEAD' --oneline 2>/dev/null | head -5)
  if [[ -n "$UNPUSHED" ]]; then
    WARNINGS="${WARNINGS}\n  ${YELLOW}Unpushed commits:${NC}\n"
    while IFS= read -r line; do
      WARNINGS="${WARNINGS}    ${line}\n"
    done <<< "$UNPUSHED"
  fi

  if [[ -n "$WARNINGS" ]]; then
    printf "\n${YELLOW}WARNING: The test VM pulls from GitHub — these local changes won't be tested:${NC}\n"
    printf "$WARNINGS"
    printf "\n${YELLOW}Continuing in 10 seconds... (Ctrl+C to abort)${NC}\n\n"
    sleep 10
  fi
fi

# Create or reuse server
if [[ "$RETEST" == true ]]; then
  IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
  if [[ -z "$IP" ]]; then
    printf "${RED}Server %s not found. Run without --retest first.${NC}\n" "$SERVER_NAME"
    exit 1
  fi
  printf "${GREEN}Reusing existing server at %s${NC}\n" "$IP"
else
  # Clean up any existing test server (Hetzner VM + stale Tailscale nodes from prior runs)
  cancel_auto_destroy
  hcloud server delete "$SERVER_NAME" 2>/dev/null || true
  cleanup_tailscale_nodes

  printf "${YELLOW}Creating %s server (%s) in %s...${NC}\n" "$SERVER_TYPE" "$IMAGE" "$LOCATION"

  # Cloud-init: create an ubuntu user (Hetzner image only has root by default),
  # then run setup.sh via curl|bash as that user. This matches a realistic
  # install where the user is a regular user with sudo, not root.
  # Env vars passed through to setup.sh:
  #   TS_AUTHKEY='...' -- required by setup.sh, used to join Tailscale and
  #     to register the web-admin Tailscale sidecar so the dashboard is
  #     reachable at https://admin.<tailnet>.ts.net. setup.sh has the
  #     web-admin backend listen on a Unix domain socket inside
  #     web-admin/backend/sockets/, with the sidecar bind-mounting it.
  #     There is no host TCP listener at all by default, so there's no
  #     security concern about the test VM being publicly routable.
  CLOUD_INIT_FILE=$(mktemp)
  SETUP_ENV_LINE=""
  if [[ -n "$TS_KEY" ]]; then
    SETUP_ENV_LINE="TS_AUTHKEY='${TS_KEY}'"
  fi
  if [[ -n "$TS_API_TOKEN" ]]; then
    SETUP_ENV_LINE="${SETUP_ENV_LINE} TS_API_TOKEN='${TS_API_TOKEN}'"
  fi
  cat > "$CLOUD_INIT_FILE" << CLOUDINIT
#cloud-config
users:
  - name: ubuntu
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL

runcmd:
  - mkdir -p /home/ubuntu/.ssh
  - cp /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
  - chown -R ubuntu:ubuntu /home/ubuntu/.ssh
  - chmod 700 /home/ubuntu/.ssh
  - chmod 600 /home/ubuntu/.ssh/authorized_keys
  - su - ubuntu -c "curl -fsSL -o /home/ubuntu/setup.sh https://raw.githubusercontent.com/chrisl8/do-it-self/main/scripts/setup.sh && ${SETUP_ENV_LINE} bash /home/ubuntu/setup.sh" > /home/ubuntu/setup.log 2>&1
  - chown ubuntu:ubuntu /home/ubuntu/setup.log
  - touch /home/ubuntu/.setup-complete
  - chown ubuntu:ubuntu /home/ubuntu/.setup-complete
CLOUDINIT

  hcloud server create \
    --name "$SERVER_NAME" \
    --type "$SERVER_TYPE" \
    --image "$IMAGE" \
    --location "$LOCATION" \
    --ssh-key "$SSH_KEY" \
    --user-data-from-file "$CLOUD_INIT_FILE"

  rm -f "$CLOUD_INIT_FILE"

  IP=$(hcloud server ip "$SERVER_NAME")
  printf "${GREEN}Server created at %s${NC}\n" "$IP"

  # Remove any stale host key for this IP (Hetzner reuses IPs across test runs)
  ssh-keygen -f "${HOME}/.ssh/known_hosts" -R "$IP" 2>/dev/null || true

  # Wait for SSH to be ready
  printf "${YELLOW}Waiting for SSH...${NC}\n"
  for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${HOME}/.ssh/known_hosts" -o ConnectTimeout=5 "root@${IP}" true 2>/dev/null; then
      break
    fi
    if [[ $i -eq 60 ]]; then
      printf "${RED}SSH did not become ready.${NC}\n"
      exit 1
    fi
    sleep 5
  done
  printf "${GREEN}SSH ready${NC}\n"

  # Wait for cloud-init to finish and fail fast on errors.
  # `cloud-init status --wait` blocks until done and exits with the status code.
  printf "${YELLOW}Waiting for cloud-init to finish setup.sh (this may take 10-15 minutes)...${NC}\n"
  set +e
  ssh "root@${IP}" "cloud-init status --wait" 2>&1 | tail -3
  CLOUD_INIT_EXIT=${PIPESTATUS[0]}
  set -e

  if [[ $CLOUD_INIT_EXIT -ne 0 ]]; then
    printf "${RED}Cloud-init failed (exit code %d).${NC}\n" "$CLOUD_INIT_EXIT"
    echo ""
    printf "${RED}=== Last 30 lines of /home/ubuntu/setup.log ===${NC}\n"
    ssh "root@${IP}" "test -f /home/ubuntu/setup.log && tail -30 /home/ubuntu/setup.log || echo '(setup.log does not exist)'"
    echo ""
    printf "${RED}=== Last 30 lines of /var/log/cloud-init-output.log ===${NC}\n"
    ssh "root@${IP}" "tail -30 /var/log/cloud-init-output.log"
    echo ""

    # Fetch full logs to local disk for analysis
    mkdir -p "$LOG_DIR"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    LOG_BUNDLE="${LOG_DIR}/hetzner-test-${TIMESTAMP}-cloudinit-fail"
    mkdir -p "$LOG_BUNDLE"
    scp "root@${IP}:/home/ubuntu/setup.log" "${LOG_BUNDLE}/setup.log" 2>/dev/null || true
    ssh "root@${IP}" "cat /var/log/cloud-init-output.log" > "${LOG_BUNDLE}/cloud-init-output.log" 2>/dev/null || true
    ssh "root@${IP}" "cloud-init status --long" > "${LOG_BUNDLE}/cloud-init-status.txt" 2>/dev/null || true
    printf "${YELLOW}Full logs saved to %s${NC}\n" "$LOG_BUNDLE"

    if [[ "$KEEP_IF_FAILS" == true ]]; then
      echo ""
      echo "Server left running for debugging."
      echo "SSH:     ssh root@${IP}"
      echo "Destroy: scripts/hetzner-test.sh --destroy"
      schedule_auto_destroy
    else
      hcloud server delete "$SERVER_NAME"
    fi
    exit 1
  fi

  # Verify the setup-complete marker exists
  if ! ssh "root@${IP}" "test -f /home/ubuntu/.setup-complete" 2>/dev/null; then
    printf "${RED}Cloud-init succeeded but setup-complete marker is missing.${NC}\n"
    ssh "root@${IP}" "tail -20 /home/ubuntu/setup.log 2>&1 || echo '(no setup.log)'"
    exit 1
  fi
  printf "${GREEN}Setup completed.${NC}\n"
fi

IP=${IP:-$(hcloud server ip "$SERVER_NAME")}

# Run the test suite as the ubuntu user (since the SSH key was copied during cloud-init)
printf "${YELLOW}Running test suite...${NC}\n"

scp "${BASH_SOURCE[0]%/*}/test-fresh-install.sh" "ubuntu@${IP}:/home/ubuntu/test-fresh-install.sh"
set +e
# Use bash -l (login shell) so .profile is sourced and fnm/node are in PATH
ssh "ubuntu@${IP}" "chmod +x /home/ubuntu/test-fresh-install.sh && bash -l /home/ubuntu/test-fresh-install.sh"
TEST_EXIT=$?
set -e

if [[ $TEST_EXIT -eq 0 ]]; then
  printf "\n${GREEN}All tests passed!${NC}\n"
else
  printf "\n${RED}Some tests failed (exit code %d).${NC}\n" "$TEST_EXIT"
fi

# Always fetch logs from the server (success or failure)
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_BUNDLE="${LOG_DIR}/hetzner-test-${TIMESTAMP}"
mkdir -p "$LOG_BUNDLE"

printf "${YELLOW}Fetching logs to %s...${NC}\n" "$LOG_BUNDLE"
scp "ubuntu@${IP}:/home/ubuntu/setup.log" "${LOG_BUNDLE}/setup.log" 2>/dev/null || echo "  (no setup.log)"
ssh "root@${IP}" "tail -200 /var/log/cloud-init-output.log" > "${LOG_BUNDLE}/cloud-init-output.log" 2>/dev/null || true
ssh "root@${IP}" "cloud-init status --long" > "${LOG_BUNDLE}/cloud-init-status.txt" 2>/dev/null || true
ssh "ubuntu@${IP}" "docker ps -a 2>&1; echo '---'; docker images 2>&1" > "${LOG_BUNDLE}/docker-state.log" 2>/dev/null || true
ssh "ubuntu@${IP}" "ls -la ~/containers ~/credentials 2>&1" > "${LOG_BUNDLE}/file-state.log" 2>/dev/null || true
printf "${GREEN}Logs saved to %s${NC}\n" "$LOG_BUNDLE"

# Browse mode: open a SOCKS5 proxy so a remote browser can reach the test tailnet
if [[ "$BROWSE" == true ]]; then
  TS_DOMAIN_BROWSE=$(ssh "ubuntu@${IP}" "tailscale status --json 2>/dev/null" \
    | grep -oP '"MagicDNSSuffix":\s*"\K[^"]+' | head -1)

  if [[ -z "$TS_DOMAIN_BROWSE" ]]; then
    printf "${YELLOW}Could not detect tailnet domain — skipping browse mode.${NC}\n"
  else
    ssh -D 1080 -g -N -f "ubuntu@${IP}"
    SOCKS_PID=$!

    THIS_HOST=$(hostname)
    printf "\n${GREEN}══════════════════════════════════════════════════════════════${NC}\n"
    printf "${GREEN}  SOCKS5 proxy running on ${THIS_HOST}:1080${NC}\n"
    printf "${GREEN}══════════════════════════════════════════════════════════════${NC}\n"
    printf "\n  Configure your browser to use this proxy:\n\n"
    printf "  ${YELLOW}Firefox (recommended — per-browser, no system-wide changes):${NC}\n"
    printf "    Settings → Network Settings → Manual proxy configuration\n"
    printf "    SOCKS Host: ${THIS_HOST}    Port: 1080    SOCKS v5\n"
    printf "    ✓ Check \"Proxy DNS when using SOCKS v5\"\n\n"
    printf "  ${YELLOW}Chrome (uses system proxy, or launch with flag):${NC}\n"
    printf "    chrome.exe --proxy-server=\"socks5://${THIS_HOST}:1080\"\n"
    printf "\n  Available test sites:\n\n"
    printf "    https://admin.${TS_DOMAIN_BROWSE}\n"
    printf "    https://console.${TS_DOMAIN_BROWSE}\n"
    printf "    https://searxng.${TS_DOMAIN_BROWSE}\n"
    printf "    https://freshrss.${TS_DOMAIN_BROWSE}\n"
    printf "    https://thelounge.${TS_DOMAIN_BROWSE}\n"
    printf "    https://nextcloud.${TS_DOMAIN_BROWSE}\n"
    printf "    https://uptime.${TS_DOMAIN_BROWSE}\n"
    printf "    https://kanboard.${TS_DOMAIN_BROWSE}\n"
    printf "    https://paste.${TS_DOMAIN_BROWSE}\n"
    printf "\n${GREEN}══════════════════════════════════════════════════════════════${NC}\n"
    printf "  Remember to undo your browser proxy settings when done.\n"
    printf "${GREEN}══════════════════════════════════════════════════════════════${NC}\n\n"

    read -r -p "Press Enter when done browsing to continue with teardown..."
    kill "$SOCKS_PID" 2>/dev/null || true
    wait "$SOCKS_PID" 2>/dev/null || true
    printf "${GREEN}SOCKS proxy stopped.${NC}\n\n"
  fi
fi

# Tear down logic:
# - --keep:        always keep
# - --no-keep-if-fails: destroy even on failure
# - default:       destroy on success, keep on failure
SHOULD_DESTROY=true
if [[ "$KEEP" == true ]]; then
  SHOULD_DESTROY=false
elif [[ $TEST_EXIT -ne 0 && "$KEEP_IF_FAILS" == true ]]; then
  SHOULD_DESTROY=false
fi

if [[ "$SHOULD_DESTROY" == false ]]; then
  echo ""
  echo "Server left running at: ${IP}"
  echo "SSH:     ssh ubuntu@${IP}"
  echo "Setup:   ssh ubuntu@${IP} cat /home/ubuntu/setup.log"
  echo "Destroy: scripts/hetzner-test.sh --destroy"
  if [[ "$KEEP" != true ]]; then
    schedule_auto_destroy
  fi
else
  cancel_auto_destroy
  printf "${YELLOW}Destroying server...${NC}\n"
  hcloud server delete "$SERVER_NAME"
  printf "${GREEN}Server destroyed.${NC}\n"

  # Clean up the Tailscale node from the test tailnet
  cleanup_tailscale_nodes
fi

exit $TEST_EXIT
