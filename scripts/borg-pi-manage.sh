#!/bin/bash
# borg-pi-manage.sh — neuromancer-side orchestrator for the backup Pi.
#
# Runs as chrisl8 (not root — see CLAUDE.md / setup-backup-pi.sh threat model
# notes). Fetches per-client borg passphrases from Infisical at use-time and
# forwards them to the Pi over SSH via SendEnv BORG_PASSPHRASE. The Pi never
# stores the passphrases at rest.
#
# Subcommands:
#   prune         prune + compact every configured client repo
#   check         borg check every configured client repo (slow; weekly)
#   freshness     check newest-archive age per client; ping HC.io accordingly
#   restore-test  extract a known file from each client's latest archive,
#                 verify content, ping HC.io accordingly
#   break-lock    release a stale repo lock left by a killed borg process
#                 (e.g. the Pi was powered off mid-push). Manual recovery
#                 only — run when you know no backup is actually in flight.
#   all           prune + freshness (typical daily cron)
#
# Cron pattern (under chrisl8's user crontab, `crontab -e`):
#   0 4 * * *  ~/containers/scripts/borg-pi-manage.sh all
#   0 5 * * 0  ~/containers/scripts/borg-pi-manage.sh check
#   0 6 * * 0  ~/containers/scripts/borg-pi-manage.sh restore-test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bootstrap runtime config from committed template on first run.
if [ ! -f "${SCRIPT_DIR}/borg-pi-manage.conf" ] \
   && [ -f "${SCRIPT_DIR}/borg-pi-manage.conf.example" ]; then
    cp "${SCRIPT_DIR}/borg-pi-manage.conf.example" "${SCRIPT_DIR}/borg-pi-manage.conf"
    echo "[INFO] Bootstrapped borg-pi-manage.conf from .example — edit it before re-running."
    exit 0
fi

# shellcheck source=borg-pi-manage.conf.example
. "${SCRIPT_DIR}/borg-pi-manage.conf"

mkdir -p "$(dirname "${LOG_FILE}")"

# Lock — refuse to run concurrent invocations.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    echo "[ERROR] Another borg-pi-manage.sh is already running" >&2
    exit 1
fi

# All output (script + child) goes to the log file. When run interactively
# (stdout is a TTY) we ALSO tee to the terminal so the operator sees live
# progress. Under cron stdout isn't a TTY, so we redirect straight to the
# log — otherwise cron mails the operator a copy of every run, which is
# redundant noise once healthchecks.io handles failure notifications.
if [ -t 1 ]; then
    exec > >(tee -a "${LOG_FILE}") 2>&1
else
    exec >> "${LOG_FILE}" 2>&1
fi
echo ""
echo "=========================================="
echo "borg-pi-manage.sh $* — $(date)"
echo "=========================================="

# ── Infisical secret loader (mirrors borg-backup.sh's pattern) ───
load_secret() {
    local key="$1"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets get "${key}" \
            --token="${INFISICAL_TOKEN}" \
            --projectId="${INFISICAL_PROJECT_ID}" \
            --path="${INFISICAL_PATH}" \
            --env=prod \
            --domain="${INFISICAL_API_URL}" \
            --silent --plain 2>/dev/null && return 0
    fi
    return 1
}

SECRETS_AVAILABLE=false
if command -v infisical &>/dev/null \
   && [ -f "${HOME}/credentials/infisical.env" ] \
   && docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    export INFISICAL_TOKEN INFISICAL_API_URL INFISICAL_PROJECT_ID
    SECRETS_AVAILABLE=true
fi

if ! $SECRETS_AVAILABLE; then
    echo "[ERROR] Infisical is not available. Cannot fetch per-client passphrases." >&2
    echo "[ERROR] Make sure ~/credentials/infisical.env exists and the infisical" >&2
    echo "[ERROR] container is running. Aborting." >&2
    exit 1
fi

# ── HC.io pings (silent if URL is empty) ─────────────────────────
hc_success() {
    local url="${1:-}"
    [ -z "$url" ] && return 0
    curl -m 10 --retry 5 -fsS "$url" >/dev/null 2>&1 || true
}
hc_fail() {
    local url="${1:-}"
    local body="${2:-}"
    [ -z "$url" ] && return 0
    curl -m 10 --retry 5 -fsS --data-raw "$body" "${url}/fail" >/dev/null 2>&1 || true
}

# ── SSH wrapper (sends BORG_PASSPHRASE via env) ──────────────────
# Usage: pi_borg <passphrase> <verb> <client> [arg1 arg2]
# Prints stdout/stderr to terminal (captured by exec > tee above).
pi_borg() {
    local passphrase="$1"
    shift
    BORG_PASSPHRASE="$passphrase" ssh \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o StrictHostKeyChecking=accept-new \
        -o SendEnv=BORG_PASSPHRASE \
        -i "${PI_SSH_KEY}" \
        "${PI_USER}@${PI_HOST}" "$@"
}

# ── Per-client iteration ─────────────────────────────────────────
# Each entry: <name> <repo_path> <fresh_h> <hc_fresh> <hc_rt> <inf_key> <rt_path> <rt_expected>
parse_client() {
    # Sets globals: C_NAME C_REPO C_FRESH_H C_INF_KEY C_RT_PATH C_RT_EXPECTED
    # Pipe-separated so empty fields don't silently shift positions.
    IFS='|' read -r C_NAME C_REPO C_FRESH_H C_INF_KEY C_RT_PATH C_RT_EXPECTED <<<"$1"
    # Trim leading/trailing whitespace from each field for friendlier conf.
    local v
    for v in C_NAME C_REPO C_FRESH_H C_INF_KEY C_RT_PATH C_RT_EXPECTED; do
        local val="${!v}"
        val="${val#"${val%%[![:space:]]*}"}"   # ltrim
        val="${val%"${val##*[![:space:]]}"}"   # rtrim
        printf -v "$v" '%s' "$val"
    done
}

# Subcommand implementations operate on whatever globals parse_client sets.

cmd_prune_one() {
    local pass
    pass=$(load_secret "$C_INF_KEY") || {
        echo "[ERROR] $C_NAME: could not load $C_INF_KEY from Infisical"
        hc_fail "$HC_URL" "$C_NAME: Infisical fetch failed for $C_INF_KEY"
        return 1
    }
    echo ""
    echo "── prune+compact $C_NAME ──"
    if ! pi_borg "$pass" "prune $C_NAME"; then
        echo "[WARN] $C_NAME: prune returned non-zero"
        hc_fail "$HC_URL" "$C_NAME: borg prune failed"
        return 1
    fi
    if ! pi_borg "$pass" "compact $C_NAME"; then
        echo "[WARN] $C_NAME: compact returned non-zero"
        hc_fail "$HC_URL" "$C_NAME: borg compact failed"
        return 1
    fi
    return 0
}

cmd_check_one() {
    local pass
    pass=$(load_secret "$C_INF_KEY") || {
        echo "[ERROR] $C_NAME: could not load $C_INF_KEY from Infisical"
        hc_fail "$HC_URL" "$C_NAME: Infisical fetch failed for $C_INF_KEY"
        return 1
    }
    echo ""
    echo "── borg check $C_NAME ──"
    if pi_borg "$pass" "check $C_NAME"; then
        echo "[OK] $C_NAME: borg check passed"
    else
        echo "[ERROR] $C_NAME: borg check FAILED"
        hc_fail "$HC_URL" "$C_NAME: borg check failed"
        return 1
    fi
    return 0
}

cmd_freshness_one() {
    local pass
    pass=$(load_secret "$C_INF_KEY") || {
        echo "[ERROR] $C_NAME: could not load $C_INF_KEY from Infisical"
        hc_fail "$HC_URL" "$C_NAME: Infisical fetch failed for $C_INF_KEY"
        return 1
    }
    local last_line
    last_line=$(pi_borg "$pass" "list-last $C_NAME" 2>/dev/null | head -1) || {
        echo "[ERROR] $C_NAME: list-last failed"
        hc_fail "$HC_URL" "$C_NAME: borg list-last failed (passphrase? repo? SSH?)"
        return 1
    }
    if [ -z "$last_line" ]; then
        echo "[WARN] $C_NAME: no archives in repo"
        hc_fail "$HC_URL" "$C_NAME: no archives in remote repo"
        return 1
    fi
    local last_iso="${last_line%%|*}"
    local last_name="${last_line#*|}"
    local last_epoch
    last_epoch=$(date -d "$last_iso" +%s 2>/dev/null || echo 0)
    local now_epoch age_hours
    now_epoch=$(date +%s)
    age_hours=$(( (now_epoch - last_epoch) / 3600 ))
    echo "[INFO] $C_NAME: last archive '$last_name' is ${age_hours}h old (threshold ${C_FRESH_H}h)"
    if [ "$age_hours" -gt "$C_FRESH_H" ]; then
        hc_fail "$HC_URL" "$C_NAME: last archive ${age_hours}h old (threshold ${C_FRESH_H}h)"
        return 1
    fi
    # Per-client freshness success doesn't ping success — the daily run as a
    # whole pings success once at the end after all clients are fresh (see
    # run_for_all_clients_with_success). Otherwise a passing client could
    # immediately reset the deadman after a failing client just /fail'd.
    return 0
}

cmd_restore_test_one() {
    local pass
    pass=$(load_secret "$C_INF_KEY") || {
        echo "[ERROR] $C_NAME: could not load $C_INF_KEY from Infisical"
        hc_fail "$HC_URL" "$C_NAME: Infisical fetch failed for $C_INF_KEY"
        return 1
    }
    # Find the latest archive name
    local last_line last_name
    last_line=$(pi_borg "$pass" "list-last $C_NAME" 2>/dev/null | head -1) || {
        echo "[ERROR] $C_NAME: list-last failed for restore-test"
        hc_fail "$HC_URL" "$C_NAME: list-last failed during restore-test"
        return 1
    }
    if [ -z "$last_line" ]; then
        echo "[ERROR] $C_NAME: no archives to restore-test"
        hc_fail "$HC_URL" "$C_NAME: restore-test found no archives"
        return 1
    fi
    last_name="${last_line#*|}"

    echo ""
    echo "── restore-test $C_NAME :: $last_name :: $C_RT_PATH ──"
    local extracted
    extracted=$(pi_borg "$pass" "extract $C_NAME $last_name $C_RT_PATH" 2>/dev/null) || {
        echo "[ERROR] $C_NAME: extract failed"
        hc_fail "$HC_URL" "$C_NAME: extract $C_RT_PATH from $last_name failed"
        return 1
    }
    if [[ "$extracted" == *"$C_RT_EXPECTED"* ]]; then
        echo "[OK] $C_NAME: extracted content matched expected ('$C_RT_EXPECTED')"
        return 0
    fi
    echo "[ERROR] $C_NAME: extracted content did NOT contain expected '$C_RT_EXPECTED'"
    echo "        extracted (first 200 chars): ${extracted:0:200}"
    hc_fail "$HC_URL" "$C_NAME: restore-test content mismatch (expected: $C_RT_EXPECTED)"
    return 1
}

cmd_break_lock_one() {
    local pass
    pass=$(load_secret "$C_INF_KEY") || {
        echo "[ERROR] $C_NAME: could not load $C_INF_KEY from Infisical"
        hc_fail "$HC_URL" "$C_NAME: Infisical fetch failed for $C_INF_KEY"
        return 1
    }
    echo ""
    echo "── break-lock $C_NAME ──"
    if pi_borg "$pass" "break-lock $C_NAME"; then
        echo "[OK] $C_NAME: break-lock succeeded (stale lock released, if any)"
    else
        echo "[ERROR] $C_NAME: break-lock FAILED"
        hc_fail "$HC_URL" "$C_NAME: borg break-lock failed"
        return 1
    fi
    return 0
}

run_for_all_clients() {
    local fn="$1"
    local rc=0
    local entry
    for entry in "${CLIENTS_MGMT[@]}"; do
        parse_client "$entry"
        if ! "$fn"; then
            rc=1
        fi
    done
    return $rc
}

# Run a subcommand across all clients and ping HC.io success only if the
# whole run passed. Per-client functions ping /fail on failure; this caps
# the success ping so a single failing client suppresses the deadman reset.
run_command() {
    local fn="$1"
    local label="$2"
    if run_for_all_clients "$fn"; then
        hc_success "$HC_URL"
        echo "[OK] $label: all clients passed"
        return 0
    fi
    echo "[FAIL] $label: at least one client failed (see /fail pings above)"
    return 1
}

CMD="${1:-}"
case "$CMD" in
    prune)         run_command cmd_prune_one "prune" ;;
    check)         run_command cmd_check_one "check" ;;
    freshness)     run_command cmd_freshness_one "freshness" ;;
    restore-test)  run_command cmd_restore_test_one "restore-test" ;;
    break-lock)    run_command cmd_break_lock_one "break-lock" ;;
    all)
        # Daily cron path. Prune failures are noisy but acceptable as long
        # as freshness is OK; treat freshness as the authoritative deadman
        # for the "all" alias. Prune's own /fail still fires on failure.
        run_for_all_clients cmd_prune_one || true
        run_command cmd_freshness_one "freshness"
        ;;
    "")
        echo "Usage: $0 {prune|check|freshness|restore-test|break-lock|all}"
        exit 2
        ;;
    *)
        echo "[ERROR] unknown subcommand: $CMD"
        echo "Usage: $0 {prune|check|freshness|restore-test|break-lock|all}"
        exit 2
        ;;
esac

echo ""
echo "=========================================="
echo "borg-pi-manage.sh $* — finished $(date)"
echo "=========================================="
