# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system. Items are grouped by severity.

---

## Critical: Repository Won't Function Without These Changes

### 1. Hardcoded Mount Points (150+ instances across 70+ compose files)

The entire system assumes 4 specific disk mount points:

- `/mnt/2000/` (primary container data)
- `/mnt/250/` (cache/fast tier)
- `/mnt/22TB/` (media and backups)
- `/mnt/120/` (monitored filesystem)

Every service's `compose.yaml` references these directly. A new user with different disk layouts would need to find-and-replace across the entire repo.

### 2. Tailscale is Mandatory but Opaque (40+ services)

- 40+ services use the Tailscale sidecar pattern requiring `TS_AUTHKEY` and `TS_DOMAIN`
- No documentation on how to set up the Tailscale OAuth client or ACL tags
- The personal Tailscale domain is hardcoded in at least `paste/compose.yaml` and `borgbackup/RECOVERY.md`
- Each service needs `/dev/net/tun` and `NET_ADMIN`/`SYS_MODULE` capabilities

### 3. 1Password Integration Couples 54 Services

- 54 services have `1password_credential_paths.env` files with `op://` references
- Without 1Password CLI + Connect API, users must manually create individual `.env` files for every service
- No documentation on what the alternative manual `.env` file contents should look like
- No template or example `.env` files provided

### 4. No Bootstrap/Setup Script

- No "first run" experience exists
- No script to create `~/credentials/` or the required directory trees under `/mnt/`
- No validation that prerequisites are met before starting
- The recovery docs (`borgbackup/RECOVERY.md`) are actually the best setup reference, which is backwards

---

## High: Significant Manual Work Required

### 5. Hardcoded Username "chrisl8" (20+ instances)

Found in:

- `scripts/borg-restore-test.sh` (borg extract paths)
- `borgbackup/RECOVERY.md` (multiple extract commands)
- `cloudflared/README.md` (path examples)
- `Readme.MD` (crontab examples)
- `caddy/compose.yaml` and `voidship_ephemeral/compose.yaml` (`/home/chrisl8/` paths)

### 6. Docker Group ID 985 is Hardcoded

Services like portainer, diun, netdata, homepage, and beszel use `group_add: [985]`. If the host's Docker group has a different GID, these services can't access `/var/run/docker.sock`.

### 7. Credential Symlink Pattern is Undocumented for New Users

- CLAUDE.md describes the pattern (`~/credentials/service.env` symlinked as `.env`)
- But there's no list of which `.env` files are needed, what variables each requires, or example content
- The `.gitignore` excludes all `.env` files, so new users get nothing

### 8. External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

### 9. Host-Specific Project References

- `scripts/system-cron-startup.sh` references `~/Metatron/start-pm2.sh` and `~/Kryten/scripts/start-pm2.sh` (personal projects)
- These are guarded with `if [[ -e ... ]]` so they won't crash, but they're confusing

---

## Medium: Would Cause Confusion or Partial Failures

### 10. Multiple Host Package Dependencies Not Listed in One Place

Required on the host:

- Docker + Docker Compose
- Tailscale CLI (`/usr/bin/tailscale`)
- 1Password CLI (`/usr/bin/op`) (optional but heavily used)
- Node.js + PM2 (for web-admin)
- BorgBackup CLI (`borg`)
- `yq` (optional, for mount-permissions YAML parsing)
- NVIDIA Docker runtime (for jellyfin, obsidian, mame, retroarch, secure-browser)
- Passwordless `sudo` for `/usr/bin/chown` and `/usr/sbin/shutdown`

### 11. Cron Jobs Must Be Manually Created

Several scripts expect cron entries but none are installed automatically:

- `@reboot` for `system-cron-startup.sh`
- Daily for `borg-backup.sh`
- Periodic for `system-health-check.sh` and `kopia-backup-check.sh`

### 12. External Service Accounts Required

- healthchecks.io account and ping key (for `scripts/healthcheck.conf`)
- Cloudflare account with tunnel setup (for `cloudflared/`)
- WireGuard/VPN provider credentials (for recon/gluetun stack)
- Various service-specific API keys (Spotify, etc.)

### 13. Hardcoded Personal Domain Names in Documentation

- `lofland.com`, `lofland.net`, `ekpyroticfrood.net`, `voidshipephemeral.space`
- Appear in `cloudflared/README.md` and `witchazzan/` docs

### 14. Machine Name "Neuromancer" Hardcoded

- `beszel/compose.yaml` hardcodes the system name in dashboard URLs

### 15. Git-Cloned Subprojects Are Excluded from Repo

- `.gitignore` excludes `tsidp/tsidp/`, `valheim/valheim-server-docker/`, `dawarich/dawarich/`, `minecraft/docker-minecraft-bedrock-server/`
- Must be cloned separately; only `all-containers.sh --update-git-repos` handles it (not documented for first run)

### 16. `caddy-net` Docker Network Must Pre-exist

- 9 services declare `caddy-net` as `external: true`
- `all-containers.sh` creates it, but running services standalone would fail

### 17. `paste/compose.yaml` Has Hardcoded Default Passwords

- MySQL root/user passwords are set to `pastefy` directly in the compose file
- Should use environment variables like other services

---

## Low: Cosmetic or Documentation Issues

### 18. README Path Examples Are Inconsistent

- Some examples use `~/containers/`, others use `/home/chrisl8/containers/`
- Crontab examples hardcode the full path

### 19. No License File

- Others can't know if they're legally permitted to use/modify this code

### 20. `AGENTS.md` and `CLAUDE.md` Are Developer-Facing, Not User-Facing

- These files help AI tools work with the repo but don't help human newcomers

### 21. `Readme.MD` Uses Nonstandard Capitalization

- Most projects use `README.md`; this uses `Readme.MD`

---

## Further hand-entered notes

### 22. Need to fully remove 1Password CLI dependency from ALL things running on Neuromancer and transition them all to infiscal

- Other tools on the system that are not part of ~/containers use it too, and they should be migrated so that the final "deploy" doesn't need to include the 1Password related container at all

### 23. Need a way to test the "from scratch" setup path for new users.

- A physical machine?
- A VM setup?

### 24. Need a full "zero to done" script

- There are setup script(s) but they need to be consolidated or have an initial startup that can be curl to bashed by a new user

### 25. Need a full "zero to done"

- The readme probably needs a complete rewrite/replace

### 26. The "hostname" and IP are "hand coded" in the config right now

- Either the initial setup should set those
- Or the scripts that start thing should grab them at run-time and inject them as needed

### 27. The Docker GUID is "hand coded" in the config right now

- Same as hostname/ip, should be set by initial setup or at run-time rather than user config.
