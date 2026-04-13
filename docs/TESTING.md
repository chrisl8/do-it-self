# End-to-End Testing with Hetzner Cloud

Test the full setup flow on a fresh Ubuntu server. Creates a VPS, runs setup.sh via curl|bash (same as a real user), validates everything, and tears it down.

## One-Time Setup

1. Create a [Hetzner Cloud](https://www.hetzner.com/cloud/) account
2. Visit Hetzner Cloud Console at https://console.hetzner.cloud, select your project, select "Security" tab and create a new Read 7 Write API Token.
3. Install the CLI: `sudo apt install hcloud-cli`
4. Create a project and authenticate:
   ```bash
   hcloud context create do-it-self-test
   # Paste your API token when prompted
   ```
5. Register your SSH key:
   ```bash
   hcloud ssh-key create --name mykey --public-key-from-file ~/.ssh/id_ed25519.pub
   ```

## Running Tests

```bash
# Full cycle: create server, run setup, validate, destroy
scripts/hetzner-test.sh

# Keep the server running after tests (for manual inspection)
scripts/hetzner-test.sh --keep

# Re-run tests on an existing server (fast iteration)
scripts/hetzner-test.sh --retest

# Clean up
scripts/hetzner-test.sh --destroy
```

## Options

| Flag                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `--keep`               | Always keep the server (don't destroy even on success)        |
| `--no-keep-if-fails`   | Destroy server even if tests fail (default: keep on failure)  |
| `--destroy`            | Just destroy the test server                                  |
| `--retest`             | Run tests on existing server                                  |
| `--browse`             | After tests, open a SOCKS5 proxy for browsing test sites      |
| `--type cx33`          | Server type (default: cx23)                                   |
| `--location ash`       | Location (default: nbg1 / Nuremberg, Germany)                 |
| `--ts-key KEY`         | Tailscale auth key (joins server, enables container startup)  |
| `--ts-api-token TOKEN` | Tailscale API token (removes stale test nodes before build, on `--destroy`, and after a successful run) |
| `--ts-tailnet TAILNET` | Tailnet name (optional, auto-detected from API token)         |

## Realtime Output

If you want to watch the logs in real time to see what is taking so long, you can use this one-liner, replacing the IP with the one you get during hetzner-test.sh run:

```bash
 ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@178.104.142.178" "tail -f /home/ubuntu/setup.log"
```

## Logs

After each run, logs are saved to `/tmp/hetzner-test-logs/hetzner-test-<timestamp>/`:

- `setup.log` -- output from setup.sh on the server
- `cloud-init-output.log` -- last 200 lines of cloud-init's own log
- `cloud-init-status.txt` -- cloud-init status report
- `docker-state.log` -- containers and images on the server
- `file-state.log` -- key directories listing

If a test fails, the server is kept running by default so you can SSH in and investigate. Use `--no-keep-if-fails` to override.

### Auto-destroy timer

When the server is kept after a failure (the default), the script schedules an `at` job to automatically destroy it after 2 hours. This prevents forgotten servers from running up costs. The output includes the job ID and scheduled time:

```
Auto-destroy scheduled for Sun Apr 13 16:32:00 2026 (job 47). Cancel with: atrm 47
```

The timer is cancelled automatically when you run `--destroy`, `--retest`, or start a new test. The timer is NOT set when you use `--keep` (explicit keep means you want it to stay).

Requires the `at` command (`sudo apt install at`). If `at` is not installed, the script warns and skips the timer.

## Browsing Test Sites

The test VM runs on a separate test tailnet that your local browser can't reach directly. The `--browse` flag solves this by opening an SSH SOCKS5 proxy on port 1080, allowing a browser on another machine to route traffic through the test VM and access all the test sites.

### Typical setup

The test script runs on a headless Linux server. Your browser is on a separate machine (e.g. Windows laptop) that can reach the Linux server via Tailscale or LAN.

```
Windows browser  →  SOCKS proxy on Linux server:1080  →  SSH tunnel  →  Hetzner VM  →  test tailnet
```

### Usage

```bash
scripts/hetzner-test.sh --ts-key tskey-auth-... --ts-api-token tskey-api-... --browse
```

After tests complete, the script starts the proxy, prints clickable URLs for all test sites, and waits. Press Enter when you're done browsing to continue with teardown. Combine with `--keep` if you want the server to survive after teardown.

### Browser configuration

**Firefox** (recommended — proxy is per-browser, doesn't affect anything else on your system):

1. Settings → Network Settings → Settings...
2. Select "Manual proxy configuration"
3. SOCKS Host: `<your-linux-server-ip>`  Port: `1080`  SOCKS v5
4. Check **"Proxy DNS when using SOCKS v5"** — this is critical, it makes `*.ts.net` hostnames resolve on the remote end
5. Click OK

**Chrome** (uses system proxy, or launch a separate instance with a flag):

```
chrome.exe --proxy-server="socks5://<your-linux-server-ip>:1080"
```

**Important:** Remember to undo your proxy settings when you're done browsing. Firefox will not route any traffic correctly while the proxy is configured and the tunnel is down.

When you eventually run `--destroy` (or kick off another test run), pass `--ts-api-token` so all Tailscale nodes from that test run are reaped at the same time — both the host and every container sidecar (matched via the `tag:container` tag every sidecar advertises). The next test run also sweeps any leftover test nodes from prior failed runs before provisioning, so they never accumulate.

## Tailscale Integration Testing

By default the Hetzner test validates setup, env generation, and the API but does NOT actually start containers (because they all need Tailscale). To do a full test that starts a curated set of containers, you need a Tailscale account and two keys.

### Use a separate test tailnet

Don't pollute your real Tailscale network with ephemeral test machines. Create a dedicated test tailnet:

1. Create a free Tailscale account at https://tailscale.com using a different SSO provider (e.g. a different Google account) than your production Tailscale account
2. Free tier supports 100 devices and 3 users -- plenty for testing

### Declare `tag:container` in the tailnet ACL

Every container sidecar in this repo runs `--advertise-tags=tag:container`. A
brand-new test tailnet has no tags defined, so before you can create an auth
key with that tag you must first declare it in the access control policy:

1. Go to https://login.tailscale.com/admin/acls/file
2. Find (or add) the `tagOwners` section and declare `tag:container` with an
   owner. The minimum diff is:
   ```json
   {
     "tagOwners": {
       "tag:container": ["autogroup:admin"]
     }
   }
   ```
   If a `tagOwners` block already exists, just add the `"tag:container"` line
   to it. `autogroup:admin` means "anyone in the tailnet who can administer
   it" — for a personal test tailnet, that's you.
3. Click **Save**

Without this, the next step (generating an auth key with `tag:container`)
will fail with "tag:container is invalid" and every container sidecar in the
test will crashloop with `requested tags [tag:container] are invalid or not
permitted`.

### Enable HTTPS in the tailnet

Container sidecars in this repo use Tailscale Serve to expose each container
as `https://<name>.<tailnet>.ts.net` (e.g. `console.example.ts.net` for
homepage). That requires HTTPS certificates, which Tailscale provisions via
Let's Encrypt — but only after you opt in for the tailnet.

1. Go to https://login.tailscale.com/admin/dns
2. Scroll to **"HTTPS Certificates"**
3. Click **"Enable HTTPS"**

Free, takes effect immediately, applied to every node tagged in your tailnet.

Without this, the test VM will join the tailnet successfully and every
sidecar's `tailscaled` will report:

> serve proxy: this node is configured as a proxy that exposes an HTTPS
> endpoint to tailnet... but it is not able to issue TLS certs, so this
> will likely not work. To make it work, ensure that HTTPS is enabled
> for your tailnet

The container will still show as "running" in the test report (it is — it
just can't serve HTTPS), but visiting `https://<name>.<tailnet>.ts.net` in
a browser returns nothing.

### Generate the auth key

1. Go to https://login.tailscale.com/admin/settings/keys (in your test account)
2. Click "Generate auth key"
3. Settings:
   - **Reusable:** ON (lets you use the same key across multiple test runs —
     all 6 container sidecars need to register with it)
   - **Ephemeral:** OFF (we want to test the same flow real users do, not the
     ephemeral one)
   - **Tags:** check **`tag:container`** — REQUIRED. Every container sidecar
     advertises this tag and the control plane will reject registration
     without it. You must have completed the ACL step above first.
   - **Expiration:** up to 90 days
4. Copy the key (starts with `tskey-auth-`)

### Generate the API access token

The API token is used by `setup.sh` to run preflight checks that catch common Tailscale misconfigurations (ACL missing `tag:container`, auth key not reusable or expired) before any container starts. It's also used by the web admin's live Tailscale health panel and by `hetzner-test.sh` to clean up test nodes.

1. Go to https://login.tailscale.com/admin/settings/keys (same page)
2. Scroll down to "API access tokens" and click "Generate access token"
3. Description: "do-it-self test cleanup" or similar
4. Expiration: up to 90 days
5. Copy the token (starts with `tskey-api-`)

### Run a Tailscale test

```bash
scripts/hetzner-test.sh \
  --ts-key tskey-auth-xxxxxxxxxxxxx \
  --ts-api-token tskey-api-xxxxxxxxxxxxx
```

The tailnet name is auto-detected from the API token (it uses Tailscale's
default tailnet for the token). Pass `--ts-tailnet your-name.ts.net` only
if your token has access to multiple tailnets and you need to disambiguate.

This will:

1. Provision the Hetzner server
2. Run setup.sh which joins the test tailnet automatically
3. Auto-detect your TS_DOMAIN and write it (along with TS_AUTHKEY) to Infisical
4. Enable a curated set of containers (searxng, freshrss, the-lounge, uptime, kanboard, paste)
5. Start them and verify they're running
6. Destroy the server
7. Remove the host node and every container sidecar from the tailnet via the API

## Server Types

`hcloud server-type list`

See the Hetzner site for costs.

- "cx" are the "Cost Optimized" options.
- "cpx" are the "General usage" options.
  There are others.

Note that not all types exist in all locations.

## Location List

`hcloud location list`

## What Gets Tested

1. All prerequisites install correctly (Docker, Node, PM2, Infisical, Tailscale)
2. Repository clones and config is auto-generated
3. HOST_NAME and DOCKER_GID are auto-detected
4. Web-admin builds, starts, and API responds
5. Infisical bootstraps and secrets can be read/written
6. .env generation produces valid files
7. Docker Compose configs parse without errors
