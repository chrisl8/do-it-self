# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system. Items are in priority order — work top to bottom.

---

## 1. Modules system / personal stacks separation

**Full design document: [docs/MODULES.md](docs/MODULES.md)**

Phases 1-2 are implemented. Container stacks live in module repos cloned into `.modules/`, installed by copying to the platform root. CLI: `scripts/module.sh`. Container directories are no longer tracked in the platform git repo.

Current repos (2): `do-it-self-containers` (56 public) and `do-it-self-personal` (8 personal). Module sources are on Forgejo, mirrored to GitHub and Codeberg.

Remaining module work:

- ~~**Category cleanup**~~ — **Done.** Replaced single `category` slug with two new fields: `homepage_group` (freeform display name for dashboard grouping, injected via `${HOMEPAGE_GROUP}` env var) and `tags` (empty array, for future discovery UI). All 65 containers assigned to meaningful groups: Productivity, Finance, Development, Media, Tools, System Monitoring, Reading, Gaming, Desktop Apps, Infrastructure, Communication, Personal Projects. Removed the `categories:` registry section, `--category` CLI flag, and slug-to-label indirection. Tailscale node state moved out of ephemeral container dirs to `<mount[0]>/tailscale-state/<name>/` via `TS_STATE_HOST_DIR` env var.
- **Web admin UI** (Phase 3) — Browse/Sources pages for installing containers via the UI instead of CLI.
- **Side effects** (Phase 4) — `cron_jobs`, `host_packages`, `setup_hooks` in module.yaml.
- **Developer tooling** (Phase 5) — `dev-sync.sh` for syncing live edits back to module repos.

## 2. External Service Accounts Required

Several containers need external accounts that aren't documented in one place:

- healthchecks.io account and ping key (for `scripts/healthcheck.conf`)
- Cloudflare account with tunnel setup (for `cloudflared/`)
- WireGuard/VPN provider credentials (for recon/gluetun stack)
- Various service-specific API keys (Spotify, etc.)

These should be declared per-container in `module.yaml` (e.g. a `required_accounts` field) so users know what they need before enabling a container. Do this during module implementation.

## 3. External Backup Infrastructure Assumed

- BorgBackup assumes a remote server `backup-pi` accessible via SSH
- Kopia assumes its own remote backup target
- SSH keys at `/root/.ssh/borg-offsite` must be manually created
- `scripts/borg-backup.conf` hardcodes remote host and paths

This is acceptable for the maintainer but needs documentation or configurability for other users. Once backup containers are in their own module, document the setup requirements there.

## 4. Revisit homepage default groups, icons, and widgets

The `homepage/config-defaults/` files are opinionated first drafts:

- The `Top` group (Web Admin, Tailscale Admin, do-it-self on GitHub) — revisit once more users are onboard
- The default `widgets.yaml` greeting is "just something in the slot" — could be replaced with something useful
- Icon choices should be reviewed for consistency
- The maintainer's `settings.yaml` layout hardcodes a 13-group ordering that new users don't benefit from

Revisit once the module-based container set is finalized.

## 5. ~~config-defaults handler fails on container-owned files~~ — **Done.**

The generic `config-defaults` handler in `all-containers.sh` now does a `cmp -s` content check before copying: if the destination already matches the source, the copy is skipped entirely, so a container-owned file (e.g. CouchDB's `docker.ini`, UID 5984 in `obsidian-babel-livesync`) no longer trips a `Permission denied` on every restart. When the content genuinely differs and the `cp` fails, the handler prints an explicit yellow warning naming the file and container so the user knows a manual resync is needed — no more silent failure.

## 6. Document and/or automate maintenance tasks

- Rebooting procedure
- Patching and rebooting
- What else needs documenting?

## 7. Testing improvements

- Add info to TESTING.md about how to add yourself to the test tailnet to fully test
- Add output to the test that provides clickable links to the testing site
- Add automated tests to ensure tailnet sites are responding to traffic
- Add a "pause" option to the Hetzner test so it waits for manual testing before destroying

Test the final module-based architecture end-to-end.

## 8. Security review

Have Claude do a thorough review of the entire codebase for security issues. Should be done after the code is stable and tested, before going public.

---

## Documentation (DO LAST — write about the final product)

### 9. Tailscale Setup Guide

40+ services use the Tailscale sidecar pattern. `docs/TESTING.md` covers the prerequisites but is testing-focused, not a general onboarding guide. New users need a step-by-step guide: create a tailnet, configure ACL with `tag:container`, enable HTTPS Certificates, generate auth key (reusable, tagged) and API token. Write alongside the README rewrite.

### 10. README rewrite

The current README still tells users to manually clone, edit mounts, and run `all-containers.sh --start`, with no mention of `setup.sh` or the web admin. The README needs two distinct sections:

1. **How to set this up** — Quickstart: `curl|bash setup.sh` → open web admin → browse available containers → install and enable → Start All Enabled. This is what a new user reads.

2. **How and why this works the way it does** — Architecture overview: the module/catalog system, why container folders are ephemeral, the three-layer config merge, the Tailscale sidecar pattern, how credentials flow through Infisical. This is what someone reads before deciding to trust and adopt the platform, or before contributing.

Move maintainer-specific notes lower.

### 11. AGENTS.md and CLAUDE.md are developer-facing

These files help AI tools work with the repo but don't help human newcomers. Update after the product is final so they accurately describe the system.
