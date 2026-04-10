# Module System Design

This document describes the module system for the do-it-self container platform: what it is, why it exists, how it works, and how to implement it.

## Prior art and inspiration

This design did not emerge in a vacuum. Several existing systems use the same core pattern (persistent local catalog, copy-to-activate, separate data storage):

- **Runtipi** — Self-hosted app platform. Clones app-store repos into `repos/`, copies individual apps to `apps/` for installation, keeps runtime data in `app-data/`. Uninstall deletes from `apps/`; catalog persists in `repos/`. Essentially identical to this design.
- **Umbrel** — Self-hosted app store. Syncs app-store repos to a local `app-stores/` directory, copies to activate. Same pattern at scale.
- **Nix/NixOS** — Package manager. `/nix/store` is an immutable content-addressed catalog; profiles create symlinked environments referencing items from the store. The purest implementation of this pattern in the package management world.
- **GNU Stow** — Symlink farm manager. The original "catalog directory to target directory" tool. Stow directory holds packages; `stow` creates symlinks in the target. We copy instead of symlink, but the concept is identical.
- **Homebrew** — macOS package manager. Cellar holds versioned packages; symlinks activate them into `/usr/local/bin`.

We don't use any of these directly. Runtipi and Umbrel are complete platforms that would replace our orchestration layer, Tailscale integration, and web admin. Nix and Stow are general-purpose tools, not Docker Compose managers. But the architectural pattern they all converged on — **immutable catalog, ephemeral activation, separate persistent data** — is well-proven and is the foundation of this design.

## Why modules?

The platform repo currently ships 66 container stacks alongside the platform code (scripts, web admin, setup). This creates several problems:

**Ownership confusion.** The platform repo contains personal stacks (the maintainer's website, game servers, personal tools) mixed with generally-useful services (Jellyfin, Nextcloud, Paperless). New users cloning the repo get someone else's personal config, and the maintainer can't remove personal stacks without breaking users who might have enabled them.

**Perpetual growth.** Every experiment, every new service tried and abandoned, stays in the repo forever. Removing a container risks breaking someone's install. The repo becomes a graveyard of dormant compose files that nobody maintains but nobody can delete.

**No contribution path.** If someone wants to add a new container, they have to PR it into the main repo. The maintainer becomes the bottleneck reviewer for every new service, even niche ones they'll never use.

**Bundled side effects.** Some containers need host-level resources beyond `docker compose up` — cron jobs, host packages, external git repos, setup hooks. Today these are either hardcoded in `all-containers.sh` or require manual setup. A module system bundles these side effects with the container definition so they're installed/removed atomically.

## What is a module?

A module is a git repository containing one or more container stacks plus metadata describing what those containers need. Modules are cloned into a persistent local catalog (`.modules/`). Individual containers from a module can be installed (copied to the platform root) independently of other containers in the same module.

A module repo looks like:

```
do-it-self-media/
  module.yaml           # metadata: what containers this module provides
  jellyfin/
    compose.yaml
    config-defaults/
    tailscale-config/
    .start-order
  immich/
    compose.yaml
    ...
  your-spotify/
    compose.yaml
    ...
```

And its `module.yaml`:

```yaml
name: do-it-self-media
description: Media services (Jellyfin, Immich, Spotify, Seerr)
maintainer: chrisl8
url: https://github.com/chrisl8/do-it-self-media.git

containers:
  jellyfin:
    description: Media server with live TV and DVR
    category: media
    uses_tailscale: true
    start_order: "010"
    volumes:
      config:
        var: VOL_JELLYFIN_CONFIG
        host_subpath: container-mounts/jellyfin/config
        container_path: /config
    # ... full registry entry for this container

  immich:
    description: Self-hosted photo and video backup
    category: media
    uses_tailscale: true
    start_order: "010"
    # ...
```

## Core architectural invariant

**Container folders are ephemeral.** A container's folder at the platform root (`~/containers/jellyfin/`) contains only compose configuration and platform metadata — never user state. All persistent data lives elsewhere:

| What | Where | Survives uninstall? |
|------|-------|---------------------|
| Volume data | `~/container-mounts/<name>/` | Yes |
| Credentials | `~/credentials/<name>.env` | Yes |
| User overrides (enable/disable, variables) | `user-config.yaml` | Yes |
| Compose file, config-defaults, tailscale-config | `~/containers/<name>/` | **No — deleted on uninstall** |

This means uninstalling a container is a simple `rm -rf` of its folder. No confirmation prompt, no "keep config?" dialog. If the user reinstalls later, `user-config.yaml` still has their settings and volume data is untouched. The compose files are trivially re-copied from the module catalog.

All future development must preserve this invariant. Never store user-created state inside a container's folder. If a container needs user-customizable config files, use `config-personal/` (which is backed up by borg as part of `~/`) — but even that is a convenience copy, not the source of truth.

## The `.modules/` catalog

Module repos are cloned into `.modules/` at the platform root:

```
~/containers/
  .modules/                              # persistent local catalog (gitignored)
    do-it-self-media/                    # git clone of the media module
      .git/
      module.yaml
      jellyfin/
      immich/
      your-spotify/
      seerr/
    do-it-self-tools/                    # git clone of the tools module
      .git/
      module.yaml
      portainer/
      searxng/
      stirling-pdf/
      ...
  jellyfin/                              # installed (copied from .modules/)
  searxng/                               # installed
  scripts/                               # platform code (in git)
  web-admin/                             # platform code (in git)
  ...
```

The `.modules/` directory is:
- **Gitignored** by the platform repo
- **Persistent** — survives reboots, stays between sessions
- **Updated** via `git pull` inside each clone (not re-cloned from scratch)
- **Read-only in normal operation** — only module install/update scripts write here

The platform root stays clean: only containers the user has actively installed appear as top-level folders.

## Container lifecycle

A container moves through four states:

| State | Meaning | Analogy |
|-------|---------|---------|
| **Available** | Exists in a cloned module under `.modules/` | `apt list` shows it |
| **Installed** | Folder copied to platform root, container is configured | `apt install` — files on disk |
| **Enabled** | Container will start with `all-containers.sh --start` | `systemctl enable` |
| **Running** | Container is currently up | `systemctl status` |

### Adding a module source

1. User provides a git URL (from the catalog or manually)
2. `git clone` into `.modules/<module-name>/`
3. Record the module name, URL, and commit hash in `installed-modules.yaml`
4. The module's containers are now **available** — visible in the web admin's Browse page but not installed

### Installing a container

1. User clicks "Install" on a container in the Browse page (or runs a CLI command)
2. Copy the container's directory from `.modules/<module-name>/<container>/` to `~/containers/<container>/`
3. Merge the container's `module.yaml` entry into `container-registry.yaml`
4. The container is now **installed** — appears in My Containers, defaults to disabled
5. If the container has `host_packages`, check/install them
6. If the container has `setup_hooks`, run them

### Enabling a container (unchanged from today)

1. User toggles the switch in the web admin or edits `user-config.yaml`
2. On next `all-containers.sh --start`, the container starts
3. If the container has `cron_jobs`, they're installed

### Disabling a container (unchanged from today)

1. User toggles the switch off
2. Container stops on next `--start` or `--stop` run
3. Cron jobs removed if any
4. Container folder stays on disk — quick re-enable without reinstalling

### Uninstalling a container

1. If running, stop it
2. Remove cron jobs if any
3. Delete the container directory from the platform root
4. Remove the container's entry from `container-registry.yaml`
5. Volume data, credentials, and `user-config.yaml` entries are **not touched**

### Updating a module

1. `git -C .modules/<module-name> pull`
2. Compare the new HEAD against the recorded commit hash
3. For each **installed** container in the module:
   - Copy updated files from `.modules/` to `~/containers/` (compose.yaml, config-defaults/, tailscale-config/, etc.)
   - Preserve `config-personal/` (never overwritten — user's personal overrides)
   - Preserve `compose.override.yaml` (never overwritten — hardware-specific)
   - Preserve `.env` (regenerated by `generate-env.js`, not from the module)
4. Regenerate `container-registry.yaml` from the updated `module.yaml`
5. Update the commit hash in `installed-modules.yaml`
6. Restart any running containers whose compose.yaml changed

Available-but-not-installed containers are updated automatically (they live in the clone).

### Removing a module source

1. For each installed container from this module: uninstall it (with warning about running containers)
2. `rm -rf .modules/<module-name>/`
3. Remove from `installed-modules.yaml`

## Three-layer configuration merge

The platform resolves container configuration by merging three layers:

1. **Module's `module.yaml`** — the author's defaults. Defines what the container IS: its description, category, volumes, variables, default_disabled state, tailscale usage, cron jobs, host dependencies.

2. **`container-registry.yaml`** — generated by the platform by merging all installed containers' metadata from their modules. This is the merged view that the web admin, `generate-env.js`, and `all-containers.sh` read. Regenerated on every install/update/uninstall. Users should not hand-edit this file.

3. **`user-config.yaml`** — the user's overrides. Defines how they USE the container: enabled/disabled, variable values, volume mount assignments, category overrides, any field they want to customize. User-controlled, never overwritten by module updates.

This is how the system already works for `enabled` and `variables`. The module system extends it so the base registry comes from modules instead of a hand-edited file.

## Personal containers

Users can create containers directly in `~/containers/` without any module. They create a directory with a `compose.yaml`, then either:
- Add a registry entry via the web admin's "Add Custom Container" UI
- Or manually add an entry to `user-config.yaml`

Personal containers have `source: personal` in the registry and are never touched by module install/update/uninstall.

## Module catalog

The platform ships a `module-catalog.yaml` listing known module repos:

```yaml
catalogs:
  do-it-self-core:
    url: https://github.com/chrisl8/do-it-self-core.git
    description: Core platform services (Infisical, Homepage, Kopia, MariaDB)
    required: true

  do-it-self-productivity:
    url: https://github.com/chrisl8/do-it-self-productivity.git
    description: Productivity apps (Nextcloud, Paperless, Forgejo, Kanboard, etc.)

  do-it-self-media:
    url: https://github.com/chrisl8/do-it-self-media.git
    description: Media services (Jellyfin, Spotify, Seerr, Immich)

  do-it-self-tools:
    url: https://github.com/chrisl8/do-it-self-tools.git
    description: Utility containers (Portainer, Searxng, Stirling-PDF, etc.)

  do-it-self-monitoring:
    url: https://github.com/chrisl8/do-it-self-monitoring.git
    description: System monitoring (Beszel, Netdata, Uptime Kuma, Speedtest, Diun)

  do-it-self-desktop:
    url: https://github.com/chrisl8/do-it-self-desktop.git
    description: Desktop apps via browser (Code Server, Obsidian, MAME, RetroArch)

  do-it-self-network:
    url: https://github.com/chrisl8/do-it-self-network.git
    description: Network services (Cloudflared, Pi-hole, VPN/Recon, Meshtastic)

  do-it-self-social:
    url: https://github.com/chrisl8/do-it-self-social.git
    description: Communication and social (The Lounge, FreshRSS, Wallabag, Ghost)
```

Users can add their own catalog entries (community modules, private repos). The web admin's Sources page manages catalog entries.

### Repo count guidance

The catalog above shows 8 repos, split by category. This is a reasonable starting point, but the exact number doesn't matter much — modules live in `.modules/` and users never interact with the repo structure directly. Start with fewer larger repos and split later if needed. Splitting one repo into two is easy; consolidating many into fewer is painful.

The minimum viable split is 2 repos: one public (all generally-useful containers) and one private (the maintainer's personal stacks). The category split can happen later based on actual usage patterns.

### Proposed category split

The current 66 containers split roughly as:

**core** (always installed, 3-4 containers): infisical, homepage, kopia, mariadb

**productivity** (~10): nextcloud, nextcloud-whiteboard, paperless, forgejo, actual-budget, actual-budget-api, actual-budget-sync, kanboard, karakeep, trilium, formbricks

**media** (~5): jellyfin, your-spotify, seerr, immich

**tools** (~8): portainer, searxng, stirling-pdf, vaultwarden, paste, filez, adminer, homarr

**monitoring** (~6): beszel, netdata, uptime, speedtest, diun, borgitory

**desktop** (~6): code, obsidian, mame, retroarch, secure-browser, quicken

**network** (~6): cloudflared, pihole, recon, meshtastic, tsidp, pure-ftpd

**social** (~6): the-lounge, freshrss, wallabag, changedetection, dawarich

**backup** (~3): borgbackup, kopia-tr0n (separate from core kopia)

**personal** (maintainer's private repo): caddy, witchazzan, spacymote, geomyidae, crater-manipulator, voidship-ephemeral, obsidian-babel-livesync

Some containers don't fit neatly and will need judgment calls. The exact split is finalized during implementation.

## Web admin changes

The web admin gets reorganized around the module lifecycle:

### My Containers (replaces current Configuration tab scope)

Shows only **installed** containers. Each entry shows:
- Container name, description, category, source module
- Enable/disable toggle
- Running status
- "Uninstall" button (no confirmation needed — folders are ephemeral)

This page is focused and clean. If you have 12 containers installed, you see 12 entries.

### Browse

Shows **available** containers from all cloned modules that aren't currently installed. Organized by category. Each entry shows:
- Container name, description, source module
- "Install" button

This is the "app store" experience. Browsing is free — nothing gets installed until you click.

### Sources

Manages module repos:
- List of added module sources with name, URL, commit hash, last updated
- "Update" button per source (runs `git pull`)
- "Update All" button
- "Remove" button (with warning if containers from this source are installed)
- "Add Source" field for git URLs not in the catalog
- Browse the built-in catalog for sources to add

### Personal Containers

- List of containers with `source: personal`
- "Add Custom Container" button (scaffolds a directory with compose.yaml template)

## Module side effects (cron jobs, host dependencies)

Modules can declare side effects in `module.yaml`:

```yaml
containers:
  nextcloud:
    # ... standard fields ...
    cron_jobs:
      - schedule: "*/5 * * * *"
        script: nextcloud-cron-job.sh
        description: "Nextcloud background jobs"
    host_packages:
      - ffmpeg  # needed for media preview generation
    setup_hooks:
      - scripts/setup-nextcloud.sh  # runs once on first enable
```

When a container with cron_jobs is ENABLED, `all-containers.sh` installs the cron entries (same `install_cron` pattern from setup.sh). When DISABLED, it removes them. This is checked on every `--start` run, so enabling/disabling via the web admin takes effect on the next start.

Host packages are checked at install time and on container enable. If missing, the user is warned (or they're auto-installed with confirmation, like setup.sh does for base packages).

## Platform files and git structure

After the module system is implemented:

```
~/containers/                        # platform git repo
  .gitignore                         # whitelist approach (see below)
  .modules/                          # persistent local catalog (gitignored)
    do-it-self-media/                # git clone
    do-it-self-tools/                # git clone
    ...
  scripts/
    all-containers.sh
    setup.sh
    module.sh                        # NEW: install/update/uninstall/list subcommands
    dev-sync.sh                      # NEW (developer helper)
    lib/
      tailscale-preflight.js
    ...
  web-admin/
    ...
  docs/
    MODULES.md                       # this document
    TESTING.md
  module-catalog.yaml                # known module repos
  container-registry.yaml            # GENERATED from installed modules
  user-config.yaml                   # user overrides (gitignored)
  installed-modules.yaml             # what's installed (gitignored)

  # Container directories (gitignored, installed from .modules/):
  jellyfin/
  searxng/
  ...
```

The platform `.gitignore` uses a whitelist approach:

```gitignore
# Ignore everything at the top level
/*

# Except platform directories and files
!scripts/
!web-admin/
!docs/
!module-catalog.yaml
!.gitignore
!CLAUDE.md
!AGENTS.md
!README.md
!PORTABILITY_ISSUES.md
!LICENSE
```

Container directories are invisible to the platform's git. Each module's git history lives in the module repo under `.modules/`, not the platform repo.

## Developer workflow

For the maintainer or contributors who need to modify a module's containers:

1. **Edit live:** Make changes to `~/containers/jellyfin/compose.yaml` as normal. Test it on the running system.

2. **Sync back to module repo:** Run `dev-sync do-it-self-media jellyfin`:
   - Copies `~/containers/jellyfin/` into `.modules/do-it-self-media/jellyfin/` (excluding `config-personal/`, `.env`, `tailscale-state/`, `compose.override.yaml`)
   - Shows a diff for review
   - Prompts to commit + push

3. **Other users update:** They run `module.sh update do-it-self-media` and get the changes.

The developer doesn't need a separate development environment. They work on their live system and sync changes back to the module repo when ready.

## Implementation phases

### Phase 1: Module infrastructure (no container migration)
- Create `module.sh` with subcommands: `add-source`, `install`, `uninstall`, `update`, `list`
- Create `module-catalog.yaml` with the default catalog entries
- Create `installed-modules.yaml` schema
- Update `container-registry.yaml` generation to merge from module `module.yaml` files
- Update `.gitignore` to whitelist platform files only
- Add `source` field tracking to the registry
- Document the ephemeral-folder invariant in CLAUDE.md

### Phase 2: Repo split
- Create the module repos (start with 2-3, split further later)
- Move container directories from the platform repo to module repos
- Each module repo gets a `module.yaml` with its containers' registry entries
- Update setup.sh to run `module.sh add-source` + `module.sh install` for the default set
- Write migration script for existing users

### Phase 3: Web admin UI
- Reorganize into My Containers / Browse / Sources pages
- Add "personal container" creation
- Show container state (available/installed/enabled/running) consistently

### Phase 4: Side effects
- Add `cron_jobs` field to module.yaml spec
- Wire cron install/remove to container enable/disable in all-containers.sh
- Add `host_packages` field and checking
- Add `setup_hooks` field and first-run execution

### Phase 5: Developer tooling
- `dev-sync.sh` for syncing live changes back to module repos
- Documentation for module authors

## Migration plan for existing users

Users with existing installations need a smooth transition:

1. User pulls the updated platform repo
2. setup.sh detects "legacy mode" (container directories exist at top level but no `installed-modules.yaml`)
3. Migration script:
   - Creates `installed-modules.yaml`
   - Runs `module.sh add-source` for the default catalog entries (clones into `.modules/`)
   - For each existing container directory at the root, matches it to a module and records it as installed
   - The container directories stay exactly where they are — they're already "installed"
   - Updates `.gitignore` to whitelist platform files only
4. Everything continues working. Containers are running, configs are preserved.
5. User can then `module.sh update` to sync with latest module versions at their leisure

## What this does NOT include

- **Dependency resolution between modules.** Containers are independent. If you need MariaDB for Nextcloud, the Nextcloud module's docs say "install do-it-self-core first" but there's no enforced dependency graph.
- **Version pinning or semver.** Modules track by git commit hash, not version numbers. `module.sh update` always goes to latest. Rollback is `git checkout <old-hash>` in the module's `.modules/` clone.
- **A central registry/marketplace server.** The catalog is a YAML file, not a web service. Discovery is browsing git repos.
- **Sandboxing or security isolation between modules.** All modules share the same Docker daemon, the same Tailscale network, the same Infisical instance. A malicious module could do anything. Only install modules you trust.
