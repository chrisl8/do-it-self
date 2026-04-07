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

The API token is needed to remove the test node from the tailnet after the server is destroyed.

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
