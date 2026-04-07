# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system.

---

## Open Issues

### Tailscale Setup Needs a Guide

- 40+ services use the Tailscale sidecar pattern requiring `TS_AUTHKEY` and `TS_DOMAIN`
- Both are now configurable via the web-admin and stored in Infisical, but there's no general user-facing documentation on how to _get_ them. The Tailscale-specific bits in `docs/TESTING.md` are testing-focused, not a general onboarding guide.
- A step-by-step Tailscale setup guide is needed for new users
- **The auth key MUST be created with the `tag:container` ACL tag.** Every container sidecar in this repo runs `--advertise-tags=tag:container`, and the Tailscale control plane rejects registration with `requested tags [tag:container] are invalid or not permitted` if the key isn't authorized for that tag. The user's tailnet ACL policy must also define `tag:container`. The key should be reusable so all 40+ sidecars can use the same one.

### External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

### Host-Specific Project References

- `scripts/system-cron-startup.sh` references `~/Metatron/start-pm2.sh` and `~/Kryten/scripts/start-pm2.sh` (personal projects)
- These are guarded with `if [[ -e ... ]]` so they won't crash, but they're confusing

### Some Host Package Dependencies Not Checked by Setup Scripts

`setup.sh` checks for / installs docker, node, npm, pm2, infisical CLI, and tailscale. The following are not checked and not documented in one place:

- BorgBackup CLI (`borg`) -- only needed if using backup scripts
- NVIDIA Docker runtime (for jellyfin, obsidian, mame, retroarch, secure-browser)
- Passwordless `sudo` for `/usr/bin/chown` and `/usr/sbin/shutdown` (`scripts/all-containers.sh` and `scripts/system-graceful-shutdown.sh` test for it and print sudoers instructions, but neither configures it)

### Cron Jobs Must Be Manually Created

Most cron entries are still manual. `scripts/setup-borg-backup.sh` installs its own borg cron entries; the rest do not:

- `@reboot` for `system-cron-startup.sh`
- Periodic for `system-health-check.sh` and `kopia-backup-check.sh`

### External Service Accounts Required

- healthchecks.io account and ping key (for `scripts/healthcheck.conf`)
- Cloudflare account with tunnel setup (for `cloudflared/`)
- WireGuard/VPN provider credentials (for recon/gluetun stack)
- Various service-specific API keys (Spotify, etc.)

### Git-Cloned Subprojects Are Excluded from Repo

- `.gitignore` excludes `tsidp/tsidp/`, `valheim/valheim-server-docker/`, `dawarich/dawarich/`, `minecraft/docker-minecraft-bedrock-server/`
- `scripts/all-containers.sh --update-git-repos` clones them, but `setup.sh` does not call it on first run, so a fresh install can't start any of these containers without a manual extra step.

### `AGENTS.md` and `CLAUDE.md` Are Developer-Facing, Not User-Facing

- These files help AI tools work with the repo but don't help human newcomers

---

## Further Notes

### Need to fully remove 1Password CLI dependency

Borg has been migrated to Infisical (`scripts/setup-borg-backup.sh` is Infisical-only) and `scripts/all-containers.sh` itself contains zero `op://` references. What's still left:

- The `1password/` container itself still exists in the repo (currently `default_disabled`).
- `scripts/kopia-backup-check.sh:51-58` still has a 1Password fallback path.
- 20+ containers still ship a `1password_credential_paths.env` file (factorio, paste, pure-ftpd, immich, zipline, quicken, kopia-tr0n, searxng, your-spotify, dawarich, the-lounge, secure-browser, speedtest, paperless, forgejo, portainer, netdata, seerr, starbound, meshtastic). These are unused on Infisical-based deploys but should be removed for clarity.
- Other tools on the host (outside `~/containers`) that use 1Password should be migrated so the final "deploy" doesn't need to include the 1Password container at all.

### Need a full README rewrite

The current README still tells users to manually clone, edit mounts, and run `all-containers.sh --start`, with no mention of `setup.sh` or the web admin. It should open with a quickstart along the lines of: "curl|bash `scripts/setup.sh` → open `http://<host>:3333` → Configuration tab → enable containers → start them" — and move the existing maintainer-specific notes lower.

### Caddy is there to host MY website specifically.

- Caddy is `default_disabled` but still embeds a hardcoded `lofland.com` healthcheck and a `voidship_ephemeral` mount.
- Perhaps the public version just doesn't even include any caddy at all or any config?
- Or perhaps it has some helps on hosting one's own website?
- Either way my website shouldn't be included

### Several other PERSONAL stacks that are for Caddy to serve

- How do I retain those but not bother other people with them?

### Config embedded in mounts

- Some containers, like homepage, have a lot of their config buried in mounts; new users may end up with NOTHING. Need to review each such case and make a plan for each.
- Homepage was the named example and is now unblocked (`homepage/config/` is seeded in the repo with sane defaults), but the general principle still applies and other containers should be audited.

### Make homepage default-enabled again

The blocker is now mostly removed: `homepage/config/` is seeded in the repo (`bookmarks.yaml`, `services.yaml`, `docker.yaml`, `settings.yaml`, `widgets.yaml`, etc.). Next steps:

- Verify on a fresh Hetzner test that homepage starts cleanly with the seeded config (add it to the test's enabled-container list).
- If green, flip `homepage` to `default_disabled: false` in `container-registry.yaml`.
- Goal: a fresh install should have infisical AND homepage running by default, so the user has both a secret manager and a dashboard with zero configuration.

### Audit remaining containers for hardcoded mount paths

The `apply_mount_permissions` resolver in `scripts/all-containers.sh` now supports `${VOL_*}` variable expansion and `mkdir -p`s missing paths (commit `cf101e1`). The known offenders (`searxng`, `nextcloud`, `wallabag`) have all been converted. Other containers should be audited for any remaining hardcoded `/mnt/...` paths in `mount-permissions.yaml`, `compose.yaml` `volumes:`, or scripts.

### Directing user to CLI instead of web admin

Currently both the README and `setup.sh` say to run `~/containers/scripts/all-containers.sh --start`, but new users should be guided to the web UI instead. Two-part fix:

1. Update README + `setup.sh` final-instructions to point at the web admin.
2. The web admin lacks a "Start All Enabled" button, so even after enabling containers in the UI a user has to drop to CLI. Adding that button is a prerequisite for the redirection above to make sense.

Instructions about the CLI SHOULD still be somewhere (README "advanced" section), but the default "go to" should be the web GUI.

### Document and/or automate maintenance tasks

- Rebooting
- Patching and rebooting
- What else?
