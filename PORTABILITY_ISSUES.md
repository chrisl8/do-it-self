# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system.

---

## Open Issues

### Tailscale Setup Needs a Guide

- 40+ services use the Tailscale sidecar pattern requiring `TS_AUTHKEY` and `TS_DOMAIN`
- Both are now configurable via the web-admin and stored in Infisical, but there's no documentation on how to *get* them (creating an OAuth client, setting up ACL tags with a "container" tag, etc.)
- A step-by-step Tailscale setup guide is needed for new users

### External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

### Host-Specific Project References

- `scripts/system-cron-startup.sh` references `~/Metatron/start-pm2.sh` and `~/Kryten/scripts/start-pm2.sh` (personal projects)
- These are guarded with `if [[ -e ... ]]` so they won't crash, but they're confusing

### Some Host Package Dependencies Not Checked by Setup Scripts

`setup.sh` checks for docker, node, npm, and pm2. `setup-infisical.sh` checks for the infisical CLI. The following are not checked and not documented in one place:

- Tailscale CLI (`/usr/bin/tailscale`)
- BorgBackup CLI (`borg`) -- only needed if using backup scripts
- `yq` (optional, for mount-permissions YAML parsing)
- NVIDIA Docker runtime (for jellyfin, obsidian, mame, retroarch, secure-browser)
- Passwordless `sudo` for `/usr/bin/chown` and `/usr/sbin/shutdown`

### Cron Jobs Must Be Manually Created

Several scripts expect cron entries but none are installed automatically:

- `@reboot` for `system-cron-startup.sh`
- Daily for `borg-backup.sh`
- Periodic for `system-health-check.sh` and `kopia-backup-check.sh`

### External Service Accounts Required

- healthchecks.io account and ping key (for `scripts/healthcheck.conf`)
- Cloudflare account with tunnel setup (for `cloudflared/`)
- WireGuard/VPN provider credentials (for recon/gluetun stack)
- Various service-specific API keys (Spotify, etc.)

### Git-Cloned Subprojects Are Excluded from Repo

- `.gitignore` excludes `tsidp/tsidp/`, `valheim/valheim-server-docker/`, `dawarich/dawarich/`, `minecraft/docker-minecraft-bedrock-server/`
- Must be cloned separately; only `all-containers.sh --update-git-repos` handles it (not documented for first run)

### `caddy-net` Docker Network Must Pre-exist

- 9 services declare `caddy-net` as `external: true`
- `all-containers.sh` creates it, but running services standalone would fail

### `AGENTS.md` and `CLAUDE.md` Are Developer-Facing, Not User-Facing

- These files help AI tools work with the repo but don't help human newcomers

---

## Further Notes

### Need to fully remove 1Password CLI dependency from ALL things running on Neuromancer and transition them all to Infisical

- Other tools on the system that are not part of ~/containers use it too, and they should be migrated so that the final "deploy" doesn't need to include the 1Password related container at all

### Need a way to test the "from scratch" setup path for new users.

- A physical machine?
- A VM setup?

### Need a full "zero to done" script

- There are setup script(s) but they need to be consolidated or have an initial startup that can be curl to bashed by a new user

### Need a full README rewrite

- The readme probably needs a complete rewrite/replace

### The "hostname" and IP are "hand coded" in the config right now

- Either the initial setup should set those
- Or the scripts that start things should grab them at run-time and inject them as needed

### The Docker GID should be auto-detected by setup scripts

- The GID is configurable via the web-admin Global Settings and injected via .env, but the setup scripts don't auto-detect it. `getent group docker | cut -d: -f3` would set it automatically during initial setup.

### Internal secrets (DB passwords, JWT keys) should be auto-generated

- Many containers need passwords that no human ever types (database credentials, encryption keys, session secrets)
- Currently users must manually create and enter these in the Configuration tab
- The registry should distinguish between `auto_generate: true` secrets (internal, can be random) and external secrets (API keys, VPN credentials the user must provide)
- When a container is first enabled, the web-admin should auto-generate any empty `auto_generate` secrets with a random value and store them in Infisical
- This would help: paste DB passwords, nextcloud MYSQL_*, immich DB_PASSWORD, dawarich SECRET_KEY_BASE, zipline CORE_SECRET, formbricks ENCRYPTION_KEY, and many others

### Caddy is there to host MY website specifically.

- Perhaps the public version just doesn't even include any caddy at all or any config?
- Or perhaps it has some helps on hosting one's own website?
- Either way my website shouldn't be included

### Several other PERSONAL stacks that are for Caddy to serve

- How do I retain those but not bother other people with them?

### Config embedded in mounts

- Some containers, like homepage, have a lot of their config buried in mounts, new users will end up with NOTHING. Need to review each such case and make a plan for each.
