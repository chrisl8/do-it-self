# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Docker Compose configurations for 50+ self-hosted services on an x86_64 Linux server. All networking runs through Tailscale. The main orchestration script (`scripts/all-containers.sh`) manages startup, shutdown, health checks, and updates for all containers.

Mirrored at [Codeberg](https://codeberg.org/Chris10/do-it-self) and [GitHub](https://github.com/chrisl8/do-it-self/).

## Architecture & Conventions

**One folder = one service = one Docker Compose project.** The folder name becomes the Docker project name. Each folder contains a `compose.yaml` file. **Must be named `compose.yaml`** — not `compose.yml` or the scripts will miss it.

### Container Management

- **No restart policy** — containers are never set to `restart: unless-stopped`. The `all-containers.sh` script manages all lifecycle operations. Docker auto-restart is intentionally avoided.
- **`_DISABLED_` file** — create this file in a service folder to skip it during start/stop operations.
- **`.start-order` file** — contains an alphanumeric priority (e.g., `000`, `010`, `z010`). Lower values start first; containers without this file start after ordered ones. Stop order is reversed.
- **`mount-permissions.yaml`** — optional per-service file specifying directory ownership/mode applied before container start.

### Credentials

- Credentials go in `~/credentials/container-name.env`, symlinked as `.env` in each service folder: `ln -s ~/credentials/service.env .env`
- Some services use 1Password via `1password_credential_paths.env` with `op://` references.
- Environment variables use `VAR=${VAR}` in the compose `environment:` section — no `env_file:` directive. This keeps variables explicit per-container.
- Sensitive values (passwords, API keys, personal URLs) go in `.env`; generic config goes directly in `compose.yaml`.

### Compose File Patterns

- Run as `user: 1000:1000` when the container supports non-root; otherwise leave as default.
- Never combine `image:` and `build:` in the same service — use one or the other.
- Healthchecks on every service: typically `start_period: 120s`, `start_interval: 5s`, `interval: 5m`.
- Homepage dashboard integration via labels: `homepage.group`, `homepage.name`, `homepage.icon`, `homepage.href`.
- Tailscale sidecar pattern: separate `ts` service with `network_mode: service:ts` on the app container.

### External Git Repos

Some services embed cloned git repos (e.g., `dawarich/dawarich/`, `minecraft/docker-minecraft-bedrock-server/`). These are updated via `all-containers.sh --update-git-repos`.

## Key Scripts (scripts/)

| Script | Purpose |
|--------|---------|
| `all-containers.sh` | Start/stop/update all containers. Flags: `--start`, `--stop`, `--get-updates`, `--update-git-repos`, `--restart-unhealthy`, `--container <name>`, `--mount <path>`, `--category <group>` |
| `system-cron-startup.sh` | Runs at boot via cron — stops stale containers, starts everything |
| `system-graceful-shutdown.sh` | Ordered shutdown then OS halt/reboot |
| `system-health-check.sh` | Periodic health monitoring, restarts unhealthy containers, pings healthchecks.io |
| `start-web-admin.sh` | Manages the PM2-based web admin dashboard |
| `update-containers-from-diun-list.sh` | Processes DIUN-detected image updates |
| `enable-all-containers.sh` / `disable-all-containers.sh` | Bulk add/remove `_DISABLED_` files |

## Build, Lint, and Test

### Python (valheim/valheim-server-docker/env2cfg)

```bash
cd valheim/valheim-server-docker/env2cfg
pip install tox
tox                        # all environments
tox -e py3-syntax          # flake8
tox -e py3-tests           # pytest with coverage
tox -e py3-black           # black format check
pytest test/test_env2cfg.py -vv  # single test
```

### Node.js (web-admin)

```bash
cd web-admin
npm run install:all
npm run dev:backend        # Express with watch mode
npm run dev:frontend       # Vite dev server
npm run build              # production frontend build
npm start                  # production backend
```

### Node.js (caddy/Witchazzan)

```bash
cd caddy/Witchazzan
npm install
npm run client             # Vite dev server
npm run server             # PM2 dev server
npm run build              # production build
npx eslint .
npx prettier --check .
```

### Docker Services

```bash
cd <service-directory>
docker compose up -d       # start
docker compose down        # stop
docker compose pull        # update images
```

## Code Style

- **Python**: Black (88 char line length), flake8 (ignore E203, W503), pytest
- **JavaScript**: Prettier (defaults), ESLint where configured. Plain JS only — no TypeScript. ES modules (`"type": "module"`). npm only.
- **Shell**: `set -e`, quote all variables (`"$VAR"`), `#!/bin/bash` for arrays. Shellcheck with `external-sources=true`.
- **Compose YAML**: No blank lines, copious comments, no `:latest` tag (it's the default).

## Notable Sub-Projects

- **web-admin/** — Full-stack React/Express Docker monitoring dashboard with real-time WebSocket updates. Runs via PM2, not Docker.
- **caddy/Witchazzan/** — Phaser 3 multiplayer game with Socket.io, SQLite, JWT auth. Has Playwright E2E tests.
- **caddy/** — Caddy reverse proxy compose file bundles multiple sub-services (spacymote, meshtastic, ghost, geomyidae, etc.).
