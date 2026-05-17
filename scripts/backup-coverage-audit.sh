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

# Pull BORG_BACKUP_PATHS + BORG_EXCLUDE_FILE from the borg-backup conf so we
# stay in sync with what borg-backup.sh actually does.
# shellcheck source=borg-backup.conf
. "${SCRIPT_DIR}/borg-backup.conf"

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

# ── Read exclude patterns for the UI to display ──────────────────
EXCLUDE_PATTERNS_JSON="[]"
if [ -n "${BORG_EXCLUDE_FILE:-}" ] && [ -r "${BORG_EXCLUDE_FILE}" ]; then
    EXCLUDE_PATTERNS_JSON=$(awk 'NF && !/^[[:space:]]*#/ {print}' "${BORG_EXCLUDE_FILE}" \
        | jq -R -s 'split("\n") | map(select(length > 0))')
fi

# ── Stitch it all into the report ────────────────────────────────
NEEDS_REVIEW_COUNT=$(jq '[.[] | select(.status == "uncovered" or .status == "partial" or .status == "unreadable") | select(.ack == null)] | length' <<<"$ENTRIES_JSON")
ACKED_COUNT=$(jq '[.[] | select(.ack != null)] | length' <<<"$ENTRIES_JSON")
COVERED_COUNT=$(jq '[.[] | select(.status == "covered")] | length' <<<"$ENTRIES_JSON")

TMP=$(mktemp)
jq -n \
    --arg host "$(hostname)" \
    --arg audited_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson entries "$ENTRIES_JSON" \
    --argjson exclude_patterns "$EXCLUDE_PATTERNS_JSON" \
    --argjson needs_review_count "$NEEDS_REVIEW_COUNT" \
    --argjson acked_count "$ACKED_COUNT" \
    --argjson covered_count "$COVERED_COUNT" \
    '{
        host: $host,
        audited_at: $audited_at,
        summary: {
            needs_review: $needs_review_count,
            acknowledged: $acked_count,
            covered: $covered_count
        },
        entries: $entries,
        exclude_patterns: $exclude_patterns
    }' > "$TMP"

mv "$TMP" "${REPORT_FILE}"
chmod 644 "${REPORT_FILE}"

echo "[OK] Report written to ${REPORT_FILE}"
echo "    needs_review=${NEEDS_REVIEW_COUNT}  acknowledged=${ACKED_COUNT}  covered=${COVERED_COUNT}"
