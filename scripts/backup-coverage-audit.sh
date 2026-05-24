#!/bin/bash
# backup-coverage-audit.sh — periodically scans the filesystem for things
# the borg backup might be missing, emits a JSON report consumed by the
# web admin's Backup Coverage page.
#
# Purpose: catch the silent drift class of bugs — new container directory
# added without being added to BORG_BACKUP_PATHS, user starts dumping
# files in /opt or /srv or a new /mnt drive without realising it isn't
# covered, exclude pattern still in place years after it stopped being
# the right call.
#
# Detection is intentionally shallow (one or two levels deep at each
# candidate root). Goes deep when a directory is "partially covered" —
# e.g. /mnt/22TB/container-mounts/ has some children in BACKUP_PATHS and
# some not — so we descend to enumerate the uncovered siblings.
#
# Output: a single JSON file at REPORT_FILE (defaults to
# ~/logs/backup-coverage-audit.json). Web admin reads it on demand and
# also writes acknowledgements to ACK_FILE.
#
# Runs as chrisl8 from cron. No sudo needed; if a candidate path is
# unreadable due to permissions, it's reported with status "unreadable"
# rather than failing the audit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bootstrap runtime conf from template on first run.
if [ ! -f "${SCRIPT_DIR}/backup-coverage-audit.conf" ] \
   && [ -f "${SCRIPT_DIR}/backup-coverage-audit.conf.example" ]; then
    cp "${SCRIPT_DIR}/backup-coverage-audit.conf.example" \
       "${SCRIPT_DIR}/backup-coverage-audit.conf"
    echo "[INFO] Bootstrapped backup-coverage-audit.conf from .example"
fi

# shellcheck source=backup-coverage-audit.conf.example
. "${SCRIPT_DIR}/backup-coverage-audit.conf"

# Source the borg config — neuromancer's bash-sourced borg-backup.conf, or
# wintermute's borgmatic-config-adapter.sh that translates YAML. The .conf
# above sets BORG_CONFIG_SOURCE; we default to neuromancer's behavior for
# backwards compatibility.
BORG_CONFIG_SOURCE="${BORG_CONFIG_SOURCE:-${SCRIPT_DIR}/borg-backup.conf}"
if [ ! -r "${BORG_CONFIG_SOURCE}" ]; then
    echo "[ERROR] BORG_CONFIG_SOURCE not readable: ${BORG_CONFIG_SOURCE}" >&2
    exit 1
fi
# shellcheck source=borg-backup.conf
. "${BORG_CONFIG_SOURCE}"
if [ -z "${BORG_BACKUP_PATHS+x}" ] || [ -z "${BORG_EXCLUDE_FILE+x}" ]; then
    echo "[ERROR] After sourcing ${BORG_CONFIG_SOURCE}, BORG_BACKUP_PATHS or BORG_EXCLUDE_FILE is unset" >&2
    exit 1
fi

mkdir -p "$(dirname "${REPORT_FILE}")"
touch "${ACK_FILE}" 2>/dev/null || true
[ -s "${ACK_FILE}" ] || echo "[]" > "${ACK_FILE}"

# ── Resolve BORG_BACKUP_PATHS to a normalised set ────────────────
# Strip trailing slashes, expand vars, canonicalise. Used to test
# coverage of candidate paths.
declare -a NORMALISED_BACKUP_PATHS=()
for p in "${BORG_BACKUP_PATHS[@]}"; do
    # Expand any ${HOME} or similar inline references (already expanded
    # by the source above if quoted, but be defensive).
    p="${p%/}"
    p=$(realpath -m "$p" 2>/dev/null || echo "$p")
    NORMALISED_BACKUP_PATHS+=("$p")
done

# is_covered <path> → returns 0 if path is at or under any backup path,
# 1 if not. Equality counts; subdir counts. Parent does NOT count
# (a backup path of /a/b/c does not cover /a/b).
is_covered() {
    local query
    query=$(realpath -m "$1" 2>/dev/null || echo "$1")
    local backup
    for backup in "${NORMALISED_BACKUP_PATHS[@]}"; do
        if [ "$query" = "$backup" ] || [[ "$query/" == "$backup/"* ]]; then
            return 0
        fi
    done
    return 1
}

# has_covered_descendant <path> → returns 0 if any backup path is at or
# under this path. Used to distinguish "uncovered" (no overlap) from
# "partial" (some children covered, some not).
has_covered_descendant() {
    local query
    query=$(realpath -m "$1" 2>/dev/null || echo "$1")
    local backup
    for backup in "${NORMALISED_BACKUP_PATHS[@]}"; do
        if [[ "$backup/" == "$query/"* ]]; then
            return 0
        fi
    done
    return 1
}

# Human-readable size for a path. Best-effort; on permission errors,
# returns "?". Caps work at ~5s per call to avoid runaway du on huge
# trees (we'll show "?" rather than block the whole audit).
human_size() {
    local p="$1"
    if [ ! -r "$p" ]; then echo "?"; return; fi
    timeout 5 du -sh --apparent-size "$p" 2>/dev/null | awk '{print $1}' || echo "?"
}

# mtime as ISO-8601 UTC
iso_mtime() {
    local p="$1"
    [ -e "$p" ] || { echo ""; return; }
    stat -c %Y "$p" 2>/dev/null | xargs -I {} date -u -d "@{}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo ""
}

# is_acked <path> → 0 if ack'd in ACK_FILE, 1 otherwise
is_acked() {
    local query="$1"
    jq -e --arg p "$query" 'any(.[]; .path == $p)' "${ACK_FILE}" >/dev/null 2>&1
}

# get_ack <path> → emits the matching ack object as JSON, or "null"
get_ack() {
    local query="$1"
    jq --arg p "$query" 'map(select(.path == $p)) | first // null' "${ACK_FILE}" 2>/dev/null
}

# ── Build the entries array ──────────────────────────────────────
# For each candidate root and its depth-1 entries, classify and emit.
# When status is "partial", descend depth-2 to enumerate.
ENTRIES_JSON="[]"
declare -A EMITTED_PATHS=()

emit_entry() {
    local path="$1"
    local status="$2"
    # Dedupe by absolute path — both the candidate-root walk and the
    # partial-descent can land on the same entry.
    if [ "${EMITTED_PATHS[$path]:-}" = "1" ]; then
        return
    fi
    EMITTED_PATHS[$path]="1"
    local size mtime ack
    size=$(human_size "$path")
    mtime=$(iso_mtime "$path")
    ack=$(get_ack "$path")
    ENTRIES_JSON=$(jq \
        --arg path "$path" \
        --arg status "$status" \
        --arg size "$size" \
        --arg mtime "$mtime" \
        --argjson ack "$ack" \
        '. + [{path: $path, status: $status, size_human: $size, mtime_iso: $mtime, ack: $ack}]' \
        <<<"$ENTRIES_JSON")
}

classify_path() {
    # Decides one of: covered / partial / uncovered, optionally overlaid
    # with acked / unreadable. Emits via emit_entry. Recurses one level
    # when partial.
    local path="$1"
    if [ ! -r "$path" ] 2>/dev/null && [ ! -d "$path" ]; then
        emit_entry "$path" "unreadable"
        return
    fi
    if is_covered "$path"; then
        emit_entry "$path" "covered"
        return
    fi
    if has_covered_descendant "$path"; then
        emit_entry "$path" "partial"
        # Descend one level. We only descend into "partial" entries so
        # the report stays bounded.
        if [ -r "$path" ] && [ -d "$path" ]; then
            local child
            while IFS= read -r -d '' child; do
                if is_covered "$child"; then
                    emit_entry "$child" "covered"
                elif has_covered_descendant "$child"; then
                    # Don't recurse further; mark partial and let the user
                    # explore from there if they really want.
                    emit_entry "$child" "partial"
                else
                    emit_entry "$child" "uncovered"
                fi
            done < <(find "$path" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
        fi
        return
    fi
    emit_entry "$path" "uncovered"
}

# Walk each candidate root at its configured depth.
for root_spec in "${CANDIDATE_ROOTS[@]}"; do
    IFS='|' read -r root depth <<<"$root_spec"
    root="${root#"${root%%[![:space:]]*}"}"; root="${root%"${root##*[![:space:]]}"}"
    depth="${depth#"${depth%%[![:space:]]*}"}"; depth="${depth%"${depth##*[![:space:]]}"}"
    depth="${depth:-1}"
    [ -d "$root" ] || continue

    if [ "$depth" = "0" ]; then
        classify_path "$root"
        continue
    fi

    while IFS= read -r -d '' entry; do
        classify_path "$entry"
    done < <(find "$root" -mindepth 1 -maxdepth "$depth" -print0 2>/dev/null)
done

# Special-case root: flag any top-level dir that isn't a standard FHS one.
# Catches /backup, /data, etc. — common ad-hoc dumping grounds.
STANDARD_ROOT_DIRS=(bin boot dev etc home lib lib32 lib64 libx32 media mnt opt proc root run sbin srv sys tmp usr var lost+found)
while IFS= read -r -d '' entry; do
    base=$(basename "$entry")
    skip=false
    for s in "${STANDARD_ROOT_DIRS[@]}"; do
        [ "$base" = "$s" ] && { skip=true; break; }
    done
    $skip && continue
    classify_path "$entry"
done < <(find / -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

# ── Exclude patterns + per-pattern match data ────────────────────
# Two pieces:
#   1. The raw pattern list — cheap, refreshed every run.
#   2. The per-pattern match counts/samples — ~4 min filesystem walk,
#      gated to refresh at most once per EXCLUDE_MATCHES_MAX_AGE_HOURS.
#
# If the cache is fresh, we merge its match data onto the pattern list.
# If it's stale or missing, we regenerate in foreground (cron run still
# completes in <5 min). If regeneration fails, we emit patterns with no
# match data so the rest of the audit still works.
EXCLUDE_PATTERNS_JSON="[]"
if [ -n "${BORG_EXCLUDE_FILE:-}" ] && [ -r "${BORG_EXCLUDE_FILE}" ]; then
    # Decide if the cache needs refreshing.
    refresh_cache=true
    if [ -f "${EXCLUDE_MATCHES_FILE:-}" ]; then
        max_age_sec=$(( ${EXCLUDE_MATCHES_MAX_AGE_HOURS:-23} * 3600 ))
        file_age=$(( $(date +%s) - $(stat -c %Y "${EXCLUDE_MATCHES_FILE}") ))
        if [ "$file_age" -lt "$max_age_sec" ]; then
            refresh_cache=false
        fi
        # Also refresh if the exclude file itself is newer than the cache,
        # so edits surface within the hour even if the daily window hasn't
        # elapsed yet.
        if [ "${BORG_EXCLUDE_FILE}" -nt "${EXCLUDE_MATCHES_FILE}" ]; then
            refresh_cache=true
        fi
    fi

    if [ "$refresh_cache" = "true" ]; then
        echo "[INFO] Refreshing exclude-match cache (full walk; expect ~5-15 min)..."
        # Join backup paths with `:` for the helper. Empty/missing paths
        # are filtered by the helper itself.
        paths_arg=$(IFS=:; echo "${NORMALISED_BACKUP_PATHS[*]}")
        tmp_matches=$(mktemp)
        # Hard ceiling of 20 min so a pathological filesystem state can't
        # wedge the audit indefinitely. Real walks are well under this.
        if timeout 1200 python3 "${SCRIPT_DIR}/check-exclude-matches.py" \
                "$paths_arg" "${BORG_EXCLUDE_FILE}" > "$tmp_matches"; then
            mv "$tmp_matches" "${EXCLUDE_MATCHES_FILE}"
            chmod 644 "${EXCLUDE_MATCHES_FILE}"
            echo "[OK] Exclude-match cache refreshed at ${EXCLUDE_MATCHES_FILE}"
        else
            rm -f "$tmp_matches"
            echo "[WARN] check-exclude-matches.py failed/timed out; keeping prior cache (if any)"
        fi
    fi

    if [ -r "${EXCLUDE_MATCHES_FILE:-}" ]; then
        # Helper produces objects with match_count/samples/status; use directly.
        EXCLUDE_PATTERNS_JSON=$(jq '.exclude_patterns' "${EXCLUDE_MATCHES_FILE}")
    else
        # Fallback: bare pattern list (no per-pattern match info yet).
        EXCLUDE_PATTERNS_JSON=$(awk 'NF && !/^[[:space:]]*#/ {print}' "${BORG_EXCLUDE_FILE}" \
            | jq -R -s 'split("\n") | map(select(length > 0)) | map({pattern: ., match_count: null, samples: [], status: "unknown"})')
    fi
fi

# ── Stitch it all into the report ────────────────────────────────
NEEDS_REVIEW_COUNT=$(jq '[.[] | select(.status == "uncovered" or .status == "partial" or .status == "unreadable") | select(.ack == null)] | length' <<<"$ENTRIES_JSON")
ACKED_COUNT=$(jq '[.[] | select(.ack != null)] | length' <<<"$ENTRIES_JSON")
COVERED_COUNT=$(jq '[.[] | select(.status == "covered")] | length' <<<"$ENTRIES_JSON")

EXCLUDE_MATCHES_AUDITED_AT=""
if [ -r "${EXCLUDE_MATCHES_FILE:-}" ]; then
    EXCLUDE_MATCHES_AUDITED_AT=$(date -u -d "@$(stat -c %Y "${EXCLUDE_MATCHES_FILE}")" +%Y-%m-%dT%H:%M:%SZ)
fi

TMP=$(mktemp)
jq -n \
    --arg host "$(hostname)" \
    --arg audited_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg exclude_matches_audited_at "$EXCLUDE_MATCHES_AUDITED_AT" \
    --argjson entries "$ENTRIES_JSON" \
    --argjson exclude_patterns "$EXCLUDE_PATTERNS_JSON" \
    --argjson needs_review_count "$NEEDS_REVIEW_COUNT" \
    --argjson acked_count "$ACKED_COUNT" \
    --argjson covered_count "$COVERED_COUNT" \
    '{
        host: $host,
        audited_at: $audited_at,
        exclude_matches_audited_at: (if $exclude_matches_audited_at == "" then null else $exclude_matches_audited_at end),
        summary: {
            needs_review: $needs_review_count,
            acknowledged: $acked_count,
            covered: $covered_count
        },
        entries: $entries,
        exclude_patterns: $exclude_patterns
    }' > "$TMP"

mkdir -p "$(dirname "${REPORT_FILE}")"
mv "$TMP" "${REPORT_FILE}"
chmod 644 "${REPORT_FILE}"

echo "[OK] Report written to ${REPORT_FILE}"
echo "    needs_review=${NEEDS_REVIEW_COUNT}  acknowledged=${ACKED_COUNT}  covered=${COVERED_COUNT}"

# Optional: push the report to a central web-admin host (e.g. wintermute
# pushes to neuromancer). Set COVERAGE_REPORT_PUSH_DEST in the .conf to
# enable; format is rsync's standard `user@host:/path/to/file.json`.
# COVERAGE_REPORT_PUSH_KEY (optional) is the private key for the ssh
# connection. Failures here are non-fatal — the local report is still
# valid; only the central dashboard misses an update.
if [ -n "${COVERAGE_REPORT_PUSH_DEST:-}" ]; then
    rsync_ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
    if [ -n "${COVERAGE_REPORT_PUSH_KEY:-}" ]; then
        rsync_ssh_cmd="${rsync_ssh_cmd} -i ${COVERAGE_REPORT_PUSH_KEY}"
    fi
    echo "[INFO] Pushing report to ${COVERAGE_REPORT_PUSH_DEST}"
    if rsync -az -e "${rsync_ssh_cmd}" \
            "${REPORT_FILE}" "${COVERAGE_REPORT_PUSH_DEST}"; then
        echo "[OK] Report pushed"
    else
        echo "[WARN] Report push failed (rc=$?) — central dashboard may be stale"
    fi
fi
