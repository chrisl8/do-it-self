# BorgBackup Disaster Recovery Runbook

## Prerequisites

1. Fresh Ubuntu install on the server
2. Mount all drives to their expected paths:
   - `/mnt/2000` (2TB SSD)
   - `/mnt/250` (250GB SSD)
   - `/mnt/22TB` (22TB HDD)
3. Install BorgBackup: `sudo apt install borgbackup`
4. Have the borg repo passphrase available (stored in 1Password)

## Locating the Repository

The borg repo is at `/mnt/22TB/borg-repo`. If the 22TB drive is intact, the repo is available immediately.

If using a remote repo (when configured), you'll need Tailscale access to the remote machine.

## Step 1: List Available Archives

```bash
export BORG_PASSPHRASE="your-passphrase-here"
export BORG_REPO="/mnt/22TB/borg-repo"

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
borg extract "$BORG_REPO::archive-name" home/chrisl8/credentials/
```

## Step 3: Restore the Containers Repository

```bash
cd /
borg extract "$BORG_REPO::archive-name" home/chrisl8/containers/
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

Restore all container mount data:

```bash
cd /
# Restore the main data directories
borg extract "$BORG_REPO::archive-name" mnt/2000/container-mounts/
borg extract "$BORG_REPO::archive-name" mnt/250/container-mounts/
borg extract "$BORG_REPO::archive-name" mnt/22TB/container-mounts/recon/data/media/comics/
borg extract "$BORG_REPO::archive-name" mnt/22TB/container-mounts/recon/data/media/ebooks/
borg extract "$BORG_REPO::archive-name" mnt/22TB/container-mounts/recon/data/media/manga/
borg extract "$BORG_REPO::archive-name" mnt/22TB/container-mounts/recon/data/media/music/
borg extract "$BORG_REPO::archive-name" mnt/22TB/container-mounts/filez/
```

## Step 5: Restore Databases from Dumps

If raw database files are inconsistent, restore from the SQL dumps created before each backup.

The dumps are stored at `/mnt/2000/container-mounts/borgbackup/db-dumps/` inside the archive.

```bash
# Extract just the dumps
cd /tmp
borg extract "$BORG_REPO::archive-name" mnt/2000/container-mounts/borgbackup/db-dumps/
```

### PostgreSQL

Start the database container first, then restore:

```bash
# Example for immich
cd ~/containers/immich
docker compose up -d db
# Wait for it to be healthy
gunzip -c /tmp/mnt/2000/container-mounts/borgbackup/db-dumps/immich_postgres.sql.gz | \
    docker exec -i immich_postgres psql -U postgres

# Repeat for: dawarich_db, paperless-db, formbricks_postgres, onlyoffice-postgresql
```

### MariaDB

```bash
# Example for mariadb
cd ~/containers/mariadb
docker compose up -d
gunzip -c /tmp/mnt/2000/container-mounts/borgbackup/db-dumps/mariadb.sql.gz | \
    docker exec -i mariadb mariadb -u root -p"$MARIADB_ROOT_PASSWORD"

# Repeat for: nextcloud-db, paste-db
```

### MongoDB

```bash
cd ~/containers/your-spotify
docker compose up -d mongo
gunzip -c /tmp/mnt/2000/container-mounts/borgbackup/db-dumps/your_spotify-mongo.archive.gz | \
    docker exec -i your_spotify-mongo mongorestore --archive --gzip
```

### CouchDB

```bash
cd ~/containers/obsidian-babel-livesync
docker compose up -d
# Restore each database from the dump directory
for dump in /tmp/mnt/2000/container-mounts/borgbackup/db-dumps/couchdb_*.json.gz; do
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
export BORG_PASSPHRASE="your-passphrase-here"
export BORG_REPO="/mnt/22TB/borg-repo"

# Stop the service
cd ~/containers/trilium
docker compose down

# Restore its data
cd /
borg extract "$BORG_REPO::archive-name" mnt/2000/container-mounts/trilium/

# Restore its compose file and credentials if needed
borg extract "$BORG_REPO::archive-name" home/chrisl8/containers/trilium/
borg extract "$BORG_REPO::archive-name" home/chrisl8/credentials/trilium.env

# Re-symlink .env
ln -sf ~/credentials/trilium.env ~/containers/trilium/.env

# Restart
docker compose up -d
```

## Remote (Offsite) Repo Recovery

Use the offsite repo on the Raspberry Pi when the local 22TB drive is lost or the entire server is destroyed.

### Prerequisites

1. Install BorgBackup: `sudo apt install borgbackup`
2. Install and authenticate Tailscale (the Pi is on the tailnet)
3. Have the remote borg passphrase available (`BORG_REMOTE_PASSPHRASE` from 1Password)
4. Set up SSH access to the Pi (key in `/root/.ssh/borg-offsite` or generate a new one)

### Connect to the Remote Repo

```bash
export BORG_PASSPHRASE="your-remote-passphrase-here"
export BORG_REPO="ssh://piadmin@backup-pi.jamnapari-goblin.ts.net/mnt/backup/borg-repo"
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
borg extract "$BORG_REPO::archive-name" home/chrisl8/credentials/

# Restore containers repo, data, etc. — same commands as local recovery
```

### Large Restores

For a full server rebuild, restoring hundreds of GB over the network may be slow. If the Pi is offsite, consider physically retrieving it and connecting it to the local network first. USB 3 + gigabit Ethernet will be significantly faster than a residential uplink.

### Re-enabling Offsite Backup After Rebuild

1. Set up SSH key for root: `sudo ssh-keygen -t ed25519 -f /root/.ssh/borg-offsite`
2. Copy the public key to the Pi: `ssh-copy-id -i /root/.ssh/borg-offsite.pub piadmin@backup-pi.jamnapari-goblin.ts.net`
3. Add SSH config entry for `backup-pi` in `/root/.ssh/config`
4. Set `BORG_REMOTE_REPO` in `scripts/borg-backup.conf`
5. Run `scripts/setup-borg-backup.sh` to verify connectivity

## Notes

- The local borg repo key is stored in 1Password and at `~/credentials/borg-repo-key.txt`
- The remote borg repo key is stored in 1Password and at `~/credentials/borg-remote-repo-key.txt`
- If a key is lost, that repo cannot be decrypted — keep the 1Password copies safe
- To import a key: `borg key import /mnt/22TB/borg-repo ~/credentials/borg-repo-key.txt`
- To import the remote key: `borg key import ssh://piadmin@backup-pi/mnt/backup/borg-repo ~/credentials/borg-remote-repo-key.txt`
- Archives are named with timestamps: `backup-YYYY-MM-DDTHH:MM:SS`
- The same archive name is used in both local and remote repos for easy correlation
