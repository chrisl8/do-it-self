# Maintenance Guide

Day-to-day operations for keeping the server running. Most things are automated — this covers what you need to do manually and what to check when something goes wrong.

## What runs automatically

Three cron jobs are installed by `setup.sh`:

| Schedule | Script | What it does |
|----------|--------|--------------|
| `@reboot` | `system-cron-startup.sh` | Stops orphaned containers from a hard shutdown, starts all enabled containers, starts web admin via PM2, runs `post-startup-hook.sh` if present |
| `*/15 * * * *` | `system-health-check.sh` | Restarts unhealthy containers, checks Tailscale device connectivity, warns if the TS auth key expires within 14 days, pings healthchecks.io |
| `0 */6 * * *` | `kopia-backup-check.sh` | Checks Kopia backup freshness against per-host thresholds |

If BorgBackup is configured (`setup-borg-backup.sh`), two more are added:

| Schedule | Script | What it does |
|----------|--------|--------------|
| `0 3 * * *` | `borg-backup.sh` | Nightly backup: DB dumps, local Borg archive, prune, optional remote sync |
| `0 6 * * 0` | `borg-restore-test.sh` | Weekly restore test (Sundays) |

Containers can also declare their own cron jobs in `module.yaml` — these are managed automatically when you enable or disable a container.

## Rebooting

Always use the graceful shutdown script, never raw `reboot` or `shutdown`. The script stops all containers in the correct order and stops PM2 before handing off to the OS:

```bash
scripts/system-graceful-shutdown.sh --reboot
```

Or to power off:

```bash
scripts/system-graceful-shutdown.sh --halt
```

On boot, the `@reboot` cron job handles everything. You can watch startup progress:

```bash
tail -f ~/logs/system-cron-startup.log
```

An email is sent when startup completes (or if there's a problem like a missing NVIDIA driver).

## OS patching

Run the upgrade script, then reboot:

```bash
scripts/system-os-upgrades.sh
scripts/system-graceful-shutdown.sh --reboot
```

The upgrade script runs `apt update && apt upgrade && apt autoremove`. It does not reboot automatically — you decide when.

### NVIDIA GPU driver

Kernel updates can break the NVIDIA driver. The startup script detects this and sends an email alert. If it happens, reinstall the driver as root:

```bash
/opt/nvidia/NVIDIA-Linux-x86_64-*.run --dkms
/opt/nvidia/nvidia-patch/patch.sh
```

GPU-dependent containers (jellyfin, obsidian, secure-browser) will fail to start until the driver is reinstalled.

## Applying container image updates

[DIUN](https://crazymax.dev/diun/) monitors Docker registries for new image versions. When updates are available, it writes a list to `pendingContainerUpdates.txt` and `container-update-reminder.sh` alerts you.

To apply the pending updates:

```bash
scripts/update-containers-from-diun-list.sh
```

This stops the affected containers, pulls new images, updates git repos, and restarts them. The pending-updates file is deleted on success.

For a manual full update of all containers:

```bash
scripts/all-containers.sh --stop --start --update-git-repos --get-updates
```

## Troubleshooting

### Containers didn't start after reboot

Check the startup log:

```bash
cat ~/logs/system-cron-startup.log
```

Verify cron is running the startup script:

```bash
crontab -l | grep system-cron-startup
```

### A container is unhealthy

The health check script auto-restarts unhealthy containers every 15 minutes. To check manually:

```bash
docker ps -a | grep -v "(healthy)"
```

To restart a specific container:

```bash
scripts/all-containers.sh --stop --start --container <name>
```

### Web admin isn't running

```bash
scripts/start-web-admin.sh start
```

Check PM2 status:

```bash
pm2 status
```

### Tailscale devices showing offline

The health check script reports offline Tailscale devices. Transient blips are normal — it waits 15 seconds and rechecks before alerting.

To exclude known-offline devices (phones, laptops) from alerts, create `scripts/excluded_devices.conf`:

```bash
EXCLUDED_DEVICES_FOR_EMAIL="my-phone|my-laptop"
EXCLUDED_DEVICES_FOR_ERROR_COUNT="my-phone"
```

### Tailscale auth key expiring

The health check warns when the key expires within 14 days. Mint a new one at:

https://login.tailscale.com/admin/settings/keys

Then update the key in Infisical.

## Optional configuration files

These are all gitignored — create them on your system if needed:

| File | Purpose |
|------|---------|
| `scripts/healthcheck.conf` | healthchecks.io API key (`HEALTHCHECK_PING_KEY=...`) |
| `scripts/excluded_devices.conf` | Tailscale devices to exclude from health alerts |
| `scripts/kopia-backup-check.conf` | Kopia freshness thresholds |
| `scripts/kopia-host-thresholds.json` | Per-host backup age limits |
| `scripts/borg-backup.conf` | BorgBackup paths, passphrases, remote settings |
| `scripts/post-startup-hook.sh` | Custom commands to run after boot (must be executable) |
