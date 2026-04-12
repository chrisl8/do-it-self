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

# Verify auto-detected shared variables made it into Infisical. After the
# shared-vars-consolidation, HOST_NAME and DOCKER_GID live in Infisical at
# /shared (not in user-config.yaml's `shared:` block, which no longer
# exists). setup.sh's step 11b seeds them on first run.
if [[ -f "${HOME}/credentials/infisical.env" ]] \
   && docker ps --filter "name=infisical" --filter "status=running" -q 2>/dev/null | grep -q .; then
  source "${HOME}/credentials/infisical.env"
  HOST_IN_INFISICAL=$(infisical secrets get HOST_NAME \
    --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" \
    --path=/shared --env=prod --domain="${INFISICAL_API_URL}" \
    --silent --plain 2>/dev/null) || true
  if [[ -n "$HOST_IN_INFISICAL" ]]; then
    pass "HOST_NAME seeded into Infisical: ${HOST_IN_INFISICAL}"
  else
    fail "HOST_NAME not seeded into Infisical /shared"
  fi

  GID_IN_INFISICAL=$(infisical secrets get DOCKER_GID \
    --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" \
    --path=/shared --env=prod --domain="${INFISICAL_API_URL}" \
    --silent --plain 2>/dev/null) || true
  if [[ -n "$GID_IN_INFISICAL" ]]; then
    pass "DOCKER_GID seeded into Infisical: ${GID_IN_INFISICAL}"
  else
    fail "DOCKER_GID not seeded into Infisical /shared"
  fi
fi

# ── Phase 3: Web-admin ──────────────────────────────────────────────────

section "Web Admin"

check "web-admin frontend built" test -f "${CONTAINERS_DIR}/web-admin/backend/public/index.html"

# Web admin listens on a Unix socket only (no host TCP). Test it via
# --unix-socket from the host, since we run on the same machine.
WEB_ADMIN_SOCKET="${CONTAINERS_DIR}/web-admin/backend/sockets/web-admin.sock"
if [[ -S "$WEB_ADMIN_SOCKET" ]]; then
  pass "web-admin Unix socket exists"
else
  fail "web-admin Unix socket missing at $WEB_ADMIN_SOCKET"
fi

if curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/config/infisical-status > /dev/null 2>&1; then
  pass "web-admin responding on Unix socket"
else
  fail "web-admin not responding on Unix socket"
fi

# ── Phase 4: Infisical ──────────────────────────────────────────────────

section "Infisical Secret Manager"

# Plain `docker ps -q` returns exit 0 even with no matches — pipe
# through grep to fail when output is empty (no matching container).
if docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
  pass "infisical container running"
else
  fail "infisical container running"
fi
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

if curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/registry > /dev/null 2>&1; then
  pass "GET /api/registry responds"
else
  fail "GET /api/registry failed"
fi

if curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/config/validate > /dev/null 2>&1; then
  pass "GET /api/config/validate responds"
else
  fail "GET /api/config/validate failed"
fi

# ── Phase 6a: Module system ───────────────────────────────────────────

section "Module System"

check "installed-modules.yaml exists" test -f "${CONTAINERS_DIR}/installed-modules.yaml"
check ".modules directory exists" test -d "${CONTAINERS_DIR}/.modules"

# Verify at least one module source is cloned with a valid git repo
if ls -d "${CONTAINERS_DIR}/.modules"/*/.git >/dev/null 2>&1; then
  pass "module source(s) cloned with .git"
else
  fail "no module sources found in .modules/"
fi

# Module API endpoints
if curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/modules/catalog > /dev/null 2>&1; then
  pass "GET /api/modules/catalog responds"
else
  fail "GET /api/modules/catalog failed"
fi

if curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/modules/installed > /dev/null 2>&1; then
  pass "GET /api/modules/installed responds"
else
  fail "GET /api/modules/installed failed"
fi

# Verify installed modules tracks containers
INSTALLED_COUNT=$(curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/modules/installed 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d).modules||{};let n=0;for(const k in m)n+=(m[k].installed_containers||[]).length;console.log(n)})" 2>/dev/null) || true
if [[ -n "$INSTALLED_COUNT" && "$INSTALLED_COUNT" -gt 0 ]]; then
  pass "installed-modules.yaml tracks ${INSTALLED_COUNT} containers"
else
  fail "installed-modules.yaml has no tracked containers"
fi

# Verify registry contains module-system fields (source, cron_jobs, required_accounts)
REGISTRY_JSON=$(curl -sf --unix-socket "$WEB_ADMIN_SOCKET" http://localhost/api/registry 2>/dev/null) || true
if [[ -n "$REGISTRY_JSON" ]]; then
  # Every container should have a source field
  HAS_SOURCE=$(echo "$REGISTRY_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const c=JSON.parse(d).containers||{};const all=Object.values(c).every(v=>v.source);console.log(all?'yes':'no')})" 2>/dev/null) || true
  if [[ "$HAS_SOURCE" == "yes" ]]; then
    pass "all registry containers have source field"
  else
    fail "some registry containers missing source field"
  fi

  # Nextcloud should have cron_jobs
  HAS_CRON=$(echo "$REGISTRY_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const c=JSON.parse(d).containers?.nextcloud;console.log(c?.cron_jobs?.length>0?'yes':'no')})" 2>/dev/null) || true
  if [[ "$HAS_CRON" == "yes" ]]; then
    pass "nextcloud has cron_jobs in registry"
  else
    fail "nextcloud missing cron_jobs in registry"
  fi
fi

# ── Phase 6b: Web-admin reachability through the tailnet ───────────────
# The architectural regression guard. setup.sh runs the same checks at the
# end of an install; we run them here too because test-fresh-install.sh
# may be invoked independently (e.g. on an existing host) and we want it
# to catch the kind of break we hit in commit 9e4715c (sidecar can't reach
# the backend) without having to re-run setup.sh.

section "Web Admin Tailnet Path"

if docker ps --filter "name=^web-admin-ts$" --filter "status=running" -q 2>/dev/null | grep -q .; then
  pass "web-admin-ts sidecar running"
else
  fail "web-admin-ts sidecar not running"
fi

if docker exec web-admin-ts test -S /sockets/web-admin.sock 2>/dev/null; then
  pass "sidecar sees /sockets/web-admin.sock via bind mount"
else
  fail "sidecar bind mount missing or wrong (compose.yaml volumes block)"
fi

if docker exec web-admin-ts tailscale serve status --json 2>/dev/null \
   | grep -q 'unix:/sockets/web-admin.sock'; then
  pass "TS Serve proxy targets unix:/sockets/web-admin.sock"
else
  fail "TS Serve proxy not pointing at unix socket (tailscale-config.json)"
fi

# Tailnet HTTPS round-trip. Detect TS_DOMAIN from tailscale itself so we
# don't have to rely on env vars.
if command -v tailscale > /dev/null 2>&1; then
  TS_DOMAIN_DETECTED=$(tailscale status --json 2>/dev/null \
    | grep -oP '"MagicDNSSuffix":\s*"\K[^"]+' | head -1)
  if [[ -n "$TS_DOMAIN_DETECTED" ]]; then
    ADMIN_URL="https://admin.${TS_DOMAIN_DETECTED}/api/config/infisical-status"
    REACHED=false
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
      if curl -sf -m 5 -o /dev/null "$ADMIN_URL" 2>/dev/null; then
        REACHED=true
        break
      fi
      sleep 5
    done
    if [[ "$REACHED" = true ]]; then
      pass "https://admin.${TS_DOMAIN_DETECTED} reachable end-to-end"
    else
      fail "https://admin.${TS_DOMAIN_DETECTED} did not respond after 60s"
    fi
  else
    fail "could not detect tailnet domain (is the host on Tailscale?)"
  fi
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

  TEST_CONTAINERS="homepage searxng freshrss the-lounge uptime kanboard paste nextcloud"

  # Enable each container via the web admin API (over the Unix socket).
  # For nextcloud, pass the two user-facing variables (admin username and
  # password). The three internal secrets (MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD,
  # ELASTIC_PASSWORD) are auto_generate: true in the registry — the web admin
  # generates them automatically when enabled=true, which is the real user flow.
  for c in $TEST_CONTAINERS; do
    if [[ "$c" == "nextcloud" ]]; then
      ENABLE_BODY='{"enabled": true, "variables": {"NEXTCLOUD_ADMIN_USER": "testadmin", "NEXTCLOUD_ADMIN_PASSWORD": "TestPass123!"}}'
    else
      ENABLE_BODY='{"enabled": true}'
    fi
    ENABLE_RESP=$(curl -sf --unix-socket "$WEB_ADMIN_SOCKET" -X PUT "http://localhost/api/config/container/$c" \
      -H 'Content-Type: application/json' \
      -d "$ENABLE_BODY" 2>/dev/null) || true
    if [[ -n "$ENABLE_RESP" ]] && echo "$ENABLE_RESP" | grep -q '"success":true'; then
      pass "enabled $c via API"
    else
      fail "could not enable $c via API"
    fi
  done

  # Verify nextcloud's auto_generate secrets were created by the enable call
  INFISICAL_CMD="infisical secrets get --token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
  NC_AUTO_OK=true
  for secret in MYSQL_ROOT_PASSWORD MYSQL_PASSWORD ELASTIC_PASSWORD; do
    if ! $INFISICAL_CMD "$secret" --path="/nextcloud" --silent --plain > /dev/null 2>&1; then
      NC_AUTO_OK=false
      break
    fi
  done
  if [[ "$NC_AUTO_OK" == true ]]; then
    pass "nextcloud auto_generate secrets created by enable"
  else
    fail "nextcloud auto_generate secrets missing after enable"
  fi

  # Start them all. Nextcloud (MariaDB + Elasticsearch + app + TS sidecar)
  # adds significant startup time.
  printf "${YELLOW}  Starting containers (this may take several minutes)...${NC}\n"
  cd "${CONTAINERS_DIR}"
  if scripts/all-containers.sh --start --no-wait --no-health-check > /tmp/start.log 2>&1; then
    pass "all-containers.sh --start completed"
  else
    fail "all-containers.sh --start failed (see /tmp/start.log)"
  fi

  # Wait for all containers to reach healthy/running state. Nextcloud's
  # Elasticsearch and MariaDB have 120s start_period health checks, so
  # the full stack can take 3-5 minutes on first boot.
  printf "${YELLOW}  Waiting up to 8 minutes for all containers to become healthy...${NC}\n"
  HEALTHY_DEADLINE=$((SECONDS + 480))
  ALL_HEALTHY=false
  while [[ $SECONDS -lt $HEALTHY_DEADLINE ]]; do
    UNHEALTHY=$(docker ps -a --format '{{.Status}}' 2>/dev/null | grep -cv "(healthy)" || true)
    if [[ "$UNHEALTHY" -eq 0 ]]; then
      ALL_HEALTHY=true
      break
    fi
    sleep 10
  done

  if [[ "$ALL_HEALTHY" == true ]]; then
    pass "all containers healthy within deadline"
  else
    printf "${RED}  Some containers still unhealthy after 8 minutes:${NC}\n"
    docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | grep -v "(healthy)" || true
  fi

  TAG_CONTAINER_HINT=false
  for c in $TEST_CONTAINERS; do
    TOTAL=$(docker ps -a --filter "label=com.docker.compose.project=$c" -q 2>/dev/null | wc -l)
    RUNNING=$(docker ps --filter "label=com.docker.compose.project=$c" --filter "status=running" -q 2>/dev/null | wc -l)
    if [[ $TOTAL -gt 0 && $TOTAL -eq $RUNNING ]]; then
      pass "$c fully running ($RUNNING/$TOTAL)"
    else
      fail "$c not fully running ($RUNNING/$TOTAL)"
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

  # ── Phase 8: Module side effects ─────────────────────────────────────

  section "Module Side Effects (cron_jobs)"

  # Verify nextcloud's cron job was installed by all-containers.sh
  if crontab -l 2>/dev/null | grep -q "do-it-self:nextcloud:nextcloud-cron-job.sh"; then
    pass "nextcloud cron job tagged entry in crontab"
  else
    fail "nextcloud cron job not found in crontab"
  fi

  if crontab -l 2>/dev/null | grep -q "${CONTAINERS_DIR}/nextcloud/nextcloud-cron-job.sh"; then
    pass "nextcloud cron points to container directory"
  else
    fail "nextcloud cron path incorrect"
  fi

  # Verify the cron script exists and is executable
  check "nextcloud-cron-job.sh exists" test -f "${CONTAINERS_DIR}/nextcloud/nextcloud-cron-job.sh"
  check "nextcloud-cron-job.sh executable" test -x "${CONTAINERS_DIR}/nextcloud/nextcloud-cron-job.sh"

  # Verify manage-cron-jobs.js list works
  if node "${CONTAINERS_DIR}/scripts/manage-cron-jobs.js" list 2>/dev/null | grep -q "nextcloud"; then
    pass "manage-cron-jobs.js list shows nextcloud"
  else
    fail "manage-cron-jobs.js list missing nextcloud"
  fi

  # ── Phase 9: Tailnet HTTP smoke tests ────────────────────────────────

  section "Tailnet HTTP Smoke Tests"

  if command -v tailscale > /dev/null 2>&1; then
    TS_DOMAIN_SMOKE=$(tailscale status --json 2>/dev/null \
      | grep -oP '"MagicDNSSuffix":\s*"\K[^"]+' | head -1)

    if [[ -n "$TS_DOMAIN_SMOKE" ]]; then
      # Map container directory names to their Tailscale hostnames.
      # Most match, but some differ (homepage→console, the-lounge→thelounge).
      ts_hostname() {
        case "$1" in
          homepage) echo "console" ;;
          the-lounge) echo "thelounge" ;;
          *) echo "$1" ;;
        esac
      }

      # HTTPS smoke tests on a subset of containers. Each Tailscale sidecar
      # registers its own ACME account with Let's Encrypt, and LE enforces a
      # limit of 10 new registrations per IP per 3 hours. With 9+ sidecars
      # starting from the same VM, we'd exceed this limit if we tested all
      # of them. Test a representative subset: the first few containers
      # (which get certs before the rate limit hits) plus web-admin (already
      # verified in Phase 6b). Containers not in SMOKE_CONTAINERS are still
      # validated as fully-running above — they just skip the HTTPS check.
      SMOKE_CONTAINERS="homepage searxng freshrss nextcloud"

      # Batch approach: loop over all smoke containers repeatedly with a
      # shared 3-minute deadline. Containers that pass are removed from the
      # pending list so we don't waste time re-checking them.
      declare -A SMOKE_PENDING
      declare -A SMOKE_URLS
      for c in $SMOKE_CONTAINERS; do
        TS_NAME_FOR_URL=$(ts_hostname "$c")
        SMOKE_URLS[$c]="https://${TS_NAME_FOR_URL}.${TS_DOMAIN_SMOKE}"
        SMOKE_PENDING[$c]=1
      done

      SMOKE_DEADLINE=$((SECONDS + 180))
      while [[ ${#SMOKE_PENDING[@]} -gt 0 && $SECONDS -lt $SMOKE_DEADLINE ]]; do
        for c in "${!SMOKE_PENDING[@]}"; do
          HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -m 3 "${SMOKE_URLS[$c]}" 2>/dev/null) || true
          if [[ -n "$HTTP_CODE" && "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 500 ]]; then
            pass "${c} reachable at ${SMOKE_URLS[$c]} (HTTP ${HTTP_CODE})"
            unset "SMOKE_PENDING[$c]"
          fi
        done
        [[ ${#SMOKE_PENDING[@]} -gt 0 ]] && sleep 10
      done

      for c in "${!SMOKE_PENDING[@]}"; do
        fail "${c} not reachable at ${SMOKE_URLS[$c]}"
      done
    else
      fail "could not detect tailnet domain for HTTP smoke tests"
    fi
  else
    printf "${YELLOW}  Skipping HTTP smoke tests: tailscale not installed.${NC}\n"
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
