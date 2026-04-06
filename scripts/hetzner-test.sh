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
SERVER_TYPE="cpx22"
IMAGE="ubuntu-24.04"
LOCATION="nbg1"
KEEP=false
DESTROY_ONLY=false
RETEST=false
TS_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=true ;;
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

  # Cloud-init: just run setup.sh via curl|bash as the ubuntu user
  CLOUD_INIT_FILE=$(mktemp)
  cat > "$CLOUD_INIT_FILE" << 'CLOUDINIT'
#cloud-config
runcmd:
  - |
    su - ubuntu -c 'curl -fsSL https://raw.githubusercontent.com/chrisl8/do-it-self/main/scripts/setup.sh | bash' > /home/ubuntu/setup.log 2>&1
    touch /home/ubuntu/.setup-complete
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

  # Wait for SSH to be ready
  printf "${YELLOW}Waiting for SSH...${NC}\n"
  for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@${IP}" true 2>/dev/null; then
      break
    fi
    if [[ $i -eq 60 ]]; then
      printf "${RED}SSH did not become ready.${NC}\n"
      exit 1
    fi
    sleep 5
  done
  printf "${GREEN}SSH ready${NC}\n"

  # Wait for cloud-init setup to complete
  printf "${YELLOW}Waiting for setup.sh to complete (this may take several minutes)...${NC}\n"
  for i in $(seq 1 120); do
    if ssh "root@${IP}" "test -f /home/ubuntu/.setup-complete" 2>/dev/null; then
      break
    fi
    if [[ $i -eq 120 ]]; then
      printf "${RED}Setup did not complete in time.${NC}\n"
      echo "Check logs: ssh root@${IP} cat /home/ubuntu/setup.log"
      exit 1
    fi
    sleep 10
  done
  printf "${GREEN}Setup completed.${NC}\n"
fi

IP=${IP:-$(hcloud server ip "$SERVER_NAME")}

# Run the test suite
printf "${YELLOW}Running test suite...${NC}\n"

# Copy the test script to the server and run it
scp "${BASH_SOURCE[0]%/*}/test-fresh-install.sh" "root@${IP}:/home/ubuntu/test-fresh-install.sh"
ssh "root@${IP}" "chmod +x /home/ubuntu/test-fresh-install.sh && su - ubuntu -c '/home/ubuntu/test-fresh-install.sh'"
TEST_EXIT=$?

if [[ $TEST_EXIT -eq 0 ]]; then
  printf "\n${GREEN}All tests passed!${NC}\n"
else
  printf "\n${RED}Some tests failed (exit code %d).${NC}\n" "$TEST_EXIT"
  echo "Debug: ssh root@${IP}"
  echo "Logs:  ssh root@${IP} cat /home/ubuntu/setup.log"
fi

# Tear down unless --keep
if [[ "$KEEP" == true ]]; then
  echo ""
  echo "Server left running at: ${IP}"
  echo "SSH: ssh root@${IP}"
  echo "Destroy when done: scripts/hetzner-test.sh --destroy"
else
  printf "${YELLOW}Destroying server...${NC}\n"
  hcloud server delete "$SERVER_NAME"
  printf "${GREEN}Server destroyed.${NC}\n"
fi

exit $TEST_EXIT
