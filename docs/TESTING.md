# End-to-End Testing with Hetzner Cloud

Test the full setup flow on a fresh Ubuntu server. Creates a VPS, runs setup.sh via curl|bash (same as a real user), validates everything, and tears it down.

## One-Time Setup

1. Create a [Hetzner Cloud](https://www.hetzner.com/cloud/) account
2. Install the CLI: `brew install hcloud` (or see [releases](https://github.com/hetznercloud/cli/releases))
3. Create a project and authenticate:
   ```bash
   hcloud context create do-it-self-test
   # Paste your API token when prompted
   ```
4. Register your SSH key:
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

| Flag | Description |
|------|-------------|
| `--keep` | Don't destroy server after test |
| `--destroy` | Just destroy the test server |
| `--retest` | Run tests on existing server |
| `--type cx32` | Server type (default: cx22) |
| `--location ash` | Location (default: ash / Ashburn VA) |
| `--ts-key KEY` | Tailscale auth key for full integration test |

## Server Types

| Type | vCPU | RAM | Disk | ~Cost/hour |
|------|------|-----|------|------------|
| cx22 | 2 | 4GB | 40GB | €0.005 |
| cx32 | 4 | 8GB | 80GB | €0.007 |
| cx42 | 8 | 16GB | 160GB | €0.019 |

A typical test run takes 10-15 minutes and costs less than €0.01.

## What Gets Tested

1. All prerequisites install correctly (Docker, Node, PM2, Infisical, Tailscale)
2. Repository clones and config is auto-generated
3. HOST_NAME and DOCKER_GID are auto-detected
4. Web-admin builds, starts, and API responds
5. Infisical bootstraps and secrets can be read/written
6. .env generation produces valid files
7. Docker Compose configs parse without errors
