#!/bin/bash
# Routine database maintenance for every database container, run from cron
# OUTSIDE the borg backup window (it waits for borg to finish).
#
#   Postgres  VACUUM (ANALYZE) on tables with real dead-tuple bloat
#   MariaDB   ANALYZE TABLE on everything + fragmentation report
#   Mongo     size report only (WiredTiger needs no routine maintenance)
#   Valkey/Redis  memory/fragmentation report only
#   SQLite    nothing here: borg-db-dump.sh VACUUMs its own dump copies
#
# This used to be a bare `VACUUM;` inside borg-db-dump.sh; on 2026-10-31 it
# stalled 5.5h+ (WalSync I/O) and blocked the nightly backup. Vacuuming does
# not change what borg stores (only pg_dump output is backed up, db_data is
# excluded), so it lives here instead.
#
# There is deliberately NO timeout: a timeout that fires every night means
# the vacuum never finishes. Slow runs are made visible instead: per-table
# duration, a WARNING over SLOW_SECONDS, and a vacuum-progress/wait-event
# sample every 10 minutes while one runs.
#
# Log: ~/logs/db-maintenance.log   Usage: db-maintenance.sh [--no-wait]
set -uo pipefail

LOG="${HOME}/logs/db-maintenance.log"
LOCK="/tmp/db-maintenance.lock"
SLOW_SECONDS=1800
DEAD_MIN=10000   # vacuum a table only if it has at least this many dead tuples
# container:user:database  (same set borg-db-dump.sh dumps)
PG_TARGETS=(
    "dawarich_db:postgres:dawarich_production"
    "immich_postgres:postgres:immich"
    "paperless-db:paperless:paperless"
    "infisical-db:infisical:infisical"
    "zipline-db:zipline:zipline"
)
MARIADB_CONTAINERS=("mariadb:mariadb:MARIADB_ROOT_PASSWORD" "nextcloud-db:nextcloud:MYSQL_ROOT_PASSWORD" "paste-db:paste:PASTE_DB_ROOT_PASSWORD")

log() { echo "$(date -Is) $*" >> "${LOG}"; }
running() { docker ps --filter "name=^$1\$" --filter "status=running" -q | grep -q .; }

exec 9>"${LOCK}"
flock -n 9 || { log "another db-maintenance is still running, skipping"; exit 0; }

if [ "${1:-}" != "--no-wait" ]; then
    for _ in $(seq 1 120); do
        pgrep -x borg > /dev/null || pgrep -f borg-backup.sh > /dev/null || break
        sleep 60
    done
fi

log "===== db-maintenance START ====="
overall=0

# ── Postgres ────────────────────────────────────────────────────────
pg_maintain() {
    local c="$1" user="$2" db="$3"
    running "${c}" || { log "[${c}] not running, skipped"; return 0; }
    local psql=(docker exec "${c}" psql -U "${user}" -d "${db}" -X -At)
    local tables
    tables=$("${psql[@]}" -F'|' -c "select schemaname||'.'||quote_ident(relname), n_dead_tup, n_live_tup from pg_stat_user_tables where n_dead_tup >= ${DEAD_MIN} order by n_dead_tup desc" 2>&1) || { log "[${c}] ERROR listing tables: ${tables}"; overall=1; return 0; }
    if [ -z "${tables}" ]; then log "[${c}] no table over ${DEAD_MIN} dead tuples, nothing to do"; return 0; fi
    local t dead live start rc elapsed sampler
    while IFS='|' read -r t dead live; do
        [ -n "${t}" ] || continue
        log "[${c}] VACUUM ${t} (dead=${dead} live=${live})"
        (
            while sleep 600; do
                log "[${c}]   progress: $("${psql[@]}" -F' ' -c "select p.phase, p.heap_blks_scanned||'/'||p.heap_blks_total, 'vacuumed='||p.heap_blks_vacuumed, coalesce(a.wait_event_type||':'||a.wait_event,'-') from pg_stat_progress_vacuum p join pg_stat_activity a using (pid) limit 1" 2>&1 | tr '\n' ' ')"
            done
        ) &
        sampler=$!
        start=$(date +%s); rc=0
        "${psql[@]}" -c "VACUUM (ANALYZE) ${t}" > /dev/null 2>> "${LOG}" || rc=$?
        kill "${sampler}" 2>/dev/null; wait "${sampler}" 2>/dev/null
        elapsed=$(( $(date +%s) - start ))
        log "[${c}]   done ${t} rc=${rc} elapsed=${elapsed}s dead_now=$("${psql[@]}" -c "select n_dead_tup from pg_stat_user_tables where schemaname||'.'||quote_ident(relname)='${t}'" 2>/dev/null)"
        [ "${rc}" -eq 0 ] || overall=1
        [ "${elapsed}" -le "${SLOW_SECONDS}" ] || log "[${c}]   WARNING: ${t} vacuum took ${elapsed}s (> ${SLOW_SECONDS}s) — check progress lines above"
    done <<< "${tables}"
}
for t in "${PG_TARGETS[@]}"; do IFS=: read -r c u d <<< "${t}"; pg_maintain "${c}" "${u}" "${d}"; done

# ── Dawarich track-generation churn trend (watching for a never-ending rebuild) ──
# Added 2026-10-31: 1.19 track generation was rewriting points.track_id at
# ~100 updates/s. Healthy = untracked shrinks and upd_total growth flattens to
# roughly new-points-per-day; stuck = untracked flat/growing while upd_total
# keeps climbing millions per day.
if running dawarich_db; then
    log "[dawarich_db] TRACKCHURN $(docker exec dawarich_db psql -U postgres -d dawarich_production -X -At -F' ' -c "select 'upd_total='||n_tup_upd, 'dead='||n_dead_tup, 'tracks='||(select count(*) from tracks), 'tracks_created_24h='||(select count(*) from tracks where created_at > now()-interval '24 hours'), 'untracked='||(select count(*) from points where track_id is null) from pg_stat_user_tables where relname='points'" 2>&1)"
fi

# ── MariaDB ─────────────────────────────────────────────────────────
SECRETS_AVAILABLE=false
if command -v infisical &>/dev/null && [ -f "${HOME}/credentials/infisical.env" ] && running infisical; then
    # shellcheck disable=SC1091
    source "${HOME}/credentials/infisical.env"
    export INFISICAL_TOKEN INFISICAL_API_URL
    SECRETS_AVAILABLE=true
fi
for t in "${MARIADB_CONTAINERS[@]}"; do
    IFS=: read -r c folder key <<< "${t}"
    running "${c}" || { log "[${c}] not running, skipped"; continue; }
    pw=""
    [ "${SECRETS_AVAILABLE}" = "true" ] && pw=$(infisical secrets get "${key}" --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/${folder}" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null)
    [ -n "${pw}" ] || { log "[${c}] no root password available, skipped"; overall=1; continue; }
    start=$(date +%s)
    if out=$(docker exec -e MYSQL_PWD="${pw}" "${c}" mariadb-check -u root --analyze --all-databases 2>&1); then
        log "[${c}] ANALYZE ok elapsed=$(( $(date +%s) - start ))s ($(grep -c . <<< "${out}") tables)"
    else
        log "[${c}] ANALYZE FAILED: $(tail -3 <<< "${out}" | tr '\n' ' ')"; overall=1
    fi
    log "[${c}] most fragmented (data_free): $(docker exec -e MYSQL_PWD="${pw}" "${c}" mariadb -u root -N -e "select concat(table_schema,'.',table_name,'=',round(data_free/1048576),'MB') from information_schema.tables where data_free>0 order by data_free desc limit 3" 2>/dev/null | tr '\n' ' ')"
done

# ── Mongo (report only) ─────────────────────────────────────────────
if running your_spotify-mongo; then
    log "[your_spotify-mongo] $(docker exec your_spotify-mongo mongosh --quiet --eval 'JSON.stringify(db.getSiblingDB("your_spotify").stats(1048576))' 2>&1 | head -c 300)"
fi

# ── Valkey / Redis (report only) ────────────────────────────────────
for t in dawarich_redis:valkey-cli immich_redis:valkey-cli searxng-redis:redis-cli infisical-redis:redis-cli; do
    IFS=: read -r c cli <<< "${t}"
    running "${c}" || continue
    log "[${c}] $(docker exec "${c}" "${cli}" INFO memory 2>&1 | tr -d '\r' | grep -E '^(used_memory_human|used_memory_rss_human|mem_fragmentation_ratio|maxmemory_human):' | tr '\n' ' ') keys=$(docker exec "${c}" "${cli}" DBSIZE 2>&1)"
done

log "===== db-maintenance END overall_rc=${overall} ====="
exit "${overall}"
