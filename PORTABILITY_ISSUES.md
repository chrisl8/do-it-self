# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system.

---

## Open Issues

### Tailscale Setup Needs a Guide

- 40+ services use the Tailscale sidecar pattern requiring `TS_AUTHKEY` and `TS_DOMAIN`
- Both are now configurable via the web-admin and stored in Infisical, but there's no general user-facing documentation on how to _get_ them. The Tailscale-specific bits in `docs/TESTING.md` are testing-focused, not a general onboarding guide.
- A step-by-step Tailscale setup guide is needed for new users
- **The auth key MUST be created with the `tag:container` ACL tag.** Every container sidecar in this repo runs `--advertise-tags=tag:container`, and the Tailscale control plane rejects registration with `requested tags [tag:container] are invalid or not permitted` if the key isn't authorized for that tag. The user's tailnet ACL policy must also define `tag:container`. The key should be reusable so all 40+ sidecars can use the same one.

### Pre-flight checks for Tailscale prerequisites

Several Tailscale-side configuration mistakes currently fail silently or surface only in deeply-buried sidecar logs. The user only finds out by either reading `docs/TESTING.md` cover-to-cover or by debugging "the URL doesn't work, why?" from scratch. We should add pre-flight checks (in `setup.sh`, `scripts/all-containers.sh --start`, and the web admin's pre-start UI) that detect these conditions up front and tell the user clearly. Known cases:

- **`tag:container` not declared in the tailnet ACL** — auth key creation succeeds but sidecars fail with `requested tags [tag:container] are invalid or not permitted`. Already partially surfaced by the test's tag-hint banner; should also be checked at setup time, ideally by querying the Tailscale API with the user's API token.
- **HTTPS Certificates not enabled in the tailnet** — sidecars register and report healthy, but Tailscale Serve can't provision Let's Encrypt certs and the URL `https://<name>.<tailnet>.ts.net` returns nothing. The only signal is a `serve proxy: ... not able to issue TLS certs ...` line buried in `docker logs <container>-ts`.
- **Auth key not marked Reusable** — first sidecar registers, the rest fail because the key was consumed. Today only visible in sidecar logs.
- **Auth key expired** — every sidecar fails to register. Today only visible in sidecar logs.
- **Free-tier 100-device limit reached** — registrations rejected with a quota message.

Approaches worth considering:

1. **`setup.sh` check** — if the user provides `TS_API_TOKEN` (the cleanup token already used by hetzner-test.sh), `setup.sh` could query the Tailscale API to verify the ACL has `tag:container`, HTTPS is enabled, the auth key has the right tag and is reusable, and the device count is under quota. Print clear errors before proceeding.
2. **`all-containers.sh --start` check** — before starting any container with `uses_tailscale: true`, run `tailscale status --json` and verify the host node is registered, then sample one sidecar's logs for known failure phrases after the first start attempt.
3. **Web admin health panel** — surface the same checks as live status indicators on the dashboard, with links to the relevant Tailscale admin page for each fix.

Not urgent — `docs/TESTING.md` documents all of the above and the test's tag-hint banner catches the most common one — but a proactive pre-flight would prevent every "ran setup, now my dashboard URL doesn't work" support question.

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

- Some containers have a lot of their config buried in mounts; new users may end up with NOTHING.
- Homepage was the named example and now uses a dual-config pattern (`homepage/config-defaults/` in git, `homepage/config-personal/` gitignored, merged at start by `scripts/merge-homepage-config.js`) as of commit `fce10ba`. Apply the same pattern to other containers as they come up.

### Revisit homepage default groups, icons, and widgets

The `config-defaults/` files are opinionated about what a new user sees and will effectively be "forced on the public":

- The `Top` group in `config-defaults/services.yaml` (Web Admin, Tailscale Admin, do-it-self on GitHub) is a first draft. Reasonable for now but worth revisiting once more users are onboard.
- The default `widgets.yaml` ships a greeting-with-FQDN + system resources + search + auto-injected storage widget. The greeting in particular is "just something in the slot" and could be replaced with something genuinely useful (weather with per-user coords, a real datetime widget, etc.) once a better idea surfaces.
- Icon choices (`/icons/do-it-self.svg` for Web Admin, others from the dashboard-icons library) should be reviewed for consistency.
- The maintainer's personal `settings.yaml` layout block hardcodes a 13-group ordering that new users don't benefit from; eventually the default layout should establish a sensible ordering without leaning on personal overrides.

Not urgent — first-pass defaults are landing with the homepage refactor and working. Revisit once the portability effort is closer to "public".

### Make homepage default-enabled again

Phase 1+2 of the homepage refactor (commits `fce10ba` and this one) have laid the groundwork. Remaining:

- Verify on a fresh Hetzner test that homepage starts cleanly with the shipped defaults + zero personal config (add `homepage` to the test's enabled-container list in `scripts/test-fresh-install.sh`).
- Clone `homepage/dashboard-icons/` during `setup.sh` so the icon labels on container compose files resolve on new installs (the `homepage.icon=/dashboard-icons/...` patterns need the library present).
- If the test passes, flip `homepage` to `default_disabled: false` in `container-registry.yaml`.
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

### Testing

- Add info to the TESTING.md about how to add yourself to the test tailnet so you can actually connect to the test endpoints to fully test.
- Add some more output to the test that provides links to click on to go to the testing site.
- Probably add some automated tests to ensure the site works and tailnet sites are responding to traffic.
- Maybe add a "pause" option to the hetzner test so it just pauses, waits for you to test stuff, then destroys.

### Security

- At the moment, the newly setup host exposes its web admin page on the public IP to everyone with no authentication. The assumption was that people ran this on a home network, but that isn't a good assumption. We can PROBABLY rely on Tailscale as good enough lockdown, but for sure dont' just expose the web admin on the local IP, because for instance in Hetzner, this now exposes every secret in the web admin to the entire internet!
  - No seriously, like if you run the Hetzner test, it ends up putting your TS_AUTHKEY on a web page that is publicly accessible! I probably need to revoke that and set up a new one!
    - But that is just like an example of the issue there, so we need to think about that!
- Have Claude do a thorough review of everything for "is this safe"?
