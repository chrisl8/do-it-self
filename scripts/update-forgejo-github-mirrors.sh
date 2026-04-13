#!/bin/bash
# Update GitHub push mirror tokens in Forgejo
# Lists all repos with GitHub push mirrors, then deletes and recreates each
# mirror with a fresh token. Non-GitHub mirrors are left untouched.
# Flags: --dry-run  list mirrors only, make no changes
#        --yes      skip confirmation prompt
set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

DRY_RUN=false
AUTO_YES=false
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true ;;
        --yes|-y) AUTO_YES=true ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

# ── Infisical bootstrap ────────────────────────────────────────

load_secret() {
    local container="$1"
    local key="$2"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets get "${key}" --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/${container}" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null && return 0
    fi
    return 1
}

save_secret() {
    local container="$1"
    local key="$2"
    local value="$3"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets set "${key}=${value}" \
            --token="${INFISICAL_TOKEN}" \
            --projectId="${INFISICAL_PROJECT_ID}" \
            --path="/${container}" \
            --env=prod \
            --domain="${INFISICAL_API_URL}" 2>/dev/null | tail -1
        return 0
    fi
    return 1
}

SECRETS_AVAILABLE=false
if command -v infisical &>/dev/null && \
   [ -f "${HOME}/credentials/infisical.env" ] && \
   docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    export INFISICAL_TOKEN INFISICAL_API_URL
    SECRETS_AVAILABLE=true
fi

# ── Load secrets ───────────────────────────────────────────────

if [ -z "${FORGEJO_API_TOKEN}" ] && [ "${SECRETS_AVAILABLE}" = "true" ]; then
    FORGEJO_API_TOKEN=$(load_secret "forgejo" "FORGEJO_API_TOKEN") || true
fi
if [ -z "${GITHUB_MIRROR_TOKEN}" ] && [ "${SECRETS_AVAILABLE}" = "true" ]; then
    GITHUB_MIRROR_TOKEN=$(load_secret "forgejo" "GITHUB_MIRROR_TOKEN") || true
fi
if [ -z "${TS_DOMAIN}" ] && [ "${SECRETS_AVAILABLE}" = "true" ]; then
    TS_DOMAIN=$(load_secret "shared" "TS_DOMAIN") || true
fi

# Interactive fallback for missing secrets
if [ -z "${FORGEJO_API_TOKEN}" ]; then
    if [ -t 0 ]; then
        printf "${YELLOW}[NOTE]${NC} FORGEJO_API_TOKEN not found in Infisical or environment\n"
        read -r -p "  Enter Forgejo API token: " FORGEJO_API_TOKEN
        if [ -z "${FORGEJO_API_TOKEN}" ]; then
            echo "ERROR: Forgejo API token is required"
            exit 1
        fi
        if [ "${SECRETS_AVAILABLE}" = "true" ]; then
            read -r -p "  Save to Infisical? [y/N] " save_it
            if [[ "${save_it}" =~ ^[Yy] ]]; then
                save_secret "forgejo" "FORGEJO_API_TOKEN" "${FORGEJO_API_TOKEN}"
                printf "${GREEN}[DONE]${NC} Saved FORGEJO_API_TOKEN to Infisical /forgejo\n"
            fi
        fi
    else
        echo "ERROR: FORGEJO_API_TOKEN not set. Pass it as an env var or add it to Infisical /forgejo"
        exit 1
    fi
fi

if [ -z "${GITHUB_MIRROR_TOKEN}" ]; then
    if [ -t 0 ]; then
        printf "${YELLOW}[NOTE]${NC} GITHUB_MIRROR_TOKEN not found in Infisical or environment\n"
        read -r -s -p "  Enter new GitHub token: " GITHUB_MIRROR_TOKEN
        echo
        if [ -z "${GITHUB_MIRROR_TOKEN}" ]; then
            echo "ERROR: GitHub mirror token is required"
            exit 1
        fi
        if [ "${SECRETS_AVAILABLE}" = "true" ]; then
            read -r -p "  Save to Infisical? [y/N] " save_it
            if [[ "${save_it}" =~ ^[Yy] ]]; then
                save_secret "forgejo" "GITHUB_MIRROR_TOKEN" "${GITHUB_MIRROR_TOKEN}"
                printf "${GREEN}[DONE]${NC} Saved GITHUB_MIRROR_TOKEN to Infisical /forgejo\n"
            fi
        fi
    else
        echo "ERROR: GITHUB_MIRROR_TOKEN not set. Pass it as an env var or add it to Infisical /forgejo"
        exit 1
    fi
fi

# ── Build Forgejo URL ──────────────────────────────────────────

if [ -z "${FORGEJO_URL}" ]; then
    if [ -n "${TS_DOMAIN}" ]; then
        FORGEJO_URL="https://forgejo.${TS_DOMAIN}"
    else
        echo "ERROR: Cannot determine Forgejo URL. Set TS_DOMAIN or FORGEJO_URL env var."
        exit 1
    fi
fi

# ── API helper ─────────────────────────────────────────────────

forgejo_api() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local curl_args=(
        --retry 2
        -s
        -H "Authorization: token ${FORGEJO_API_TOKEN}"
        -H "Content-Type: application/json"
    )
    if [ "${method}" != "GET" ]; then
        curl_args+=(-X "${method}")
    fi
    if [ -n "${data}" ]; then
        curl_args+=(-d "${data}")
    fi
    local http_code body
    body=$(curl "${curl_args[@]}" -w '\n%{http_code}' "${FORGEJO_URL}/api/v1${endpoint}")
    http_code=$(echo "${body}" | tail -1)
    body=$(echo "${body}" | sed '$d')
    if [[ "${http_code}" -lt 200 || "${http_code}" -ge 300 ]]; then
        printf "${RED}[ERR]${NC} API %s %s returned HTTP %s\n" "${method}" "${endpoint}" "${http_code}" >&2
        echo "${body}" >&2
        return 1
    fi
    echo "${body}"
}

# ── Validate connectivity ──────────────────────────────────────

printf "Connecting to %s ... " "${FORGEJO_URL}"
if ! forgejo_api GET "/settings/api" >/dev/null 2>&1; then
    echo "FAILED"
    echo "ERROR: Cannot reach Forgejo API. Check FORGEJO_URL and FORGEJO_API_TOKEN."
    exit 1
fi
printf "${GREEN}OK${NC}\n"

# ── List all repos ─────────────────────────────────────────────

printf "Fetching repositories ... "
ALL_REPOS="[]"
page=1
while true; do
    page_results=$(forgejo_api GET "/repos/search?limit=50&page=${page}")
    count=$(echo "${page_results}" | jq '.data | length')
    if [ "${count}" -eq 0 ]; then
        break
    fi
    ALL_REPOS=$(echo "${ALL_REPOS}" "${page_results}" | jq -s '.[0] + (.[1].data)')
    if [ "${count}" -lt 50 ]; then
        break
    fi
    page=$((page + 1))
done
repo_count=$(echo "${ALL_REPOS}" | jq 'length')
printf "${GREEN}%d repos${NC}\n" "${repo_count}"

# ── Scan for GitHub push mirrors ───────────────────────────────

printf "Scanning for GitHub push mirrors ...\n"
MIRRORS="[]"
for i in $(seq 0 $((repo_count - 1))); do
    owner=$(echo "${ALL_REPOS}" | jq -r ".[$i].owner.login")
    repo=$(echo "${ALL_REPOS}" | jq -r ".[$i].name")
    mirrors_json=$(forgejo_api GET "/repos/${owner}/${repo}/push_mirrors" 2>/dev/null) || continue
    github_mirrors=$(echo "${mirrors_json}" | jq '[.[] | select(.remote_address | test("github\\.com"))]')
    gh_count=$(echo "${github_mirrors}" | jq 'length')
    if [ "${gh_count}" -gt 0 ]; then
        entry=$(jq -n --arg owner "${owner}" --arg repo "${repo}" --argjson mirrors "${github_mirrors}" \
            '{owner: $owner, repo: $repo, mirrors: $mirrors}')
        MIRRORS=$(echo "${MIRRORS}" | jq --argjson entry "${entry}" '. + [$entry]')
    fi
done

mirror_total=$(echo "${MIRRORS}" | jq '[.[].mirrors | length] | add // 0')

if [ "${mirror_total}" -eq 0 ]; then
    printf "${GREEN}No GitHub push mirrors found.${NC}\n"
    exit 0
fi

# ── Print summary ──────────────────────────────────────────────

printf "\n${YELLOW}Found %d GitHub push mirror(s):${NC}\n\n" "${mirror_total}"
printf "  %-35s %-50s %s\n" "REPO" "REMOTE ADDRESS" "INTERVAL"
printf "  %-35s %-50s %s\n" "----" "--------------" "--------"

echo "${MIRRORS}" | jq -c '.[]' | while IFS= read -r entry; do
    owner=$(echo "${entry}" | jq -r '.owner')
    repo=$(echo "${entry}" | jq -r '.repo')
    echo "${entry}" | jq -c '.mirrors[]' | while IFS= read -r mirror; do
        addr=$(echo "${mirror}" | jq -r '.remote_address')
        interval=$(echo "${mirror}" | jq -r '.interval // "8h0m0s"')
        printf "  %-35s %-50s %s\n" "${owner}/${repo}" "${addr}" "${interval}"
    done
done

echo

if [ "${DRY_RUN}" = "true" ]; then
    printf "${YELLOW}[DRY RUN]${NC} No changes made.\n"
    exit 0
fi

# ── Confirm ────────────────────────────────────────────────────

if [ "${AUTO_YES}" != "true" ]; then
    read -r -p "Delete and recreate these mirrors with the new GitHub token? [y/N] " confirm
    if [[ ! "${confirm}" =~ ^[Yy] ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# ── Update mirrors ─────────────────────────────────────────────

success=0
failures=0

# Flatten to one JSON object per mirror for simple iteration (avoids nested subshell pipes)
FLAT_MIRRORS=$(echo "${MIRRORS}" | jq -c '[.[] | {owner, repo} + (.mirrors[] | {remote_name, remote_address, interval, sync_on_commit})] | .[]')

while IFS= read -r mirror; do
    owner=$(echo "${mirror}" | jq -r '.owner')
    repo=$(echo "${mirror}" | jq -r '.repo')
    remote_name=$(echo "${mirror}" | jq -r '.remote_name')
    remote_address=$(echo "${mirror}" | jq -r '.remote_address')
    interval=$(echo "${mirror}" | jq -r '.interval // "8h0m0s"')
    sync_on_commit=$(echo "${mirror}" | jq '.sync_on_commit // true')
    github_username=$(echo "${remote_address}" | sed -n 's|https://github\.com/\([^/]*\)/.*|\1|p')
    if [ -z "${github_username}" ]; then
        github_username="git"
    fi

    printf "  Updating %s/%s -> %s ... " "${owner}" "${repo}" "${remote_address}"

    if ! forgejo_api DELETE "/repos/${owner}/${repo}/push_mirrors/${remote_name}" >/dev/null 2>&1; then
        printf "${RED}FAILED${NC} (delete)\n"
        printf "    Mirror details for manual recovery: remote_name=%s address=%s interval=%s\n" \
            "${remote_name}" "${remote_address}" "${interval}" >&2
        failures=$((failures + 1))
        continue
    fi

    body=$(jq -n \
        --arg addr "${remote_address}" \
        --arg user "${github_username}" \
        --arg pass "${GITHUB_MIRROR_TOKEN}" \
        --arg interval "${interval}" \
        --argjson sync "${sync_on_commit}" \
        '{remote_address: $addr, remote_username: $user, remote_password: $pass, interval: $interval, sync_on_commit: $sync}')

    if ! forgejo_api POST "/repos/${owner}/${repo}/push_mirrors" "${body}" >/dev/null 2>&1; then
        printf "${RED}FAILED${NC} (create)\n"
        printf "    ${RED}WARNING: Mirror was deleted but could not be recreated!${NC}\n" >&2
        printf "    Recreate manually: address=%s username=%s interval=%s sync_on_commit=%s\n" \
            "${remote_address}" "${github_username}" "${interval}" "${sync_on_commit}" >&2
        failures=$((failures + 1))
        continue
    fi

    printf "${GREEN}OK${NC}\n"
    success=$((success + 1))
done <<< "${FLAT_MIRRORS}"

# ── Results ────────────────────────────────────────────────────

echo
printf "${GREEN}Updated: %d${NC}" "${success}"
if [ "${failures}" -gt 0 ]; then
    printf "  ${RED}Failed: %d${NC}" "${failures}"
fi
echo

if [ "${failures}" -gt 0 ]; then
    exit 1
fi
