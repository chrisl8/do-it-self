# BorgBackup Setup Guide

BorgBackup provides encrypted, deduplicated backups of your container data, databases, credentials, and system configuration. Backups run daily via cron with optional offsite replication.

## Prerequisites

- Ubuntu/Debian host (borgbackup is installed automatically by the setup script)
- Infisical running (for storing passphrases and healthcheck URLs)
- At least one mount with enough space for the borg repository

## 1. Configure borg-backup.conf

The setup script creates `scripts/borg-backup.conf` from the template automatically, but you should edit it before running setup:

```bash
cp scripts/borg-backup.conf.example scripts/borg-backup.conf
nano scripts/borg-backup.conf
```

Key values to set:

| Variable | What to set |
|----------|-------------|
| `BORG_REPO` | Path to local borg repository, e.g. `/mnt/data/borg-repo` |
| `BORG_DB_DUMP_DIR` | Where database dumps are written, e.g. `/mnt/data/borg-db-dumps` |
| `BORG_BACKUP_PATHS` | Array of directories to back up (container mounts, home, /etc) |
| `BORG_CONTAINER_MOUNT_DIRS` | Array of base container-mounts directories (for SQLite dump resolution) |

## 2. Set Secrets in Infisical

In Infisical at path `/borgbackup`, create these secrets:

| Secret | Required | Purpose |
|--------|----------|---------|
| `BORG_PASSPHRASE` | Yes | Encryption passphrase for the local borg repo |
| `BORG_HEALTHCHECK_URL` | No | healthchecks.io ping URL for backup monitoring |
| `BORG_RESTORE_TEST_HEALTHCHECK_URL` | No | healthchecks.io ping URL for weekly restore tests |
| `BORG_REMOTE_PASSPHRASE` | Only if using offsite | Separate passphrase for the remote borg repo |

## 3. Run Setup

```bash
scripts/setup-borg-backup.sh
```

This script is idempotent (safe to re-run). It will:
- Install the `borgbackup` and `sqlite3` packages
- Create the dump directory
- Initialize the local borg repository (if `BORG_PASSPHRASE` is set)
- Export the repo key to `~/credentials/borg-repo-key.txt`
- Test SSH connectivity to the remote server (if `BORG_REMOTE_REPO` is set)
- Initialize the remote borg repository
- Install daily backup and weekly restore test cron jobs

## 4. Run a Test Backup

```bash
scripts/borg-backup.sh
```

Then verify:

```bash
borg list /path/to/your/borg-repo
```

## Offsite (Remote) Backup

Remote backup replicates archives to a separate server for disaster recovery. This is optional but strongly recommended.

### Set Up the Remote Server

1. Install BorgBackup on the remote server
2. Create a dedicated borg user with a restricted shell that only allows `borg serve --append-only`:

```bash
# On the remote server
sudo useradd -m borg
sudo mkdir -p /mnt/backup/borg
sudo chown borg:borg /mnt/backup/borg

# Create a restricted shell script
cat << 'EOF' | sudo tee /usr/local/bin/borg-serve-only.sh
#!/bin/bash
exec borg serve --restrict-to-path /mnt/backup/borg --append-only
EOF
sudo chmod +x /usr/local/bin/borg-serve-only.sh
sudo chsh -s /usr/local/bin/borg-serve-only.sh borg
```

### Set Up SSH Access

```bash
# On the backup client (your server)
sudo ssh-keygen -t ed25519 -f /root/.ssh/borg-offsite
sudo ssh-copy-id -i /root/.ssh/borg-offsite.pub borg@REMOTE-HOST

# Add SSH config entry
cat << EOF | sudo tee -a /root/.ssh/config

Host REMOTE-HOSTNAME
    HostName REMOTE-HOST-OR-IP
    User borg
    IdentityFile /root/.ssh/borg-offsite
EOF
```

### Enable Remote Backup

1. Set `BORG_REMOTE_REPO` in `scripts/borg-backup.conf`:
   ```bash
   BORG_REMOTE_REPO="ssh://borg@REMOTE-HOST/mnt/backup/borg"
   ```
2. Set `BORG_REMOTE_PASSPHRASE` in Infisical at `/borgbackup`
3. Re-run `scripts/setup-borg-backup.sh` to initialize the remote repo

## Customizing Database Dumps

The `scripts/borg-db-dump.sh` script dumps databases before each backup. It handles PostgreSQL, MariaDB, MongoDB, and SQLite databases automatically.

**To adjust which databases are dumped**, edit `borg-db-dump.sh`. The script is organized by database type with helper functions:
- `dump_postgres "container" "user" "dbname"` — for PostgreSQL containers
- `dump_mariadb "container" "password"` — for MariaDB containers
- `dump_sqlite "label" "path" "output-name"` — for SQLite files

SQLite paths are resolved automatically via `BORG_CONTAINER_MOUNT_DIRS` in `borg-backup.conf`. If you add a new container with a SQLite database, add a `dump_sqlite` line and the path will be found across your configured mounts.

**Database credentials** are loaded from Infisical. If a container's database has a non-default password, store it in Infisical at `/<container-name>/`.

## What Gets Backed Up

Everything listed in `BORG_BACKUP_PATHS` in your conf, minus the patterns in `borgbackup/exclude-patterns.txt`. The exclude file skips:

- Re-downloadable media (movies, series, torrents)
- Raw database data directories (backed up via SQL dumps instead)
- Regenerated caches and build artifacts
- Tailscale state (regenerated on auth)
- Cloned git repositories (re-cloneable)

## Monitoring

If you set `BORG_HEALTHCHECK_URL` in Infisical, each backup run pings healthchecks.io on start and completion (or failure). The same applies to `BORG_RESTORE_TEST_HEALTHCHECK_URL` for the weekly restore test.

Backup status is written to `homepage/images/borg-status.json` for display on the Homepage dashboard.

## Recovery

See [RECOVERY.md](RECOVERY.md) for the full disaster recovery runbook.
