# Security Model

This document describes the trust boundaries and privilege model of the
platform. Read this before deploying if you want to understand exactly what
you're trusting — the short version is "your tailnet is your auth boundary."

## Trust model — Tailscale ACL is the auth boundary

Every service terminates HTTPS at its own Tailscale sidecar; nothing in this
platform is reachable from outside the tailnet. There is **no
application-layer authentication** on top of that — if you are on the
tailnet, you have full access to every service.

Implications:

- Treat tailnet membership like sudo on the host. Anyone you add to your
  tailnet can reach every service you run on this box.
- Use [tailnet ACLs](https://tailscale.com/kb/1018/acls) to scope which
  devices or users can reach which services. The default "everyone reaches
  everything" policy is fine for a single-admin tailnet; it is not fine for
  a shared one.
- Revoke tailnet devices promptly when they're lost or decommissioned.
  A compromised tailnet device is equivalent to a compromised admin account.
- Per-service auth (Authelia, OAuth-in-front, etc.) is **out of scope** for
  this platform. If a service exposes its own login (e.g. Forgejo, Nextcloud),
  that is a second layer you configure yourself.

## Host sudoers rules

`scripts/setup.sh` installs three drop-in files in `/etc/sudoers.d/`
(`scripts/setup.sh:95-125`):

| File | Rule | Why |
|---|---|---|
| `containers-chown` | NOPASSWD `/usr/bin/chown` | `all-containers.sh` fixes mount ownership before `docker compose up` (see `mount-permissions.yaml`). |
| `containers-chmod` | NOPASSWD `/usr/bin/chmod` | Same, for mount mode bits. |
| `containers-shutdown` | NOPASSWD `/usr/sbin/shutdown` | `system-graceful-shutdown.sh` uses it for ordered cron-driven shutdowns. |

Each rule is scoped to a single binary, not blanket sudo. Remove with
`sudo rm /etc/sudoers.d/containers-*`.

**Trade-off.** Any process running as the host user can chown or chmod any
file on the system, and can halt the host. This is acceptable on a
single-admin box where the host user is you; it is **not** acceptable on a
multi-tenant host, and this platform is not designed for that shape.

## Web-admin access control

The web admin uses **filesystem permissions plus Tailscale Serve** as its
access boundary. There is no app-layer authentication.

- Primary listener: a Unix domain socket at
  `web-admin/backend/sockets/web-admin.sock`, chmod `0660`
  (`web-admin/backend/src/server.js` around line 1105-1170).
- The Tailscale Serve sidecar (see `web-admin/compose.yaml`) bind-mounts the
  socket directory and proxies `https://admin.<tailnet>.ts.net` to it.
- Access requires either (a) being a member of the file-group that owns the
  socket, or (b) reaching the sidecar over the tailnet.

**`DEBUG_TCP_PORT` environment variable.** Setting this in
`web-admin/backend/.env` opens a **second** listener on loopback at
`127.0.0.1:<port>`. This listener has no authentication — any local user
who can reach loopback can control the admin. Use only for local debugging;
unset after. Do not set on a shared or multi-user host.

## Where secrets live

- **Infisical** — the canonical secret store. Per-container secrets live at
  `/<container-name>/`; shared tailnet variables (`TS_AUTHKEY`,
  `TS_API_TOKEN`, `TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`) live at `/shared/`.
- **`~/credentials/*.env`** — bootstrap-only credentials that cannot live in
  Infisical (the Infisical token itself, anything needed before Infisical is
  up). Plaintext on disk, chmod 0600 by convention. Each file is symlinked
  into the matching container directory as `.env`.
- **Never** commit secrets to `container-registry.yaml`, `user-config.yaml`,
  `compose.yaml`, or a plain `.env` at a container root. The `.gitignore`
  whitelist blocks most accidents, but review your diffs.
- `scripts/generate-env.js` materializes secrets into per-container `.env`
  files at `docker compose up` time, reading from Infisical. The `.env`
  files are gitignored.

See [`docs/TAILSCALE.md § How credentials flow to containers`](docs/TAILSCALE.md#how-credentials-flow-to-containers)
for the end-to-end flow.

## Reporting security issues

Email `christen@lofland.net` for anything affecting a running deployment,
especially anything that could compromise the tailnet boundary or expose
secrets. Please include:

- Platform commit SHA: `git -C ~/containers rev-parse HEAD`
- Affected module source (if applicable)
- Reproduction steps

For non-exploitable hardening suggestions, a public issue at
[github.com/chrisl8/do-it-self](https://github.com/chrisl8/do-it-self) or
[codeberg.org/Chris10/do-it-self](https://codeberg.org/Chris10/do-it-self)
is fine.
