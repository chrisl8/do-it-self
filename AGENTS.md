# AGENTS.md

This repository contains Docker container configurations for various self-hosted services, plus some supporting Python and Node.js applications.

## Build, Lint, and Test Commands

### Python (env2cfg - valheim/valheim-server-docker/env2cfg)

```bash
# Install dependencies and run all tox environments
cd valheim/valheim-server-docker/env2cfg
pip install tox
tox

# Run individual environments
tox -e py3-syntax      # flake8 syntax checking
tox -e py3-tests       # pytest with coverage
tox -e py3-black       # black format checking

# Run a single test
pytest test/test_env2cfg.py -vv

# Check black formatting
black --check --diff .
```

### Node.js (web-admin)

```bash
# Install all dependencies
cd web-admin
npm run install:all

# Run development servers
npm run dev:backend    # Node with watch mode
npm run dev:frontend   # Vite dev server

# Build frontend for production
npm run build

# Start production backend
npm start
```

### Node.js (Witchazzan - caddy/Witchazzan)

```bash
cd caddy/Witchazzan

# Install dependencies
npm install

# Run development
npm run client         # Vite dev server
npm run server         # PM2 development server

# Build for production
npm run build

# Run tests (Playwright)
npm run test           # If defined in scripts

# Linting
npx eslint .
npx prettier --check .
```

### Docker Services

Most services use Docker Compose:
```bash
cd <service-directory>
docker compose up -d      # Start
docker compose down       # Stop
docker compose pull       # Update images
```

## Code Style Guidelines

### Python (env2cfg)

- **Line Length**: 88 characters (Black default)
- **Formatting**: Black, no custom config
- **Linting**: flake8 with ignores: E203, W503
- **Testing**: pytest with coverage (`--cov=env2cfg`)
- **Imports**: Sorted automatically, application-import-names=env2cfg
- **Naming**: PEP8 compliant (snake_case for functions/variables, PascalCase for classes)
- **ConfigParser**: Use `optionxform = str` to preserve case sensitivity in config keys

### Node.js/JavaScript

- **Formatting**: Prettier (default config)
- **Linting**: ESLint (project-specific config in caddy/Witchazzan)
- **Type System**: No TypeScript in this repo - plain JavaScript only
- **ES Modules**: Use `"type": "module"` where applicable
- **Package Manager**: npm (not yarn or pnpm)
- **Node Version**: ESM modules require Node 12+; prefer modern features

### Shell Scripts

- Use `#!/bin/bash` or `#!/usr/bin/env bash`
- Prefer `#!/bin/sh` for portable scripts
- Use `set -e` for error handling
- Quote variables: `"$VAR"` not `$VAR`
- Use `#!/bin/bash` for arrays and advanced features

### Docker/Compose Files

- Use version 3.x+ compose format
- Document environment variables in comments
- Use sensible defaults for ports and volumes
- Include `restart: unless-stopped` for long-running services

## Repository Structure

```
/home/chrisl8/containers
├── web-admin/           # Docker status monitoring UI (Node.js)
│   ├── backend/         # Express server
│   └── frontend/        # React/Vite app
├── caddy/
│   ├── Witchazzan/      # Phaser multiplayer game (Node.js)
│   └── spacymote/       # Phaser game (legacy)
├── valheim/valheim-server-docker/
│   └── env2cfg/         # Python config tool
├── <service>/           # Individual Docker services
│   ├── compose.yaml
│   └── 1password_credential_paths.env
└── scripts/             # Shared shell scripts
```

## Common Operations

```bash
# Run all container updates
./scripts/update-containers-from-diun-list.sh

# System health check
./scripts/system-health-check.sh

# Enable/disable all containers
./scripts/enable-all-containers.sh
./scripts/disable-all-containers.sh
```

## Notes

- No Cursor or Copilot rules found in `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md`
- Some services use 1Password for credentials (see `*_credential_paths.env`)
- Tailscale configuration in `<service>/tailscale-config/tailscale-config.json`
- SSL certificates managed via Traefik ACME in `<service>/tailscale-state/certs/`
