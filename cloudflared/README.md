# Cloudflare Tunnel Setup

_WARNING: This file is AI generated and has issues, use it as a jumping off point, but it isn't all correct anymore as some of the information is outdated!_

## Overview

This stack runs cloudflared as a Docker container to tunnel traffic from Cloudflare to your local Caddy server on port 80.

## Architecture

```
External Users → Cloudflare → cloudflared (Docker) → Caddy (localhost:80)
```

## Initial Setup

### 1. Create Tunnel via Cloudflare Dashboard (Web UI)

1. Go to: https://one.dash.cloudflare.com/
2. Click **Zero Trust** (or **Access** → **Tunnels**)
3. Click **Create** → **Cloudflare Tunnel**
4. Name the tunnel: `caddy-tunnel`
5. Copy the **Tunnel UUID** (e.g., `a1b2c3d4-...`)
6. Copy the **token** shown (starts with `eyJh...`)
7. Save these for the next steps

### 2. Save Credentials

Create the credentials file:

```bash
cat > /home/chrisl8/containers/cloudflared/<TUNNEL-UUID>.json << 'EOF'
{
  "AccountTag": "<YOUR-ACCOUNT-TAG>",
  "TunnelSecret": "<SECRET-FROM-STEP-ABOVE>",
  "TunnelID": "<TUNNEL-UUID>"
}
EOF
```

**Note:** The `<YOUR-ACCOUNT-TAG>` is your Cloudflare account ID (find it in Dashboard → Overview → API).

### 3. Update config.yml

Edit `config.yml` and replace `<TUNNEL-UUID>` with the UUID from Step 1:

```yaml
tunnel: a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx
credentials-file: /home/chrisl8/containers/cloudflared/a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
```

### 4. Configure DNS Records (Web UI)

1. Go to **DNS** → **Records** for each domain:
   - lofland.com
   - lofland.net
   - ekpyroticfrood.net
   - voidshipephemeral.space

2. For each domain, add CNAME records:
   - Type: CNAME
   - Name: `@` (for apex) or `*` (wildcard)
   - Target: `<TUNNEL-UUID>.cfargotunnel.com`
   - Proxy status: **Orange cloud (proxied)**

3. Repeat for subdomains you need:
   - `www` → `<TUNNEL-UUID>.cfargotunnel.com`
   - `blog` → `<TUNNEL-UUID>.cfargotunnel.com`
   - etc.

### 5. Start the Tunnel

```bash
cd /home/chrisl8/containers/cloudflared
docker compose up -d
```

### 6. Verify

```bash
# Check container is running
docker ps | grep cloudflared

# Check logs
docker logs cloudflared

# Test from external network
curl -v https://your-domain.com
```

## Daily Operations

### Check Status

```bash
docker compose ps
docker logs cloudflared -f
```

### Restart

```bash
docker compose restart cloudflared
```

### Update

```bash
docker compose pull
docker compose up -d
```

## Configuration

### Adding New Domains/Subdomains

Edit `config.yml` and add new ingress rules:

```yaml
ingress:
  - hostname: newdomain.com
    service: https://localhost:443
  # ... existing entries ...
```

Then restart:

```bash
docker compose restart cloudflared
```

### Verify Ingress Rules

```bash
docker exec cloudflared cloudflared tunnel ingress validate
```

## Troubleshooting

### Tunnel shows "Inactive" in Dashboard

1. Check container logs:

   ```bash
   docker logs cloudflared
   ```

2. Verify credentials file exists:

   ```bash
   ls -la /home/chrisl8/containers/cloudflared/*.json
   ```

3. Verify config.yml has correct UUID:
   ```bash
   grep "tunnel:" /home/chrisl8/containers/cloudflared/config.yml
   ```

### Connection Refused

1. Verify Caddy is running and bound to localhost:443:

   ```bash
   docker ps | grep caddy
   curl -k https://localhost:443
   ```

2. Check Caddy's port binding:
   ```bash
   docker port caddy
   # Should show: 443/tcp -> 127.0.0.1:443
   ```

### TLS Errors

1. Verify Caddy's self-signed certs exist:

   ```bash
   ls -la /mnt/2000/container-mounts/caddy/conf/*.pem
   ```

2. Test with curl:
   ```bash
   curl -k -v https://localhost:443 2>&1 | head -20
   ```
