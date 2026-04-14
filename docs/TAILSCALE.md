# Tailscale Setup Guide

Every service in this platform gets its own Tailscale node via a sidecar container. This gives each service a private MagicDNS hostname (e.g. `searxng.your-tailnet.ts.net`), automatic HTTPS via Tailscale Serve with Let's Encrypt certificates, and zero port conflicts — ~46 services coexist without any port mapping.

## Prerequisites

`scripts/setup.sh` automates most of the Tailscale setup (installing the CLI, joining the tailnet, seeding credentials). But four things must be configured manually in the [Tailscale admin console](https://login.tailscale.com/admin) first.

### 1. Create a Tailscale account

Go to https://tailscale.com and sign up with any SSO provider. The free tier supports 100 devices and 3 users — more than enough for this platform.

If you already have a Tailscale account, skip to step 2.

### 2. Declare `tag:container` in the tailnet ACL

Every container sidecar runs `--advertise-tags=tag:container`. The Tailscale control plane rejects registration unless this tag is declared in the access control policy.

1. Go to https://login.tailscale.com/admin/acls/file
2. Find (or add) the `tagOwners` section and declare `tag:container`:
   ```json
   {
     "tagOwners": {
       "tag:container": ["autogroup:admin"]
     }
   }
   ```
   If a `tagOwners` block already exists, add the `"tag:container"` line to it. `autogroup:admin` means anyone who can administer the tailnet — for a personal tailnet, that's you.
3. Click **Save**

**Without this:** auth key generation fails with "tag:container is invalid" and every container sidecar crashloops with `requested tags [tag:container] are invalid or not permitted`.

### 3. Enable HTTPS Certificates

Container sidecars use Tailscale Serve to expose each service as `https://<name>.<tailnet>.ts.net`. Tailscale provisions these certificates via Let's Encrypt, but only after you opt in.

1. Go to https://login.tailscale.com/admin/dns
2. Scroll to **"HTTPS Certificates"**
3. Click **"Enable HTTPS"**

Free, takes effect immediately.

**Without this:** containers run but HTTPS URLs return nothing. Sidecar logs show: `serve proxy: this node is configured as a proxy that exposes an HTTPS endpoint to tailnet... but it is not able to issue TLS certs`.

### 4. Generate an auth key

1. Go to https://login.tailscale.com/admin/settings/keys
2. Click **"Generate auth key"**
3. Settings:
   - **Reusable:** ON — all ~46 sidecars register with the same key
   - **Ephemeral:** OFF
   - **Tags:** check **`tag:container`** (must have completed step 2 first)
   - **Expiration:** up to 90 days
4. Copy the key (starts with `tskey-auth-`)

Alternatively, you can use an OAuth client credential (`tskey-client-...`) which does not expire. See the [README Credentials section](../README.md#credentials) for that approach.

### 5. Generate an API access token

The API token is used by `setup.sh` for preflight checks that catch common misconfigurations before any container starts. It's also used by the web admin's Tailscale health panel.

1. Go to https://login.tailscale.com/admin/settings/keys (same page)
2. Scroll to **"API access tokens"** and click **"Generate access token"**
3. Expiration: up to 90 days
4. Copy the token (starts with `tskey-api-`)

## What setup.sh handles automatically

Once you have your auth key and API token, `setup.sh` takes care of:

- **Tailscale CLI** — installs via `curl -fsSL https://tailscale.com/install.sh | sh` if not already present
- **Tailnet join** — runs `tailscale up --authkey=... --hostname=$(hostname) --ssh --accept-routes`
- **Domain detection** — auto-detects `TS_DOMAIN` (e.g. `tail1234.ts.net`) from `tailscale status --json`
- **Credential storage** — seeds `TS_AUTHKEY`, `TS_API_TOKEN`, and `TS_DOMAIN` into Infisical
- **Preflight checks** — validates ACL tag, auth key validity, and HTTPS availability via `scripts/lib/tailscale-preflight.js`

Provide credentials to setup.sh in one of three ways:

```bash
# Environment variables (for automation / cloud-init)
TS_AUTHKEY=tskey-auth-... TS_API_TOKEN=tskey-api-... bash scripts/setup.sh

# Interactive prompt (run from a terminal without env vars set)
bash scripts/setup.sh

# Subsequent runs (fetches from Infisical automatically)
bash scripts/setup.sh
```

## How credentials flow to containers

1. `TS_AUTHKEY` is stored in Infisical at `/shared/TS_AUTHKEY` — seeded by setup.sh, rotated via the web admin Configuration tab or `infisical secrets set`
2. `scripts/all-containers.sh` fetches it from Infisical at start time via `infisical export --path=/shared`
3. Docker Compose picks up `${TS_AUTHKEY}` from the shell environment — no `.env` file, never written to disk in plaintext
4. Each container's Tailscale node identity is persisted at `<first-mount>/tailscale-state/<container-name>/` (the `TS_STATE_HOST_DIR` env var, generated automatically by `scripts/generate-env.js`), so containers keep their tailnet identity across restarts

## Networking patterns

Three networking patterns are used in compose files. Most containers use the **sidecar with network** pattern: a shared Docker network between the app and its Tailscale sidecar, with Tailscale Serve proxying HTTPS to the app's port. A few (e.g. minecraft) use `network_mode: service:ts` to expose all ports via the tailnet. Rare containers use `network_mode: host` for direct LAN access.

See [Networking Options](../README.md#networking-options) in the README for details and trade-offs.

## Health checks and monitoring

| What | When | Details |
|------|------|---------|
| Preflight checks | Before every `all-containers.sh --start` | `scripts/lib/tailscale-preflight.js` validates ACL tag, auth key (reusable, tagged, not expired), and HTTPS availability |
| Cron health check | Every 15 minutes | `system-health-check.sh` checks Tailscale device connectivity, warns if the auth key expires within 14 days |
| Web admin | On demand | Live Tailscale health panel using the same preflight checks |

## Troubleshooting

| Problem | Symptom | Fix |
|---------|---------|-----|
| `tag:container` not in ACL | Sidecars crashloop: `requested tags [tag:container] are invalid` | Add the tag to your ACL ([step 2](#2-declare-tagcontainer-in-the-tailnet-acl)) |
| HTTPS not enabled | HTTPS URLs return nothing; sidecar logs: `not able to issue TLS certs` | Enable HTTPS Certificates ([step 3](#3-enable-https-certificates)) |
| Auth key expired | Preflight fails; new sidecars won't register | Generate a new key, update via web admin Configuration tab or `infisical secrets set` |
| Auth key not reusable | Only the first sidecar registers; the rest fail | Generate a new key with Reusable=ON |
| Auth key missing tag | Preflight reports "key does not have tag:container" | Generate a new key with `tag:container` selected |
| Infisical down | `all-containers.sh` refuses to start Tailscale containers | Start Infisical first — it has start order `000` and starts before other containers |
| `TS_DOMAIN` not detected | setup.sh can't auto-detect domain | Verify host joined the tailnet: `tailscale status` |

### Diagnostic commands

```bash
# Verify host is connected to the tailnet
tailscale status

# Check a specific container's sidecar logs
docker logs <container-name>-ts

# Run preflight checks manually (needs TS_API_TOKEN in env)
node scripts/lib/tailscale-preflight.js
```
