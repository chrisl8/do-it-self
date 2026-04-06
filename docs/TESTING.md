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

| Flag                       | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `--keep`                   | Always keep the server (don't destroy even on success)       |
| `--no-keep-if-fails`       | Destroy server even if tests fail (default: keep on failure) |
| `--destroy`                | Just destroy the test server                                 |
| `--retest`                 | Run tests on existing server                                 |
| `--type cx33`              | Server type (default: cx23)                                  |
| `--location ash`           | Location (default: nbg1 / Nuremberg, Germany)                |
| `--ts-key KEY`             | Tailscale auth key (joins server, enables container startup) |
| `--ts-api-token TOKEN`     | Tailscale API token (for removing the node after destruction)|
| `--ts-tailnet TAILNET`     | Tailnet name for API calls (e.g. your-name.ts.net)           |

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

## Tailscale Integration Testing

By default the Hetzner test validates setup, env generation, and the API but does NOT actually start containers (because they all need Tailscale). To do a full test that starts a curated set of containers, you need a Tailscale account and two keys.

### Use a separate test tailnet

Don't pollute your real Tailscale network with ephemeral test machines. Create a dedicated test tailnet:

1. Create a free Tailscale account at https://tailscale.com using a different SSO provider (e.g. a different Google account) than your production Tailscale account
2. Free tier supports 100 devices and 3 users -- plenty for testing

### Generate the auth key

1. Go to https://login.tailscale.com/admin/settings/keys (in your test account)
2. Click "Generate auth key"
3. Settings:
   - **Reusable:** ON (lets you use the same key across multiple test runs)
   - **Pre-authorized:** ON (no manual approval needed)
   - **Ephemeral:** OFF (we want to test the same flow real users do, not the ephemeral one)
   - **Tags:** optional
   - **Expiration:** up to 90 days
4. Copy the key (starts with `tskey-auth-`)

### Generate the API access token

The API token is needed to remove the test node from the tailnet after the server is destroyed.

1. Go to https://login.tailscale.com/admin/settings/keys (same page)
2. Scroll down to "API access tokens" and click "Generate access token"
3. Description: "do-it-self test cleanup" or similar
4. Expiration: up to 90 days
5. Copy the token (starts with `tskey-api-`)

### Find your tailnet name

Visit the Tailscale admin console; the tailnet name is shown in the URL or settings (e.g. `your-name.ts.net`).

### Run a Tailscale test

```bash
scripts/hetzner-test.sh \
  --ts-key tskey-auth-xxxxxxxxxxxxx \
  --ts-api-token tskey-api-xxxxxxxxxxxxx \
  --ts-tailnet your-test-tailnet.ts.net
```

This will:
1. Provision the Hetzner server
2. Run setup.sh which joins the test tailnet automatically
3. Auto-detect your TS_DOMAIN and write it (along with TS_AUTHKEY) to Infisical
4. Enable a curated set of containers (searxng, freshrss, the-lounge, uptime, kanboard, paste)
5. Start them and verify they're running
6. Destroy the server
7. Remove the test node from the tailnet via the API

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
