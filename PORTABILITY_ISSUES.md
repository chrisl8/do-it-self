# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system.

---

## Open Issues

### Tailscale Setup Needs a Guide

- 40+ services use the Tailscale sidecar pattern requiring `TS_AUTHKEY` and `TS_DOMAIN`
- Both are now configurable via the web-admin and stored in Infisical, but there's no general user-facing documentation on how to _get_ them. The Tailscale-specific bits in `docs/TESTING.md` are testing-focused, not a general onboarding guide.
- A step-by-step Tailscale setup guide is needed for new users
- **The auth key MUST be created with the `tag:container` ACL tag.** Every container sidecar in this repo runs `--advertise-tags=tag:container`, and the Tailscale control plane rejects registration with `requested tags [tag:container] are invalid or not permitted` if the key isn't authorized for that tag. The user's tailnet ACL policy must also define `tag:container`. The key should be reusable so all 40+ sidecars can use the same one.

### ~~Pre-flight checks for Tailscale prerequisites~~ (DONE)

API-based preflight checks now run in all three places: `setup.sh` (required, runs before any container start), `all-containers.sh --start` (soft-skip if `TS_API_TOKEN` is missing from Infisical), and the web admin (live health panel on the Docker Status tab with a Re-check button). Checks cover: ACL `tag:container` declared, auth key reusable / has right tag / not expired. HTTPS Certificates toggle has no API — covered by the existing Step 13 HTTPS round-trip probe. Device quota has no billing API and the Personal plan removed the cap.

`TS_API_TOKEN` is now a required credential in `setup.sh` (prompted alongside `TS_AUTHKEY`), stored in Infisical `/shared/TS_API_TOKEN`, and editable via the web admin Configuration tab.

### Auth key expiry tracking

Expired Tailscale auth keys are a recurring pain point: the key works, then a container restarts weeks later and silently fails to re-register. A banner in the web admin warning "your auth key expires in N days" and/or a periodic healthchecks.io ping would catch this proactively instead of waiting for the failure. The preflight helper (`scripts/lib/tailscale-preflight.js`) already reads the key's `expires` field — this item is about surfacing that as a persistent, visible countdown rather than a one-shot check.

### External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

### ~~Host-Specific Project References~~ (DONE)

Replaced the hardcoded `~/Metatron` and `~/Kryten` references in `system-cron-startup.sh` with a generic `scripts/post-startup-hook.sh` hook (gitignored, runs after containers and web-admin are up). Personal startup calls now live in the hook file.

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

### ~~Git-Cloned Subprojects Are Excluded from Repo~~ (DONE)

Repo URLs, branches, and shallow-clone flags now live in `container-registry.yaml` under each container's `git_repos` field. `all-containers.sh --update-git-repos` reads the registry via `scripts/list-git-repos.js` and clones missing repos or pulls existing ones. Works standalone or combined with `--start`/`--stop`. `setup.sh` calls it before starting containers. Note: `dawarich/dawarich/` was a stale entry — dawarich uses pre-built images and doesn't need a clone.

### `AGENTS.md` and `CLAUDE.md` Are Developer-Facing, Not User-Facing

- These files help AI tools work with the repo but don't help human newcomers

---

## Further Notes

### ~~Need to fully remove 1Password CLI dependency~~ (DONE in repo)

Everything inside this repo is now Infisical-only: `kopia-backup-check.sh` and `setup-borg-backup.sh` were migrated, the `1password/` container entry and 54 orphan `1password_credential_paths.env` files were removed, and the bootstrap migration scripts (`migrate-1password-to-infisical.sh`, `migrate-to-registry.sh`, `generate-registry.js`) were deleted.

- Still on the user side (outside `~/containers`): other host-level tools that use 1Password should be migrated so the maintainer no longer needs `op` installed at all.

### Need a full README rewrite

The current README still tells users to manually clone, edit mounts, and run `all-containers.sh --start`, with no mention of `setup.sh` or the web admin. It should open with a quickstart along the lines of: "curl|bash `scripts/setup.sh` → open `http://<host>:3333` → Configuration tab → enable containers → start them" — and move the existing maintainer-specific notes lower.

### Caddy is there to host MY website specifically.

- Caddy is `default_disabled` but still embeds a hardcoded `lofland.com` healthcheck and a `voidship_ephemeral` mount.
- `caddy/mount-permissions.yaml:2` is also the only file in the repo that still hardcodes `/mnt/2000/...` (every other `mount-permissions.yaml` was converted to `${VOL_*}` in commit `cf101e1`). Will be addressed when caddy itself is dealt with — caddy is on the chopping block anyway, so a one-off conversion isn't worthwhile.
- Perhaps the public version just doesn't even include any caddy at all or any config?
- Or perhaps it has some helps on hosting one's own website?
- Either way my website shouldn't be included
- I wonder about the idea of "modules" as in, sets of containers that are not part of this repo, but can be chosen from some menu and told to pull in. Have them based on git repos and even allow private modules sets?
  - This could also allow breaking down this set into modules instead of ALL stacks here no matter what.
  - Should EACH stack be a "module"?!

### Several other PERSONAL stacks that are for Caddy to serve

- How do I retain those but not bother other people with them?

### Config embedded in mounts

- Some containers have a lot of their config buried in bind-mounted directories. New users get nothing in those dirs and the container either fails to start or starts useless.
- Homepage was the named example and is now solved via the dual-config pattern: `homepage/config-defaults/` (in git, what every user gets) merged with `homepage/config-personal/` (gitignored, per-host overrides) by `scripts/merge-homepage-config.js`, run as a pre-start hook from `scripts/all-containers.sh`. Apply the same pattern to any other container that hits this problem.

### Revisit homepage default groups, icons, and widgets

The `homepage/config-defaults/` files are opinionated about what a new user sees and will effectively be "forced on the public":

- The `Top` group in `config-defaults/services.yaml` (Web Admin, Tailscale Admin, do-it-self on GitHub) is a first draft. Established and working but worth revisiting once more users are onboard.
- The default `widgets.yaml` ships a greeting-with-FQDN + system resources + search + auto-injected storage widget. The greeting in particular is "just something in the slot" and could be replaced with something genuinely useful (weather with per-user coords, a real datetime widget, etc.) once a better idea surfaces.
- Icon choices (`/icons/do-it-self.svg` for Web Admin, others from the dashboard-icons library) should be reviewed for consistency.
- The maintainer's personal `settings.yaml` layout block hardcodes a 13-group ordering that new users don't benefit from; eventually the default layout should establish a sensible ordering without leaning on personal overrides.

Not urgent — first-pass defaults are landing with the homepage refactor and working. Revisit once the portability effort is closer to "public".

### Directing user to CLI instead of web admin

New users should be guided to the web UI as their default entry point, with the CLI kept as an "advanced" option. Two gaps remain:

- **README — still mixed.** Tracked under the "Need a full README rewrite" item above.
- **"Start All Enabled" button — still missing.** The web admin has an "Update All" endpoint but no equivalent for starting all enabled containers in one click. Until this exists, a user who follows setup.sh's advice and enables additional containers via the Configuration tab still has to drop to the CLI to bring them up.

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

- Have Claude do a thorough review of everything for "is this safe"?

## Nits

- The setup.sh tries to install packages even if they are already installed, is this necessary? A tiny check would avoid unnecessary root escalations.
- Could the setup.sh also know if it is in a non-interactive situation, check to see if it WILL need to escalate and bail if it is going to fail?
- While we are here, I notice when setup.sh is run on a pre-built system, it still always pulls down the infisical containers during the core service start. Why does that happen if infisical is literally already running?
- The web admin's isAvailable() check (infisicalClient.js:39) only verifies the credentials file is parseable — it does not test connectivity. So if the infisical container is down but ~/credentials/infisical.env exists, PUT /api/config/shared returns 500 (from the catch block) instead of the intended 503. This is pre-existing behavior — the OLD secrets-only guard had the same flaw — and the doc accepts the existing semantic. Worth a follow-up but not part of this work.
- How should I track/back up the parts of containers that are not part of the public repo, like personal homepage bits?
