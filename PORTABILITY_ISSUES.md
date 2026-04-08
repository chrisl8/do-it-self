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
- `scripts/kopia-backup-check.sh:41-58` still has a 1Password fallback path.
- **54 containers** still ship a `1password_credential_paths.env` file (run `find . -name 1password_credential_paths.env` for the current list). These are unused on Infisical-based deploys but should be removed for clarity.
- Other tools on the host (outside `~/containers`) that use 1Password should be migrated so the final "deploy" doesn't need to include the 1Password container at all.

### Consolidate shared variables to Infisical-only

The `shared:` block in `user-config.yaml` (`TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`) is currently dual-written to both `user-config.yaml` and Infisical `/shared` by the web admin's save handler at `web-admin/backend/src/server.js` `PUT /api/config/shared`. Two sources of truth, free to drift the moment anyone edits one without going through the web admin. `TS_AUTHKEY` was the same kind of wart and is already fixed (Infisical-only). The same cleanup should be applied to the non-secret shared variables so all four behave the same way.

See [docs/shared-vars-consolidation.md](docs/shared-vars-consolidation.md) for the full design and step-by-step plan. The doc is self-contained — a fresh Claude session can pick it up and execute it without needing the conversation history that produced it.

### Need a full README rewrite

The current README still tells users to manually clone, edit mounts, and run `all-containers.sh --start`, with no mention of `setup.sh` or the web admin. It should open with a quickstart along the lines of: "curl|bash `scripts/setup.sh` → open `http://<host>:3333` → Configuration tab → enable containers → start them" — and move the existing maintainer-specific notes lower.

### Caddy is there to host MY website specifically.

- Caddy is `default_disabled` but still embeds a hardcoded `lofland.com` healthcheck and a `voidship_ephemeral` mount.
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

### Audit remaining containers for hardcoded mount paths

The `apply_mount_permissions` resolver in `scripts/all-containers.sh` now supports `${VOL_*}` variable expansion and `mkdir -p`s missing paths (commit `cf101e1`). `searxng`, `nextcloud`, `wallabag`, and `cloudflared` have all been converted. A full audit of every `mount-permissions.yaml` in the repo found **only one remaining offender**: `caddy/mount-permissions.yaml:2` still hardcodes `/mnt/2000/container-mounts/caddy/site/my-digital-garden/dist`. This will be addressed by the "Caddy is there to host MY website specifically" item below — caddy is on the chopping block anyway, so a one-off conversion isn't worthwhile.

### Directing user to CLI instead of web admin

New users should be guided to the web UI as their default entry point, with the CLI kept as an "advanced" option. Status:

1. **`setup.sh` final instructions — done** (commit `9bfb731`). `scripts/setup.sh` now prints next-steps that point at the web admin, the Configuration tab, and the Start button.
2. **README — still mixed.** `README.md` still tells users to manually clone, edit mounts, and run `all-containers.sh --start`. Tracked under the "Need a full README rewrite" item above.
3. **"Start All Enabled" button — still missing.** The web admin has an "Update All" endpoint (`web-admin/backend/src/server.js:947`) but no equivalent for starting all enabled containers in one click. Until this exists, a user who follows setup.sh's advice and clicks into the Configuration tab still has to drop to the CLI to actually bring everything up.

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

- ~~The newly setup host exposes its web admin page on the public IP to everyone with no authentication.~~ **Fixed.** The web-admin backend has no host TCP listener at all by default. It listens on a Unix domain socket at `web-admin/backend/sockets/web-admin.sock` (chmod 0660). The only network ingress is a Tailscale Serve sidecar at `web-admin/compose.yaml` which bind-mounts that socket directory and proxies `https://admin.<tailnet>.ts.net` to `unix:/sockets/web-admin.sock`. Filesystem permissions on the socket file are the access control: nothing on the LAN, the public internet, any other tailnet device, or any other docker container can reach the backend except via that sidecar. This matches the rest of the repo's pattern (Tailscale is the auth boundary, no per-service login needed). An earlier iteration of this fix tried `HOST=127.0.0.1` + `host.docker.internal:host-gateway` from the sidecar, on the (incorrect) assumption that `host-gateway` would route to loopback; in practice it routes to the docker bridge IP, which a 127.0.0.1-bound process doesn't listen on. `scripts/setup.sh` Step 13 and `scripts/test-fresh-install.sh` now run end-to-end checks (socket exists, sidecar bind-mounts it, TS Serve proxy points at the unix target, real HTTPS round-trip to `https://admin.<tailnet>` succeeds) so this class of break is caught at install time. `TS_AUTHKEY` is a hard prerequisite of the whole project, but `setup.sh` no longer demands it as an env var on every run — it accepts the key via env var (for automation), prompts for it interactively when run from a TTY (first-time human installs), or fetches it back from Infisical on subsequent runs. The key is stored in Infisical at `/shared/TS_AUTHKEY` only, never on disk in plaintext.
- Have Claude do a thorough review of everything for "is this safe"?
