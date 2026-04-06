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
#   scripts/hetzner-test.sh --type cx32        # Use a different server type
#   scripts/hetzner-test.sh --ts-key KEY       # Provide Tailscale auth key
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

SERVER_NAME="do-it-self-test"
SERVER_TYPE="cx23"
IMAGE="ubuntu-24.04"
LOCATION="nbg1"
KEEP=false
KEEP_IF_FAILS=true
DESTROY_ONLY=false
RETEST=false
TS_KEY=""
LOG_DIR="/tmp/hetzner-test-logs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=true ;;
    --no-keep-if-fails) KEEP_IF_FAILS=false ;;
    --destroy) DESTROY_ONLY=true ;;
    --retest) RETEST=true ;;
    --type) shift; SERVER_TYPE="$1" ;;
    --ts-key) shift; TS_KEY="$1" ;;
    --location) shift; LOCATION="$1" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Check prerequisites
if ! command -v hcloud &>/dev/null; then
  printf "${RED}hcloud CLI not installed.${NC}\n"
  echo "Install: sudo apt install hcloud-cli"
  echo "Then: hcloud context create do-it-self-test"
  exit 1
fi

# Destroy mode
if [[ "$DESTROY_ONLY" == true ]]; then
  printf "${YELLOW}Destroying server %s...${NC}\n" "$SERVER_NAME"
  hcloud server delete "$SERVER_NAME" 2>/dev/null || echo "Server not found"
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

# Create or reuse server
if [[ "$RETEST" == true ]]; then
  IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
  if [[ -z "$IP" ]]; then
    printf "${RED}Server %s not found. Run without --retest first.${NC}\n" "$SERVER_NAME"
    exit 1
  fi
  printf "${GREEN}Reusing existing server at %s${NC}\n" "$IP"
else
  # Clean up any existing test server
  hcloud server delete "$SERVER_NAME" 2>/dev/null || true

  printf "${YELLOW}Creating %s server (%s) in %s...${NC}\n" "$SERVER_TYPE" "$IMAGE" "$LOCATION"

  # Cloud-init: create an ubuntu user (Hetzner image only has root by default),
  # then run setup.sh via curl|bash as that user. This matches a realistic
  # install where the user is a regular user with sudo, not root.
  CLOUD_INIT_FILE=$(mktemp)
  cat > "$CLOUD_INIT_FILE" << 'CLOUDINIT'
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
  - su - ubuntu -c 'curl -fsSL https://raw.githubusercontent.com/chrisl8/do-it-self/main/scripts/setup.sh | bash' > /home/ubuntu/setup.log 2>&1
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
else
  printf "${YELLOW}Destroying server...${NC}\n"
  hcloud server delete "$SERVER_NAME"
  printf "${GREEN}Server destroyed.${NC}\n"
fi

exit $TEST_EXIT
