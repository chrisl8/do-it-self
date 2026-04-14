# BorgBackup Disaster Recovery Runbook

## Before You Begin

All paths referenced below are configured in `scripts/borg-backup.conf`. Source it to set the variables:

```bash
source ~/containers/scripts/borg-backup.conf
```

Secrets (passphrases, healthcheck URLs) are stored in Infisical at `/borgbackup`.

## Prerequisites

1. Fresh Ubuntu install on the server
2. Mount all drives to their expected paths (match your `borg-backup.conf` settings)
3. Install BorgBackup: `sudo apt install borgbackup`
4. Have the borg repo passphrase available (stored in Infisical)

## Step 1: List Available Archives

```bash
export BORG_PASSPHRASE="your-passphrase-here"
export BORG_REPO="$BORG_REPO"   # from borg-backup.conf

# List all archives (most recent last)
borg list "$BORG_REPO"

# Show details of a specific archive
borg info "$BORG_REPO::archive-name"
```

## Step 2: Restore Credentials First

Credentials are needed before anything else can work.

```bash
mkdir -p ~/credentials
cd /
borg extract "$BORG_REPO::archive-name" home/$USER/credentials/
```

## Step 3: Restore the Containers Repository

```bash
cd /
borg extract "$BORG_REPO::archive-name" home/$USER/containers/
```

After extraction, re-symlink `.env` files:

```bash
cd ~/containers
for dir in */; do
    service="${dir%/}"
    if [ -f ~/credentials/"${service}.env" ]; then
        ln -sf ~/credentials/"${service}.env" "${dir}.env"
    fi
done
```

## Step 4: Restore Container Data

Restore the directories listed in `BORG_BACKUP_PATHS` from your `borg-backup.conf`. The paths in the archive match the original absolute paths (without leading `/`):

```bash
cd /

# Restore each path from BORG_BACKUP_PATHS in your borg-backup.conf.
# Example (adjust for your mount points):
borg extract "$BORG_REPO::archive-name" mnt/primary/container-mounts/
borg extract "$BORG_REPO::archive-name" mnt/secondary/container-mounts/
```

## Step 5: Restore Databases from Dumps

If raw database files are inconsistent, restore from the SQL dumps created before each backup.

The dumps are stored at `$BORG_DB_DUMP_DIR` (configured in `borg-backup.conf`):

```bash
cd /tmp
borg extract "$BORG_REPO::archive-name" "${BORG_DB_DUMP_DIR#/}/"
```

### PostgreSQL

Start the database container first, then restore:

```bash
# Example for immich
cd ~/containers/immich
docker compose up -d db
# Wait for it to be healthy
gunzip -c "/tmp/${BORG_DB_DUMP_DIR#/}/immich_postgres.sql.gz" | \
    docker exec -i immich_postgres psql -U postgres

# Repeat for: dawarich_db, paperless-db, formbricks_postgres, onlyoffice-postgresql
```

### MariaDB

```bash
# Example for mariadb
cd ~/containers/mariadb
docker compose up -d
gunzip -c "/tmp/${BORG_DB_DUMP_DIR#/}/mariadb.sql.gz" | \
    docker exec -i mariadb mariadb -u root -p"$MARIADB_ROOT_PASSWORD"

# Repeat for: nextcloud-db, paste-db
```

### MongoDB

```bash
cd ~/containers/your-spotify
docker compose up -d mongo
gunzip -c "/tmp/${BORG_DB_DUMP_DIR#/}/your_spotify-mongo.archive.gz" | \
    docker exec -i your_spotify-mongo mongorestore --archive --gzip
```

### CouchDB

```bash
cd ~/containers/obsidian-babel-livesync
docker compose up -d
# Restore each database from the dump directory
for dump in /tmp/${BORG_DB_DUMP_DIR#/}/couchdb_*.json.gz; do
    dbname=$(basename "$dump" .json.gz | sed 's/^couchdb_//')
    curl -X PUT "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5984/${dbname}"
    gunzip -c "$dump" | curl -X POST "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@localhost:5984/${dbname}/_bulk_docs" \
        -H "Content-Type: application/json" -d @-
done
```

## Step 6: Start All Services

```bash
cd ~/containers
scripts/all-containers.sh --start
```

## Step 7: Post-Restore Verification

- [ ] Check `docker ps -a` — all containers healthy
- [ ] Verify Homepage dashboard loads
- [ ] Test Immich — photos accessible
- [ ] Test Nextcloud — files accessible
- [ ] Test Paperless — documents searchable
- [ ] Test Dawarich — location data present
- [ ] Run `scripts/system-health-check.sh` — no errors
- [ ] Verify cron jobs are installed (`crontab -l`)

## Partial Restore: Single Service

To restore just one service (e.g., trilium):

```bash
source ~/containers/scripts/borg-backup.conf
export BORG_PASSPHRASE="your-passphrase-here"

# Stop the service
cd ~/containers/trilium
docker compose down

# Restore its data (adjust the mount path for your system)
cd /
borg extract "$BORG_REPO::archive-name" mnt/primary/container-mounts/trilium/

# Restore its compose file and credentials if needed
borg extract "$BORG_REPO::archive-name" home/$USER/containers/trilium/
borg extract "$BORG_REPO::archive-name" home/$USER/credentials/trilium.env

# Re-symlink .env
ln -sf ~/credentials/trilium.env ~/containers/trilium/.env

# Restart
docker compose up -d
```

## Extracting Individual Files or Directories

Use this when you need to recover specific files (e.g., accidentally deleted icons,
a config file) without a full service restore.

### 1. Load the passphrase from Infisical

The borg repo is root-owned, so all borg commands need `sudo -E` to preserve
the passphrase environment variable.

```bash
source ~/credentials/infisical.env
export INFISICAL_TOKEN INFISICAL_API_URL
export BORG_PASSPHRASE=$(infisical secrets get BORG_PASSPHRASE \
  --token="$INFISICAL_TOKEN" --projectId="$INFISICAL_PROJECT_ID" \
  --path="/borgbackup" --env=prod --domain="$INFISICAL_API_URL" \
  --silent --plain)
```

### 2. Find the right archive

```bash
sudo -E borg list /mnt/22TB/borg-repo --last 10
```

### 3. Preview what's in the archive (dry run)

Archive paths are stored WITHOUT a leading `/`. So `/home/chrisl8/containers/`
becomes `home/chrisl8/containers/`.

```bash
sudo -E borg extract --dry-run --list /mnt/22TB/borg-repo::ARCHIVE_NAME \
  home/chrisl8/containers/homepage/icons/
```

### 4. Extract to a temp directory

Borg extracts relative to the current working directory, recreating the full
directory structure. Always `cd` to `/tmp` first to avoid overwriting live files.

```bash
cd /tmp
sudo -E borg extract /mnt/22TB/borg-repo::ARCHIVE_NAME \
  home/chrisl8/containers/homepage/icons/
```

The files are now at `/tmp/home/chrisl8/containers/homepage/icons/`.

### 5. Copy extracted files to their destination

**Important**: The extracted files are root-owned. You must use `sudo` for the
copy and then fix ownership. Do NOT use shell globs (`*`) with sudo — the glob
is expanded by your unprivileged shell before sudo runs, and it cannot read
root-owned directories. Use the `/.` suffix to copy directory contents instead:

```bash
# Copy contents (the /. avoids needing glob expansion)
sudo cp -r /tmp/home/chrisl8/containers/homepage/icons/. ~/containers/homepage/icons/

# Fix ownership
sudo chown $USER:$USER ~/containers/homepage/icons/*

# Clean up
sudo rm -rf /tmp/home
```

### Common gotchas

- **`sudo ls dir/*` fails but `sudo ls dir/` works**: Your shell expands `*`
  before sudo runs. Since the directory is root-owned, the unprivileged shell
  cannot read it and the glob fails. Always let sudo handle the path directly.
- **Borg needs sudo**: The backup script runs as root to read all container mount
  files. The repo is therefore root-owned.
- **Use `sudo -E`**: The `-E` flag preserves `BORG_PASSPHRASE` in the sudo
  environment. Without it, borg will prompt for the passphrase interactively.
- **Extract to /tmp first**: Extracting to `/` would overwrite live files with
  the backed-up versions. Always extract to a temp location and copy what you need.

---

## Remote (Offsite) Repo Recovery

Use the offsite repo when the local drive is lost or the entire server is destroyed.

### Prerequisites

1. Install BorgBackup: `sudo apt install borgbackup`
2. Install and authenticate Tailscale (the remote server is on the tailnet)
3. Have the remote borg passphrase available (`BORG_REMOTE_PASSPHRASE` from Infisical)
4. Set up SSH access to the remote server (generate a key pair and copy the public key)

### Connect to the Remote Repo

```bash
export BORG_PASSPHRASE="your-remote-passphrase-here"
export BORG_REPO="$BORG_REMOTE_REPO"   # from borg-backup.conf
```

If the repo key was lost with the server, import it first:

```bash
borg key import "$BORG_REPO" ~/credentials/borg-remote-repo-key.txt
```

### Recovery Steps

Steps 1-7 from the local recovery above work identically over SSH — just use the remote `BORG_REPO` value. Borg handles the SSH transport transparently.

```bash
# List archives
borg list "$BORG_REPO"

# Restore credentials
cd /
borg extract "$BORG_REPO::archive-name" home/$USER/credentials/

# Restore containers repo, data, etc. — same commands as local recovery
```

### Large Restores

For a full server rebuild, restoring hundreds of GB over the network may be slow. If the remote server is offsite, consider physically retrieving it and connecting it to the local network first. USB 3 + gigabit Ethernet will be significantly faster than a residential uplink.

### Re-enabling Offsite Backup After Rebuild

1. Generate an SSH key pair: `sudo ssh-keygen -t ed25519 -f /root/.ssh/borg-offsite`
2. Copy the public key to the remote server: `ssh-copy-id -i /root/.ssh/borg-offsite.pub USER@REMOTE-HOST`
3. Add an SSH config entry for the remote host in `/root/.ssh/config`
4. Set `BORG_REMOTE_REPO` in `scripts/borg-backup.conf`
5. Run `scripts/setup-borg-backup.sh` to verify connectivity

## Notes

- The local borg repo key is stored in Infisical and at `~/credentials/borg-repo-key.txt`
- The remote borg repo key is stored in Infisical and at `~/credentials/borg-remote-repo-key.txt`
- If a key is lost, that repo cannot be decrypted — keep the Infisical copies safe
- To import a key: `borg key import "$BORG_REPO" ~/credentials/borg-repo-key.txt`
- To import the remote key: `borg key import "$BORG_REMOTE_REPO" ~/credentials/borg-remote-repo-key.txt`
- Archives are named with timestamps: `backup-YYYY-MM-DDTHH:MM:SS`
- The same archive name is used in both local and remote repos for easy correlation
