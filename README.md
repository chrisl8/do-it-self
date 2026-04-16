# do-it-self containers

A self-hosted Docker Compose platform for running 50+ services on a single Linux box, reachable only over [Tailscale](https://tailscale.com/). Services install from modular container catalogs through a web UI; everything is glued together by a handful of shell and Node scripts.

Mirrors: [Codeberg](https://codeberg.org/Chris10/do-it-self) · [GitHub](https://github.com/chrisl8/do-it-self) · [Forgejo](https://forgejo.jamnapari-goblin.ts.net/Chris10/do-it-self) (private). Issues and pull requests are welcome at either public mirror.

---

## Quickstart

Fresh Ubuntu 24.04 x86_64 server, with Tailscale pre-configured per [Prerequisites](#prerequisites) below:

```bash
curl -fsSL https://raw.githubusercontent.com/chrisl8/do-it-self/main/scripts/setup.sh | bash
```

`setup.sh` is idempotent — safe to re-run. It:

1. Clones this repo to `~/containers` (if not already there) and re-exec's itself from the clone.
2. Installs base packages (git, curl, unzip, jq, yq), configures passwordless sudo for `chown`/`chmod`/`shutdown`, installs Docker, Node.js (via [fnm](https://github.com/Schniz/fnm)), PM2, the Infisical CLI, and Tailscale.
3. Prompts (once, hidden) for two Tailscale credentials: a **reusable auth key** and an **API token**. Both can be generated at [login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys).
4. Joins the host to your tailnet, auto-detects your `TS_DOMAIN`, and creates a default `user-config.yaml` with one storage mount at `~/container-data`.
5. Starts [Infisical](https://infisical.com/) in a local container and seeds `TS_AUTHKEY`, `TS_API_TOKEN`, `TS_DOMAIN`, `HOST_NAME`, and `DOCKER_GID` into the `/shared` path. These are the only "shared" variables; every other secret lives per-container.
6. Builds and starts the web admin under PM2, verifies its Tailscale Serve sidecar is reachable at `https://admin.<your-tailnet>.ts.net`, and brings up default-enabled containers (Infisical, Homepage dashboard, web admin sidecar).

When it finishes, you have two live URLs:

- **Web admin** — `https://admin.<your-tailnet>.ts.net` — where you install, configure, and start containers.
- **Homepage dashboard** — `https://console.<your-tailnet>.ts.net` — auto-updating tile view of every running service.

Both are only reachable from devices signed in to your tailnet.

### Your first containers

Open the web admin and work through the tabs left-to-right:

1. **Dashboard** — empty on a fresh install except for the bootstrap containers. You'll come back here to start things.
2. **Configuration** — bootstrap containers are already listed here. Fill in any per-container variables they ask for (usually none for the defaults).
3. **Browse** — the catalog. Each card shows a description, the [homepage group](https://gethomepage.dev/latest/configs/services/) it'll appear under, any required external accounts (with links to sign up), and a Tailscale badge for services that expose a tailnet URL. Click **Install** on anything you want. Installation copies the container folder from `.modules/<source>/<container>/` into the platform root.
4. **Sources** — the module repositories feeding Browse. The two default sources (`do-it-self-containers` and `do-it-self-personal`) are cloned by `setup.sh`. Add your own Git URL here to host a private catalog. If a module repo has uncommitted changes locally, this page shows a warning banner with per-file diffs.
5. **Configuration** — newly installed containers appear as disabled. Toggle each one on, fill in variables (secrets have a show/hide eye; some variables are auto-generated). Changes save automatically.
6. **Dashboard** — click **Start All Enabled**. A progress card tracks the queue, showing current/completed/failed counts. If one container fails to start, the button keeps going through the rest and surfaces the failure with its stderr; you can cancel mid-run.

That's the whole loop. Your Homepage dashboard populates itself with tiles for each running service based on labels the containers declare.

---

## Prerequisites

- **OS** — Ubuntu 24.04 LTS on x86_64. Other distros will probably work but aren't tested; `setup.sh` only knows apt.
- **Storage** — one or more directories where container volumes will live. The default is `~/container-data`; edit `user-config.yaml` or use the web admin's Configuration tab to add more.
- **Tailscale tailnet** with three things configured:
  1. A `tag:container` in your ACL policy. Containers advertise this tag themselves via `TS_EXTRA_ARGS=--advertise-tags=tag:container`.
  2. **HTTPS Certificates enabled** at [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns). Every sidecar uses Tailscale Serve, which needs a MagicDNS cert.
  3. A **reusable auth key** (`Reusable=ON`, `Tags=tag:container`) and an **API token**, both from [Settings → Keys](https://login.tailscale.com/admin/settings/keys).

Walkthrough with screenshots: [docs/TAILSCALE.md](docs/TAILSCALE.md). That doc is the source of truth for tailnet setup; the Quickstart assumes it's done.

---

## Architecture

This section is for readers deciding whether to adopt or contribute — it explains the shape of the system and why. Skip it if you just want to run the thing.

### Modules and the catalog

Container stacks don't live in this repo. They live in separate **module** repositories, each a Git repo of container folders (one `compose.yaml` per folder, plus a `module.yaml` with metadata). `setup.sh` clones a default set of module sources into `.modules/`; the web admin's Browse tab lists every container the modules advertise; installing copies the folder from `.modules/<source>/<name>/` into the platform root. Uninstalling is `rm -rf`. This means the platform repo itself tracks zero container folders and stays under a few hundred files regardless of how many services you run.

See [docs/MODULES.md](docs/MODULES.md) for the module authoring guide, the `dev-sync` workflow (live-edit back to the source repo), and the side-effect system (cron jobs, host packages, setup hooks declared in `module.yaml`).

### Ephemeral container directories

Anything in `~/containers/<name>/` can be deleted and recreated from the module source without losing user data. Persistent state lives in five places, all preserved across reinstalls:

| Path | What it holds |
|---|---|
| `~/container-mounts/` (or wherever you mount disks) | All container volume data |
| `~/credentials/*.env` | Per-service credential files, symlinked as `.env` |
| `user-config.yaml` | Enabled/disabled state, per-container variable overrides, mount definitions |
| `compose.override.yaml` (per container) | Hardware-specific tweaks (GPU passthrough, etc.) |
| `config-personal/` (per container) | Generated-config overrides kept out of the module source |
| `<mount[0]>/tailscale-state/<name>/` | Tailscale node identity for each sidecar (outside container dirs so `rm -rf` is safe) |

### Three-layer config merge

Every container's `.env` is generated at start time by merging three sources:

1. **`module.yaml`** in the module repo — author-declared defaults and variable schema.
2. **`container-registry.yaml`** at the platform root — the catalog the web admin reads, generated from all installed modules.
3. **`user-config.yaml`** — your overrides. What the Configuration tab writes to.

Secrets never touch these files. They live in Infisical and are injected into the shell environment right before `docker compose up` by `scripts/all-containers.sh`. Losing `user-config.yaml` loses your preferences; losing Infisical loses your secrets; losing the container folder loses nothing.

### Tailscale sidecar pattern

Every web-facing container runs next to a [`tailscale/tailscale`](https://hub.docker.com/r/tailscale/tailscale) sidecar that joins the tailnet, advertises the `tag:container` tag, and runs Tailscale Serve to terminate HTTPS at `<hostname>.<tailnet>.ts.net` and proxy to the app.

```
                     Tailnet
                        │
Browser ──https://console.<tailnet>.ts.net──▶ ┌──────────────────────────┐
                                              │  homepage-ts  (sidecar)  │
                                              │  tailscale/tailscale      │
                                              │  Serve 443 → homepage:3000│
                                              └────────────┬─────────────┘
                                                           │  homepage-net
                                                           │  (docker bridge)
                                                           ▼
                                              ┌──────────────────────────┐
                                              │  homepage  (app)         │
                                              │  ghcr.io/gethomepage     │
                                              │  listens on :3000        │
                                              └──────────────────────────┘

  TS_AUTHKEY, TS_DOMAIN, TS_STATE_HOST_DIR are injected from Infisical
  by scripts/all-containers.sh right before `docker compose up`.
```

Trimmed `homepage/compose.yaml`:

```yaml
services:
  homepage:
    image: ghcr.io/gethomepage/homepage
    user: 1000:1000
    group_add:
      - ${DOCKER_GID:-985}
    volumes:
      - ./config:/app/config
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - homepage-net
    environment:
      HOMEPAGE_ALLOWED_HOSTS: console.${TS_DOMAIN}
    restart: on-failure
  ts:
    container_name: homepage-ts
    image: tailscale/tailscale
    environment:
      - TS_HOSTNAME=console
      - TS_EXTRA_ARGS=--advertise-tags=tag:container
      - TS_SERVE_CONFIG=/config/tailscale-config.json
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_AUTHKEY=${TS_AUTHKEY}
    volumes:
      - ${TS_STATE_HOST_DIR}:/var/lib/tailscale
      - ./tailscale-config:/config
      - /dev/net/tun:/dev/net/tun
    cap_add: [net_admin, sys_module]
    networks:
      - homepage-net
    depends_on:
      homepage:
        condition: service_healthy
    restart: on-failure
networks:
  homepage-net:
```

The `depends_on: condition: service_healthy` is load-bearing: the sidecar must not advertise the hostname until the app is actually listening, or Tailscale Serve will return 502 while the app warms up.

### Networking options

Three patterns are used across the catalog, picked per-container based on what the service needs:

**Sidecar with a shared docker network** — default. Both services join a named docker network; Tailscale Serve proxies from the sidecar's port 443 to the app service by its docker DNS name. One tailnet hostname per container, one port exposed. What the homepage example above uses. Best for web apps.

**`network_mode: service:ts`** — the app container shares the sidecar's network namespace. Tailscale Serve proxies to `localhost` on whatever port the app listens on, and *all* the app's ports are reachable over Tailscale. Required for apps that bind many ports (Minecraft, Valheim) or speak non-HTTP protocols.

**`network_mode: host`** — the container lives directly on the host's network. Use for services that need to broadcast (UrBackup), move bulk traffic without Tailscale's CPU overhead, or expose many UDP ports. Conflicts with anything else bound to the same ports.

### Credentials via Infisical

All per-container secrets live in a local [Infisical](https://infisical.com/) container at `http://localhost:8085`. `scripts/all-containers.sh` calls `infisical export` right before starting each container to turn the secrets into environment variables; nothing is ever written to disk unencrypted (no plaintext `.env` files except the ones you explicitly symlink from `~/credentials/`). The web admin's Configuration tab reads and writes Infisical through its API.

Five shared variables live at `/shared` in Infisical and are injected into every container that needs them: `TS_AUTHKEY`, `TS_API_TOKEN`, `TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`. Everything else is per-container.

Full details: [docs/TAILSCALE.md#credentials](docs/TAILSCALE.md).

---

## Day-2 operations

Automated maintenance runs from cron: startup-on-reboot, health checks every 15 minutes, Kopia backup freshness check every 6 hours. [DIUN](https://crazymax.dev/diun/) (if you enable it from Browse) emails you weekly when container images have updates available.

Manual procedures — updating, backups, rebooting, NVIDIA driver recovery, troubleshooting unhealthy containers — are all in [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

---

## Testing

- `scripts/test-fresh-install.sh` — runs on a freshly-installed host and validates prerequisites, web admin reachability, module state, container startup, and tailnet HTTPS paths for a subset of containers.
- `scripts/hetzner-test.sh` — end-to-end: provisions a fresh Hetzner VPS, runs `setup.sh`, runs `test-fresh-install.sh`, tears down. `--browse` keeps the VM alive with a SOCKS5 proxy so you can click through the web admin on a real fresh install.

Full setup and usage: [docs/TESTING.md](docs/TESTING.md).

---

## Contributing / maintainer notes

- **Adding a container** — author a new folder in one of the module repos, not in this platform repo. See [docs/MODULES.md](docs/MODULES.md) for `module.yaml` structure and the authoring guide.
- **Live-editing an installed container** — edit the copy in `~/containers/<name>/`, then run `scripts/module.sh dev-sync <name>` to rsync your changes back to the source module, show the diff, and prompt for commit/push.
- **Shell style** — `set -e`, quoted variables, `#!/bin/bash`, `shellcheck --external-sources` clean at warning level.
- **JavaScript style** — plain ES modules, no TypeScript, Prettier defaults, ESLint where configured.
- **Compose style** — no blank lines, copious comments, no `:latest` tag (it's the default), healthchecks on everything.
- **AI agents** — `AGENTS.md` and `CLAUDE.md` hold per-tool instructions for Claude Code and other agents. They're developer-facing and scheduled for refresh separately; see [PORTABILITY_ISSUES.md](PORTABILITY_ISSUES.md) #11.

---

## Answers to Questions Nobody Asked

**Why use `:latest` tags?**
Pinning versions causes more outages than it prevents in my experience — old versions rot, security advisories accumulate, upgrades pile up into risky big-bang events. I'd rather have a crash than a security hole, and I'm happy to file bugs as an early adopter. Per-image decision though: I pin when the upstream's release discipline forces me to.

**Why build from Git clones instead of using published images?**
Trust. I'm fine using `latest` for projects that publish images themselves (MariaDB, NGINX, the apps I know do CI-to-image). For projects where the image is published by a third party, I'd rather build from source and know exactly what's in the container.

**Why not LinuxServer.io images?**
Twice now I've hit support runarounds where the app author says "that's not our image" and LinuxServer.io says "that's not our app." And I've been stuck waiting days for their rebuild after an upstream fix. So I use official images and build my own compose files. I do use their images for a handful of things, and might use more in the future.

**Some containers run as root — isn't that dangerous?**
I tried running everything non-root once. It worked for most of them, then broke in subtle ways under load, and cost me a lot of time for little benefit on a personal tailnet-only box. You do you; I don't lose sleep over it.

---

## License

Code is [AGPL](https://www.gnu.org/licenses/agpl-3.0.en.html). Scripts are [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0.html) because I expect people to copy-paste them. Documentation is [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

If you want a different license for a specific use, open an issue or email me.

See [LICENSE](LICENSE) for the authoritative boilerplate.
