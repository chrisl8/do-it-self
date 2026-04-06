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

| Flag                | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `--keep`            | Always keep the server (don't destroy even on success)       |
| `--no-keep-if-fails`| Destroy server even if tests fail (default: keep on failure) |
| `--destroy`         | Just destroy the test server                                 |
| `--retest`          | Run tests on existing server                                 |
| `--type cx33`       | Server type (default: cx23)                                  |
| `--location ash`    | Location (default: nbg1 / Nuremberg, Germany)                |
| `--ts-key KEY`      | Tailscale auth key for full integration test                 |

## Logs

After each run, logs are saved to `/tmp/hetzner-test-logs/hetzner-test-<timestamp>/`:
- `setup.log` -- output from setup.sh on the server
- `cloud-init-output.log` -- last 200 lines of cloud-init's own log
- `cloud-init-status.txt` -- cloud-init status report
- `docker-state.log` -- containers and images on the server
- `file-state.log` -- key directories listing

If a test fails, the server is kept running by default so you can SSH in and investigate. Use `--no-keep-if-fails` to override.

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
