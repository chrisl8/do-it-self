#!/bin/bash
# Validation test suite for a fresh installation.
# Run this on a server after setup.sh has completed.
set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
START_TIME=$(date +%s)

pass() {
  printf "${GREEN}  PASS: %s${NC}\n" "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf "${RED}  FAIL: %s${NC}\n" "$1"
  FAIL=$((FAIL + 1))
}

check() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

section() {
  printf "\n${YELLOW}── %s ──${NC}\n" "$1"
}

CONTAINERS_DIR="${HOME}/containers"

# ── Phase 1: Prerequisites installed ─────────────────────────────────────

section "Prerequisites"

check "git installed" command -v git
check "docker installed" command -v docker
check "docker daemon running" docker info
check "node installed" command -v node
check "npm installed" command -v npm
check "pm2 installed" command -v pm2
check "infisical installed" command -v infisical
check "tailscale installed" command -v tailscale

# ── Phase 2: Repository and config ──────────────────────────────────────

section "Repository and Configuration"

check "repo cloned to ~/containers" test -d "${CONTAINERS_DIR}/scripts"
check "container-registry.yaml exists" test -f "${CONTAINERS_DIR}/container-registry.yaml"
check "user-config.yaml created" test -f "${CONTAINERS_DIR}/user-config.yaml"

# Verify auto-detected values
if [[ -f "${CONTAINERS_DIR}/user-config.yaml" ]]; then
  HOST_IN_CONFIG=$(grep "HOST_NAME:" "${CONTAINERS_DIR}/user-config.yaml" | head -1 | sed 's/.*HOST_NAME: *//' | tr -d '"')
  if [[ -n "$HOST_IN_CONFIG" && "$HOST_IN_CONFIG" != '""' ]]; then
    pass "HOST_NAME auto-detected: ${HOST_IN_CONFIG}"
  else
    fail "HOST_NAME not auto-detected in user-config.yaml"
  fi

  GID_IN_CONFIG=$(grep "DOCKER_GID:" "${CONTAINERS_DIR}/user-config.yaml" | head -1 | sed 's/.*DOCKER_GID: *//' | tr -d '"')
  if [[ -n "$GID_IN_CONFIG" && "$GID_IN_CONFIG" != '""' ]]; then
    pass "DOCKER_GID auto-detected: ${GID_IN_CONFIG}"
  else
    fail "DOCKER_GID not auto-detected in user-config.yaml"
  fi
fi

# ── Phase 3: Web-admin ──────────────────────────────────────────────────

section "Web Admin"

check "web-admin frontend built" test -f "${CONTAINERS_DIR}/web-admin/backend/public/index.html"

if curl -sf http://localhost:3333 > /dev/null 2>&1; then
  pass "web-admin responding on port 3333"
else
  fail "web-admin not responding on port 3333"
fi

# ── Phase 4: Infisical ──────────────────────────────────────────────────

section "Infisical Secret Manager"

check "infisical container running" docker ps --filter "name=infisical" --filter "status=running" -q
check "credentials file created" test -f "${HOME}/credentials/infisical.env"

if curl -sf http://localhost:8085/api/status > /dev/null 2>&1; then
  pass "Infisical API responding on port 8085"
else
  fail "Infisical API not responding on port 8085"
fi

# Verify we can read/write secrets
if [[ -f "${HOME}/credentials/infisical.env" ]]; then
  source "${HOME}/credentials/infisical.env"
  if infisical secrets set "TEST_KEY=test_value" \
    --token="${INFISICAL_TOKEN}" \
    --projectId="${INFISICAL_PROJECT_ID}" \
    --path="/shared" \
    --env=prod \
    --domain="${INFISICAL_API_URL}" > /dev/null 2>&1; then
    pass "can write secrets to Infisical"
    # Clean up
    infisical secrets delete "TEST_KEY" \
      --token="${INFISICAL_TOKEN}" \
      --projectId="${INFISICAL_PROJECT_ID}" \
      --path="/shared" \
      --env=prod \
      --domain="${INFISICAL_API_URL}" > /dev/null 2>&1 || true
  else
    fail "cannot write secrets to Infisical"
  fi
fi

# ── Phase 5: Env generation ─────────────────────────────────────────────

section "Environment Generation"

cd "${CONTAINERS_DIR}"

# Generate .env for a simple container.
# Note: searxng requires TS_AUTHKEY which is empty on a fresh install,
# so generate-env.js will exit non-zero with "missing required variables".
# That's expected behavior -- it still WRITES the .env file (just with
# missing vars omitted). We check that the file was written, not the
# exit code.
node scripts/generate-env.js searxng --quiet 2>/dev/null || true
if [[ -f "${CONTAINERS_DIR}/searxng/.env" ]]; then
  pass "generate-env.js wrote .env file"
else
  fail "generate-env.js did not write .env file"
fi

# Verify docker compose config parses
cd "${CONTAINERS_DIR}/searxng"
if docker compose config > /dev/null 2>&1; then
  pass "docker compose config parses for searxng"
else
  fail "docker compose config fails for searxng"
fi

# Test a multi-volume container
cd "${CONTAINERS_DIR}"
node scripts/generate-env.js nextcloud --quiet 2>/dev/null || true
cd "${CONTAINERS_DIR}/nextcloud"
if docker compose config > /dev/null 2>&1; then
  pass "docker compose config parses for nextcloud"
else
  fail "docker compose config fails for nextcloud"
fi

# ── Phase 6: Web-admin API ──────────────────────────────────────────────

section "Web Admin API"

if curl -sf http://localhost:3333/api/registry > /dev/null 2>&1; then
  pass "GET /api/registry responds"
else
  fail "GET /api/registry failed"
fi

if curl -sf http://localhost:3333/api/config/validate > /dev/null 2>&1; then
  pass "GET /api/config/validate responds"
else
  fail "GET /api/config/validate failed"
fi

# ── Phase 7: Container startup (only if Tailscale was set up) ───────────

# Check if TS_AUTHKEY is in Infisical -- if so, we have Tailscale and can
# actually start containers that need it.
TS_READY=false
if [[ -f "${HOME}/credentials/infisical.env" ]]; then
  source "${HOME}/credentials/infisical.env"
  TS_KEY_VALUE=$(infisical secrets get TS_AUTHKEY \
    --token="${INFISICAL_TOKEN}" \
    --projectId="${INFISICAL_PROJECT_ID}" \
    --path="/shared" \
    --env=prod \
    --domain="${INFISICAL_API_URL}" \
    --silent --plain 2>/dev/null)
  if [[ -n "$TS_KEY_VALUE" ]]; then
    TS_READY=true
  fi
fi

if [[ "$TS_READY" == true ]]; then
  section "Container Startup (with Tailscale)"

  TEST_CONTAINERS="homepage searxng freshrss the-lounge uptime kanboard paste"

  # Enable each container via the web admin API
  for c in $TEST_CONTAINERS; do
    if curl -sf -X PUT "http://localhost:3333/api/config/container/$c" \
      -H 'Content-Type: application/json' \
      -d '{"enabled": true}' > /dev/null 2>&1; then
      pass "enabled $c via API"
    else
      fail "could not enable $c via API"
    fi
  done

  # Start them all
  printf "${YELLOW}  Starting containers (this may take several minutes)...${NC}\n"
  cd "${CONTAINERS_DIR}"
  if scripts/all-containers.sh --start --no-wait --no-health-check > /tmp/start.log 2>&1; then
    pass "all-containers.sh --start completed"
  else
    fail "all-containers.sh --start failed (see /tmp/start.log)"
  fi

  # Verify EVERY container in each compose project is in 'running' state.
  # The previous lenient check passed if any container in the project was
  # running, which masked failures where (e.g.) only the redis sidecar was
  # up while the app and tailscale sidecar crashlooped.
  sleep 5
  TAG_CONTAINER_HINT=false
  for c in $TEST_CONTAINERS; do
    TOTAL=$(docker ps -a --filter "label=com.docker.compose.project=$c" -q 2>/dev/null | wc -l)
    RUNNING=$(docker ps --filter "label=com.docker.compose.project=$c" --filter "status=running" -q 2>/dev/null | wc -l)
    if [[ $TOTAL -gt 0 && $TOTAL -eq $RUNNING ]]; then
      pass "$c fully running ($RUNNING/$TOTAL)"
    else
      fail "$c not fully running ($RUNNING/$TOTAL)"
      # If the failing project has a *-ts sidecar that's failing the
      # tag:container ACL check, surface a hint at the bottom of the run.
      TS_NAME=$(docker ps -a --filter "label=com.docker.compose.project=$c" --format '{{.Names}}' 2>/dev/null | grep -- '-ts$' | head -1)
      if [[ -n "$TS_NAME" ]] && docker logs "$TS_NAME" 2>&1 | tail -20 | grep -q 'tag:container'; then
        TAG_CONTAINER_HINT=true
      fi
    fi
  done

  if [[ "$TAG_CONTAINER_HINT" == true ]]; then
    printf "\n${RED}┌──────────────────────────────────────────────────────────────────────┐${NC}\n"
    printf "${RED}│ Tailscale sidecar(s) rejected by control plane:                       │${NC}\n"
    printf "${RED}│   'requested tags [tag:container] are invalid or not permitted'      │${NC}\n"
    printf "${RED}│                                                                        │${NC}\n"
    printf "${RED}│ Your TS_AUTHKEY needs to be created with the 'tag:container' ACL tag. │${NC}\n"
    printf "${RED}│ In the Tailscale admin console (Settings → Keys → Generate auth key), │${NC}\n"
    printf "${RED}│ check 'tag:container' under tags before generating. tag:container     │${NC}\n"
    printf "${RED}│ must also be defined in your tailnet ACL policy.                       │${NC}\n"
    printf "${RED}└──────────────────────────────────────────────────────────────────────┘${NC}\n"
  fi
else
  section "Container Startup (skipped -- no Tailscale)"
  printf "${YELLOW}  Skipping container startup test: TS_AUTHKEY not configured.${NC}\n"
  printf "${YELLOW}  Pass --ts-key to hetzner-test.sh to enable this phase.${NC}\n"
fi

# ── Report ───────────────────────────────────────────────────────────────

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "============================================"
if [[ $FAIL -eq 0 ]]; then
  printf "${GREEN}ALL TESTS PASSED${NC}\n"
else
  printf "${RED}%d FAILED${NC}, %d passed\n" "$FAIL" "$PASS"
fi
echo "Total: $((PASS + FAIL)) tests in ${ELAPSED}s"
echo "============================================"

[[ $FAIL -eq 0 ]]
