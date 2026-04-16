# Portability Issues for New Users

This document catalogs issues that would affect someone cloning this repository and trying to use it on their own system. Items are in priority order — work top to bottom.

---

## 1. Modules system / personal stacks separation

**Full design document: [docs/MODULES.md](docs/MODULES.md)**

Phases 1-2 are implemented. Container stacks live in module repos cloned into `.modules/`, installed by copying to the platform root. CLI: `scripts/module.sh`. Container directories are no longer tracked in the platform git repo.

Current repos (2): `do-it-self-containers` (56 public) and `do-it-self-personal` (8 personal). Module sources are on Forgejo, mirrored to GitHub and Codeberg.

Remaining module work:

- ~~**Category cleanup**~~ — **Done.** Replaced single `category` slug with two new fields: `homepage_group` (freeform display name for dashboard grouping, injected via `${HOMEPAGE_GROUP}` env var) and `tags` (empty array, for future discovery UI). All 65 containers assigned to meaningful groups: Productivity, Finance, Development, Media, Tools, System Monitoring, Reading, Gaming, Desktop Apps, Infrastructure, Communication, Personal Projects. Removed the `categories:` registry section, `--category` CLI flag, and slug-to-label indirection. Tailscale node state moved out of ephemeral container dirs to `<mount[0]>/tailscale-state/<name>/` via `TS_STATE_HOST_DIR` env var.
- ~~**Web admin UI** (Phase 3)~~ — **Done.** Browse and Sources pages implemented in the web admin for installing, uninstalling, and managing module sources via the UI.
- ~~**Side effects** (Phase 4)~~ — **Done.** Containers can declare `cron_jobs`, `host_packages`, and `setup_hooks` in module.yaml. Cron entries are tagged and managed automatically on enable/disable/uninstall. Host packages produce warnings with install commands. Setup hooks run once and track completion in installed-modules.yaml. Helpers: `manage-cron-jobs.js`, `check-host-packages.js`, `run-setup-hooks.js`.
- ~~**Developer tooling** (Phase 5)~~ — **Done.** `module.sh dev-sync` subcommand (with `scripts/dev-sync.sh` wrapper) syncs live edits back to module repos using rsync with content-based comparison. Auto-detects module from registry, excludes platform-specific files, shows diff, prompts for commit/push. `--yes` flag for scripting.

## 2. External Service Accounts Required

~~Several containers need external accounts that aren't documented in one place.~~ **Infrastructure done.** The `required_accounts` field exists in `container-registry.yaml` (with `name`, `url`, `why`, and `populates` subfields) and the Browse page in the web admin displays them per-container.

All containers that need external accounts now have `required_accounts` entries: cloudflared, factorio, recon, secure-browser, starbound, wallabag, and your-spotify. Most containers are fully self-hosted and don't require any external accounts.

## 3. ~~External Backup Infrastructure Assumed~~ — **Done.**

`scripts/borg-backup.conf` is now gitignored and created from a tracked `scripts/borg-backup.conf.example` template on first run. All hardcoded paths (local repo, db-dump dir, backup paths, remote repo, container mount dirs) are configurable via the conf. SQLite dump paths in `borg-db-dump.sh` resolve dynamically via `BORG_CONTAINER_MOUNT_DIRS`. Exclude patterns in `borgbackup/exclude-patterns.txt` use globs instead of mount-specific absolute paths. `borgbackup/RECOVERY.md` references conf variables instead of hardcoded hostnames and paths. Setup guide: `borgbackup/SETUP.md`. Kopia was already configurable via its registry variables.

## 4. ~~Revisit homepage default groups, icons, and widgets~~ — **Done.**

Reviewed all 12 `homepage_group` values — names are generic and universal, no changes needed. Added a default layout to `homepage/config-defaults/settings.yaml` that orders all 13 groups (Top + 12 homepage_groups) logically: daily-use groups first (Productivity, Finance, Communication, Reading, Media), then utility/entertainment (Gaming, Desktop Apps, Tools, Development, Personal Projects), then ops (System Monitoring, Infrastructure). Added sensible styling defaults: `target: _self`, `headerStyle: boxedWidgets`, `statusStyle: basic`. Widgets and icons were already in good shape — `${HOST_NAME}.${TS_DOMAIN}` greeting is informative, and icons consistently use the dashboard-icons library with custom icons only where needed.

## 5. ~~config-defaults handler fails on container-owned files~~ — **Done.**

The generic `config-defaults` handler in `all-containers.sh` now does a `cmp -s` content check before copying: if the destination already matches the source, the copy is skipped entirely, so a container-owned file (e.g. CouchDB's `docker.ini`, UID 5984 in `obsidian-babel-livesync`) no longer trips a `Permission denied` on every restart. When the content genuinely differs and the `cp` fails, the handler prints an explicit yellow warning naming the file and container so the user knows a manual resync is needed — no more silent failure.

## ~~6. Document and/or automate maintenance tasks~~ — **Done.**

`docs/MAINTENANCE.md` covers: automated cron jobs (startup, health checks, backup freshness), graceful reboot/halt procedure, OS patching workflow, NVIDIA driver recovery after kernel updates, DIUN-based container image updates, troubleshooting (unhealthy containers, web admin, Tailscale), and optional config files.

## ~~7. Testing improvements~~ — **Done.**

`docs/TESTING.md` covers tailnet setup (creating a test tailnet, ACL config, HTTPS certs, auth keys/API tokens). `hetzner-test.sh --browse` opens a SOCKS5 proxy, prints all test site URLs, and waits for Enter before teardown (`--keep` skips destroy entirely). HTTPS smoke tests run against a subset of containers (full coverage blocked by LE ACME rate limit — 10 registrations/IP/3h). `test-fresh-install.sh` exercises the full module-based architecture end-to-end: module install, container enable via web admin API, startup, health checks, and cron side effects.

## ~~8. Security review~~ — **Done.**

Three-pass audit covering shell scripts, web admin (Express/React), and Docker Compose/credential handling. Fixes applied:

- **Critical:** Bash injection in web admin's kopia-ignore-hosts endpoint (hostname validation added)
- **High:** All .env files were world-readable (0664); generate-env.js now writes mode 0600, existing files remediated
- **High:** Hardcoded DB passwords in paperless and formbricks compose files replaced with `${VAR}` references + Infisical integration
- **High:** `eval` in all-containers.sh mount path expansion replaced with safe bash regex loop
- **High:** Unquoted variable interpolation in hetzner-test.sh `node -e` fixed (now uses process.env)
- **High:** Python code injection in resolve_to_absolute replaced with `realpath`
- **Medium:** Predictable /tmp state files in health check moved to `~/.local/state/containers/`
- **Medium:** Default password fallback in borg-db-dump.sh removed (now skips dump + increments error count)
- **Medium:** GitHub release notes HTML sanitized with DOMPurify
- **Medium:** Kopia `--disable-csrf-token-checks` removed

Dismissed: web admin "no auth" (Unix socket + filesystem permissions IS the auth model), Docker socket mounts for monitoring tools (by-design), root containers (image requirement), 0.0.0.0 port bindings (intentional LAN access). Remaining `eval` calls use standard tool patterns (`fnm env`, `infisical export --format=dotenv-export`).

---

## Documentation (DO LAST — write about the final product)

### ~~9. Tailscale Setup Guide~~ — **Done.**

`docs/TAILSCALE.md` covers: why Tailscale, step-by-step tailnet configuration (ACL tag, HTTPS certificates, auth key, API token), what setup.sh automates, credential flow from Infisical to containers, networking patterns (links to README), health checks, and troubleshooting table with diagnostic commands. Duplicated setup steps removed from `docs/TESTING.md` (replaced with a link). Cross-references in `setup.sh` and `README.md` updated.

### ~~10. README rewrite~~ — **Done.**

`README.md` rewritten top-to-bottom. New structure: one-paragraph intro with mirror links → **Quickstart** (`curl|bash setup.sh`, then web admin tab walkthrough ending with "Start All Enabled") → **Prerequisites** (points at `docs/TAILSCALE.md` for the heavy details) → **Architecture** (modules + catalog, ephemeral container dirs, three-layer config merge, Tailscale sidecar pattern with ASCII diagram and a trimmed `homepage/compose.yaml` example, networking options, Infisical credential flow) → **Day-2 operations** (link to `docs/MAINTENANCE.md`) → **Testing** (link to `docs/TESTING.md`) → **Contributing** → **Answers to Questions Nobody Asked** (preserved verbatim) → **License**. Dropped ~800 lines of bare-metal host notes (Samba, Postfix, DuckDNS, APC UPS, Rustdesk, SMART, etc.) that were personal install history rather than platform instructions — `setup.sh` covers everything actually required.

Also verified the web admin's "Start All Enabled" button (which the Quickstart tells users to click) works end-to-end by adding `scripts/lib/start-all-via-ws.js` — a helper that drives the same WebSocket path the Dashboard tab uses — and wiring it into `scripts/test-fresh-install.sh` in place of the previous direct `all-containers.sh --start` call. Assertion fails if any stack lands in `failed[]`.

### ~~11. AGENTS.md and CLAUDE.md are developer-facing~~ — **Done.**

`AGENTS.md` rewritten to match the current architecture. Previous version referenced deleted scripts (`enable-all-containers.sh` / `disable-all-containers.sh`), claimed `restart: unless-stopped` (actual convention is `on-failure` to avoid cron-startup collisions), pointed at a stale Tailscale state path, and said nothing about the modules system, ephemeral container dirs, `user-config.yaml`, `mount-permissions.yaml`, `.start-order`, or the `VAR=${VAR}` + Infisical credential flow. New version mirrors `CLAUDE.md`'s architecture shape and keeps AGENTS.md's stronger command recipes and code-style specifics. Every file path, script, flag, and `module.sh` subcommand verified against the filesystem. `CLAUDE.md` audited for drift since Apr 11 — `load_secret()` line range, `all-containers.sh` flags, and `module.sh` subcommands all still match, so no edits were needed.

### 12. Deploy rigor

Put some rigor around deploying new updates to git once we have a working system that someone else is using.

--- Other Completed ---

- ~~Possibly add some notices in the web admin to let the developer know if there are uncommitted changes in the main or module folders.~~ **Done.** Sources page shows a warning banner when the platform repo or any module repo has uncommitted changes, with per-repo file lists and a Dev-sync button for modules.
- ~~Review all code and scripts for issues, run linters, etc. before final "it is done", especially to catch all of those, "this issue was from a previous session"~~ **Done.** Shellcheck clean at warning level across all scripts. All JS passes syntax check. Fixes: WebSocket JSON.parse crash guard, spawn error handlers for stack restart/upgrade, unhandled promise rejections in queue processors, input validation on module/container name params, childEnv() on kopia-check and apcaccess spawns, shell injection fix in module-helper.js git commit (execFileSync), unused loop var in setup.sh, array-based chmod/chown commands in all-containers.sh, direct exit code check in graceful-shutdown.sh.
