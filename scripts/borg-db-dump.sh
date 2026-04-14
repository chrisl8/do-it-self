#!/bin/bash
# Dump all databases from running Docker containers before borg backup
# Each dump overwrites the previous one — only the latest is kept
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load configuration
# shellcheck source=borg-backup.conf
. "${SCRIPT_DIR}/borg-backup.conf"

# Load credentials from Infisical
# SECRETS_AVAILABLE is exported by borg-backup.sh; set it up if running standalone
if [ -z "${SECRETS_AVAILABLE}" ]; then
    SECRETS_AVAILABLE=false
    if command -v infisical &>/dev/null && \
       [ -f "${HOME}/credentials/infisical.env" ] && \
       docker ps --filter "name=infisical" --filter "status=running" -q | grep -q .; then
        # shellcheck disable=SC1091
        source "${HOME}/credentials/infisical.env"
        export INFISICAL_TOKEN INFISICAL_API_URL
        SECRETS_AVAILABLE=true
    fi
fi

load_secret() {
    local container="$1"
    local key="$2"
    if [ "${SECRETS_AVAILABLE}" = "true" ]; then
        infisical secrets get "${key}" --token="${INFISICAL_TOKEN}" --projectId="${INFISICAL_PROJECT_ID}" --path="/${container}" --env=prod --domain="${INFISICAL_API_URL}" --silent --plain 2>/dev/null && return 0
    fi
    return 1
}

# Resolve database passwords from Infisical
if [ "${SECRETS_AVAILABLE}" = "true" ]; then
    MARIADB_ROOT_PASSWORD=$(load_secret "mariadb" "MARIADB_ROOT_PASSWORD") || true
    NEXTCLOUD_MYSQL_ROOT_PASSWORD=$(load_secret "nextcloud" "MYSQL_ROOT_PASSWORD") || true
    PASTE_MYSQL_ROOT_PASSWORD=$(load_secret "paste" "PASTE_MYSQL_ROOT_PASSWORD") || true
    echo "Credential status: MariaDB=$([ -n "${MARIADB_ROOT_PASSWORD}" ] && echo ok || echo MISSING)" \
         "Nextcloud=$([ -n "${NEXTCLOUD_MYSQL_ROOT_PASSWORD}" ] && echo ok || echo MISSING)" \
         "Paste=$([ -n "${PASTE_MYSQL_ROOT_PASSWORD}" ] && echo ok || echo fallback)"
else
    echo "WARNING: Infisical not available — database credentials will be missing"
fi

# Clean up Dawarich database
echo "  Cleaning up Dawarich database..."
# Archive raw_data for points older than 2 months — raw_data contains original import
# payloads and is not needed for Dawarich operation (all queries use without_raw_data scope).
# This matches the behavior of Dawarich's Points::RawData::Archiver.
echo "  Archiving raw_data for old points..."
docker exec dawarich_db psql -U postgres -d dawarich_production -c \
  "UPDATE points SET raw_data = NULL, raw_data_archived = true
   WHERE raw_data IS NOT NULL AND raw_data != '{}' AND raw_data_archived = false
   AND timestamp < EXTRACT(epoch FROM now() - interval '2 months');"
docker exec dawarich_db psql -U postgres -d dawarich_production -c 'TRUNCATE points_dead;'
docker exec dawarich_db psql -U postgres -d dawarich_production -c 'TRUNCATE points_home;'
docker exec dawarich_db psql -U postgres -d dawarich_production -c 'VACUUM;'


if [ -z "${PASTE_MYSQL_ROOT_PASSWORD}" ]; then
    echo "  WARNING: PASTE_MYSQL_ROOT_PASSWORD not set — paste DB dump will be skipped. Set it in Infisical at /paste"
fi

mkdir -p "${BORG_DB_DUMP_DIR}"

DUMP_ERRORS=0

# Helper: check if a container is running
container_running() {
    docker inspect --format='{{.State.Running}}' "$1" 2>/dev/null | grep -q "true"
}

# ── PostgreSQL containers ──────────────────────────────────────────

dump_postgres() {
    local container="$1"
    local user="${2:-postgres}"
    local dbname="$3"
    local errfile="${BORG_DB_DUMP_DIR}/.${container}.err"
    if container_running "${container}"; then
        echo "  Dumping PostgreSQL: ${container} (${dbname})"
        if docker exec "${container}" pg_dump -U "${user}" "${dbname}" > "${BORG_DB_DUMP_DIR}/${container}.sql" 2>"${errfile}"; then
            echo "    OK ($(du -h "${BORG_DB_DUMP_DIR}/${container}.sql" | cut -f1))"
            rm -f "${errfile}"
        else
            echo "    FAILED"
            [ -s "${errfile}" ] && cat "${errfile}"
            rm -f "${errfile}"
            return 1
        fi
    else
        echo "  Skipping ${container} (not running)"
    fi
}

echo "Dumping PostgreSQL databases (parallel)..."
PG_ERRORS=0

dump_postgres "immich_postgres" "postgres" "immich" &
PG_PIDS[0]=$!
dump_postgres "dawarich_db" "postgres" "dawarich_production" &
PG_PIDS[1]=$!
dump_postgres "paperless-db" "paperless" "paperless" &
PG_PIDS[2]=$!
dump_postgres "formbricks_postgres" "postgres" "formbricks" &
PG_PIDS[3]=$!
dump_postgres "onlyoffice-postgresql" "onlyoffice" "onlyoffice" &
PG_PIDS[4]=$!

for pid in "${PG_PIDS[@]}"; do
    if ! wait "${pid}"; then
        PG_ERRORS=$((PG_ERRORS + 1))
    fi
done
DUMP_ERRORS=$((DUMP_ERRORS + PG_ERRORS))

# ── MariaDB containers ────────────────────────────────────────────

dump_mariadb() {
    local container="$1"
    local password="$2"
    if container_running "${container}"; then
        echo "  Dumping MariaDB: ${container}"
        if [ -z "${password}" ]; then
            echo "    FAILED (no password provided — 1Password credential missing)"
            DUMP_ERRORS=$((DUMP_ERRORS + 1))
            return
        fi
        if docker exec -e MYSQL_PWD="${password}" "${container}" mariadb-dump --all-databases -u root > "${BORG_DB_DUMP_DIR}/${container}.sql" 2>&1; then
            local dump_size
            dump_size=$(stat -c%s "${BORG_DB_DUMP_DIR}/${container}.sql" 2>/dev/null || echo 0)
            if [ "${dump_size}" -lt 1024 ]; then
                echo "    FAILED (dump file suspiciously small: ${dump_size} bytes)"
                DUMP_ERRORS=$((DUMP_ERRORS + 1))
            else
                echo "    OK ($(du -h "${BORG_DB_DUMP_DIR}/${container}.sql" | cut -f1))"
            fi
        else
            echo "    FAILED"
            DUMP_ERRORS=$((DUMP_ERRORS + 1))
        fi
    else
        echo "  Skipping ${container} (not running)"
    fi
}

echo "Dumping MariaDB databases..."
dump_mariadb "mariadb" "${MARIADB_ROOT_PASSWORD}"
dump_mariadb "nextcloud-db" "${NEXTCLOUD_MYSQL_ROOT_PASSWORD}"
if [ -n "${PASTE_MYSQL_ROOT_PASSWORD}" ]; then
    dump_mariadb "paste-db" "${PASTE_MYSQL_ROOT_PASSWORD}"
else
    DUMP_ERRORS=$((DUMP_ERRORS + 1))
fi

# ── MongoDB containers ────────────────────────────────────────────

echo "Dumping MongoDB databases..."
if container_running "your_spotify-mongo"; then
    echo "  Dumping MongoDB: your_spotify-mongo"
    MONGO_STDERR=$(mktemp)
    if docker exec "your_spotify-mongo" mongodump --archive 2>"${MONGO_STDERR}" | cat > "${BORG_DB_DUMP_DIR}/your_spotify-mongo.archive"; then
        echo "    OK ($(du -h "${BORG_DB_DUMP_DIR}/your_spotify-mongo.archive" | cut -f1))"
    else
        echo "    FAILED"
        cat "${MONGO_STDERR}"
        DUMP_ERRORS=$((DUMP_ERRORS + 1))
    fi
    rm -f "${MONGO_STDERR}"
else
    echo "  Skipping your_spotify-mongo (not running)"
fi

# ── SQLite databases ─────────────────────────────────────────────
# Uses sqlite3 .backup for safe dumps of active databases

SQLITE_DUMP_DIR="${BORG_DB_DUMP_DIR}/sqlite"
mkdir -p "${SQLITE_DUMP_DIR}"

# Resolve a file path across configured container mount directories
find_container_file() {
    local container="$1"
    local subpath="$2"
    for dir in "${BORG_CONTAINER_MOUNT_DIRS[@]}"; do
        if [ -f "${dir}/${container}/${subpath}" ]; then
            echo "${dir}/${container}/${subpath}"
            return 0
        fi
    done
    return 1
}

# Resolve a glob pattern across configured container mount directories
find_container_glob() {
    local pattern="$1"
    local found=false
    for dir in "${BORG_CONTAINER_MOUNT_DIRS[@]}"; do
        for f in ${dir}/${pattern}; do
            if [ -f "${f}" ]; then
                echo "${f}"
                found=true
            fi
        done
    done
    ${found}
}

dump_sqlite() {
    local label="$1"
    local db_path="$2"
    local dump_name="${3:-$(basename "${db_path}")}"
    if [ -f "${db_path}" ]; then
        echo "  Dumping SQLite: ${label}"
        local backup_path="${SQLITE_DUMP_DIR}/${dump_name}"
        if sqlite3 "${db_path}" ".backup '${backup_path}'" 2>/dev/null; then
            echo "    OK ($(du -h "${backup_path}" | cut -f1))"
        else
            # Retry as the file owner in case of permission issues
            local file_owner
            file_owner=$(stat -c '%U' "${db_path}" 2>/dev/null)
            if [ -n "${file_owner}" ] && [ "${file_owner}" != "root" ]; then
                echo "    Retrying as ${file_owner}..."
                if su "${file_owner}" -s /bin/bash -c "sqlite3 '${db_path}' \".backup '${backup_path}'\"" 2>/dev/null; then
                    echo "    OK ($(du -h "${backup_path}" | cut -f1))"
                else
                    echo "    FAILED (even as ${file_owner})"
                    DUMP_ERRORS=$((DUMP_ERRORS + 1))
                fi
            else
                echo "    FAILED"
                DUMP_ERRORS=$((DUMP_ERRORS + 1))
            fi
        fi
    else
        echo "  Skipping ${label} (file not found)"
    fi
}

echo "Dumping SQLite databases..."

if [ ${#BORG_CONTAINER_MOUNT_DIRS[@]} -eq 0 ]; then
    echo "  WARNING: BORG_CONTAINER_MOUNT_DIRS is empty in borg-backup.conf — skipping SQLite dumps"
    echo "  Add your container-mounts directories to BORG_CONTAINER_MOUNT_DIRS in scripts/borg-backup.conf"
else
    # Critical
    dump_sqlite "vaultwarden" "$(find_container_file vaultwarden data/db.sqlite3)" "vaultwarden.sqlite3"
    dump_sqlite "forgejo" "$(find_container_file forgejo data/gitea/gitea.db)" "forgejo.db"
    dump_sqlite "trilium" "$(find_container_file trilium data/document.db)" "trilium.db"
    dump_sqlite "actual-budget-account" "$(find_container_file actual-budget data/server-files/account.sqlite)" "actual-budget-account.sqlite"
    dump_sqlite "karakeep" "$(find_container_file karakeep data/db.db)" "karakeep.db"

    # Actual Budget user data (glob for budget group files)
    while IFS= read -r f; do
        dump_sqlite "actual-budget-data" "${f}" "actual-budget-$(basename "${f}")"
    done < <(find_container_glob "actual-budget/data/user-files/group-*.sqlite")

    # Actual API (second instance)
    dump_sqlite "actual-api-account" "$(find_container_file actual-api data/My-Finances-0336643/db.sqlite)" "actual-api-db.sqlite"
    dump_sqlite "quicken-account" "$(find_container_file quicken data/server-files/account.sqlite)" "quicken-account.sqlite"
    while IFS= read -r f; do
        dump_sqlite "quicken-data" "${f}" "quicken-$(basename "${f}")"
    done < <(find_container_glob "quicken/data/user-files/group-*.sqlite")

    # Important
    dump_sqlite "kanboard" "$(find_container_file kanboard data/db.sqlite)" "kanboard.sqlite"
    dump_sqlite "freshrss" "$(find_container_file freshrss data/users/Chris10/db.sqlite)" "freshrss.sqlite"
    dump_sqlite "wallabag" "$(find_container_file wallabag data/db/wallabag.sqlite)"
    dump_sqlite "1password" "$(find_container_file 1password data/1password.sqlite)"
    dump_sqlite "beszel" "$(find_container_file beszel data/data.db)" "beszel.db"
    dump_sqlite "speedtest" "$(find_container_file speedtest config/database.sqlite)" "speedtest.sqlite"
    dump_sqlite "uptime" "$(find_container_file uptime data/kuma.db)"
fi

echo ""
echo "Database dumps complete. Errors: ${DUMP_ERRORS}"
ls -lh "${BORG_DB_DUMP_DIR}/"
ls -lh "${SQLITE_DUMP_DIR}/"
echo ""

exit ${DUMP_ERRORS}
