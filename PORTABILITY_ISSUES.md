# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system. Items are ordered by effort and priority: small fixes first, large design work later, documentation last.

---

## Small (hours each)

### ~~Auth key expiry tracking~~ (DONE)

Three channels: (1) preflight helper returns `expiresInDays` and adds an advisory "Auth key expiry" warning when < 14 days, (2) `system-health-check.sh` parses it and pings healthchecks.io `/fail` so the user gets notified even off the dashboard, (3) web admin shows a persistent orange banner on both Docker Status and Configuration tabs with a "Renew key" link.

### ~~setup.sh polish~~ (DONE)

Upfront sudo check, skip base packages when installed, skip Infisical setup when already running, fixed step numbering, removed redundant package installs, updated next-steps text to mention web admin button, eliminated double preflight run.

### ~~Web admin Infisical connectivity check~~ (DONE)

`isAvailable()` now makes a real GET to the Infisical API with a 5-second timeout, cached 30s/5s (success/failure). PUT /api/config/shared correctly returns 503 when Infisical is down.

### ~~Personal content backup strategy~~ (NON-ISSUE)

Borg already backs up `~/` which includes all gitignored personal files (user-config.yaml, compose.override.yaml, config-personal/, etc.). For other users: integrating borg backup into setup.sh (so every install gets backups out of the box) is a post-README "phase 2" item. The README should mention that host-level backups cover personal config.

---

## Medium (a day each)

### External Service Accounts Required

Several containers need external accounts that aren't documented in one place:

- healthchecks.io account and ping key (for `scripts/healthcheck.conf`)
- Cloudflare account with tunnel setup (for `cloudflared/`)
- WireGuard/VPN provider credentials (for recon/gluetun stack)
- Various service-specific API keys (Spotify, etc.)

These should be documented per-container (in the registry or a doc) so users know what they need before enabling a container.

### ~~Config embedded in mounts~~ (DONE)

Audit found 3 containers (filez, the-lounge, obsidian-babel-livesync) with config files missing on fresh clone. All now ship `config-defaults/` with sensible defaults. A generic pre-start hook in `all-containers.sh` copies defaults to the mount target, with `config-personal/` (gitignored) taking precedence. Homepage keeps its specialized YAML merge script. 61 other containers needed no changes.

### External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

This is acceptable for the maintainer but needs documentation or configurability for other users.

### Testing improvements

- Add info to TESTING.md about how to add yourself to the test tailnet to fully test
- Add output to the test that provides clickable links to the testing site
- Add automated tests to ensure tailnet sites are responding to traffic
- Add a "pause" option to the Hetzner test so it waits for manual testing before destroying

### Document and/or automate maintenance tasks

- Rebooting procedure
- Patching and rebooting
- What else needs documenting?

### Revisit homepage default groups, icons, and widgets

The `homepage/config-defaults/` files are opinionated first drafts:

- The `Top` group (Web Admin, Tailscale Admin, do-it-self on GitHub) — revisit once more users are onboard
- The default `widgets.yaml` greeting is "just something in the slot" — could be replaced with something useful
- Icon choices should be reviewed for consistency
- The maintainer's `settings.yaml` layout hardcodes a 13-group ordering that new users don't benefit from

Not urgent — revisit once closer to "public."

---

## Large (multi-day design + implementation)

### Modules system / personal stacks separation

**Full design document: [docs/MODULES.md](docs/MODULES.md)**

Module repos (git repos containing Docker Compose stacks + metadata) are cloned into a persistent `.modules/` catalog directory. Individual containers are **installed** by copying their folder from `.modules/` to the platform root, and **uninstalled** by deleting that folder. Container folders are ephemeral — all persistent data lives in `~/container-mounts/`, `~/credentials/`, and `user-config.yaml`, so uninstall is a clean `rm -rf` with no data loss.

This pattern (persistent catalog, copy-to-activate, separate data) is well-established: Runtipi and Umbrel use it for Docker app management, Nix uses it for system packages, GNU Stow uses it for dotfiles.

The platform root stays clean — only actively-used containers appear as top-level folders. The web admin gets reorganized: My Containers (installed), Browse (available from `.modules/`), and Sources (manage module repos).

Implementation phases: module infrastructure, repo split, web admin UI, side effects (cron/host-deps), developer tooling.

### Security review

Have Claude do a thorough review of the entire codebase for security issues. Should be done before going public.

---

## Documentation (DO LAST — write about the final product)

### Tailscale Setup Guide (second-to-last)

40+ services use the Tailscale sidecar pattern. `docs/TESTING.md` covers the prerequisites but is testing-focused, not a general onboarding guide. New users need a step-by-step guide: create a tailnet, configure ACL with `tag:container`, enable HTTPS Certificates, generate auth key (reusable, tagged) and API token. Write alongside the README rewrite.

### README rewrite (last)

The current README still tells users to manually clone, edit mounts, and run `all-containers.sh --start`, with no mention of `setup.sh` or the web admin. The README needs two distinct sections:

1. **How to set this up** — Quickstart: `curl|bash setup.sh` → open web admin → browse available containers → install and enable → Start All Enabled. This is what a new user reads.

2. **How and why this works the way it does** — Architecture overview: the module/catalog system, why container folders are ephemeral, the three-layer config merge, the Tailscale sidecar pattern, how credentials flow through Infisical. This is what someone reads before deciding to trust and adopt the platform, or before contributing.

Move maintainer-specific notes lower.

### AGENTS.md and CLAUDE.md are developer-facing

These files help AI tools work with the repo but don't help human newcomers. Update after the product is final so they accurately describe the system.

---

## Completed

Items kept for historical context. Collapsed summaries only.

### ~~Pre-flight checks for Tailscale prerequisites~~ (DONE)

API-based preflight checks now run in setup.sh (required), all-containers.sh (soft-skip), and the web admin (health panel). Checks ACL tag, auth key reusable/tagged/expired. HTTPS has no API — covered by Step 13 HTTPS probe.

### ~~1Password CLI dependency~~ (DONE)

Everything in-repo is Infisical-only. 54 orphan env files, migration scripts, and the 1password container entry removed. Host-side tools outside `~/containers` still need migration.

### ~~Host-Specific Project References~~ (DONE)

Replaced with generic `scripts/post-startup-hook.sh` (gitignored).

### ~~Host Package Dependencies~~ (MOSTLY DONE)

setup.sh installs all needed packages including yq. Passwordless sudo auto-configured. GPU config moved to gitignored compose.override.yaml. BorgBackup stays in its separate setup script.

### ~~Cron Jobs~~ (DONE for core system crons)

setup.sh auto-installs @reboot startup, health check, and kopia check. Borg crons handled by setup-borg-backup.sh. Container-specific crons deferred to modules.

### ~~Git-Cloned Subprojects~~ (DONE)

Registry's `git_repos` field + `all-containers.sh --update-git-repos`.

### ~~Start All Enabled button~~ (DONE)

Web admin Docker Status tab: starts every enabled, ready, stopped container in start_order.

### ~~Directing user to web admin~~ (PARTIALLY DONE)

Start All Enabled button shipped. README still directs to CLI — tracked under README rewrite.
