# Maintenance Guide

Day-to-day operations for keeping the server running. Most things are automated — this covers what you need to do manually and what to check when something goes wrong.

## What runs automatically

Three cron jobs are installed by `setup.sh`:

| Schedule | Script | What it does |
|----------|--------|--------------|
| `@reboot` | `system-cron-startup.sh` | Stops orphaned containers from a hard shutdown, starts all enabled containers, starts web admin via PM2, runs `post-startup-hook.sh` if present |
| `*/15 * * * *` | `system-health-check.sh` | Restarts unhealthy containers, ensures web admin is up, runs `post-health-hook.sh` if present (self-heals non-container services), checks Tailscale device connectivity, warns if the TS auth key expires within 14 days, pings healthchecks.io |
| `0 */6 * * *` | `kopia-backup-check.sh` | Checks Kopia backup freshness against per-host thresholds |

If BorgBackup is configured (`setup-borg-backup.sh`), two more are added:

| Schedule | Script | What it does |
|----------|--------|--------------|
| `0 3 * * *` | `borg-backup.sh` | Nightly backup: DB dumps, local Borg archive, prune, optional remote sync |
| `0 6 * * 0` | `borg-restore-test.sh` | Weekly restore test (Sundays) |

If other hosts push borg archives into this machine via `borg serve` (e.g. wintermute's borgmatic writing to `/mnt/22TB/borg/backups/<host>`), add a freshness check for those inbound repos:

| Schedule | Script | What it does |
|----------|--------|--------------|
| `40 */6 * * *` | `borg-inbound-check.sh` | Auto-enumerates inbound borg repos under `BORG_INBOUND_REPOS_ROOT`, reports each repo's newest-archive freshness (48h default threshold) to the web admin's Backup Status page; optional healthchecks.io ping |

```cron
# Inbound borg freshness check (repos other hosts push into this machine)
40 */6 * * * /home/chrisl8/containers/scripts/borg-inbound-check.sh
```

The `:40` offset keeps it clear of the borg-backup remote-push and borg-pi-manage windows. It reads each repo with `--lock-wait`, so it won't fail if a push is in progress.

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

The upgrade script runs `apt update && apt upgrade && apt autoremove` with pre- and post-flight checks. It does not reboot automatically — you decide when.

Pre-flight checks (script aborts on failure):
- Enforces that `unattended-upgrades` is disabled — see below.
- On hosts with NVIDIA: verifies `nvidia-smi` and DKMS show a healthy driver for the running kernel. The script refuses to start if the driver is already broken so you can fix that first instead of layering a kernel upgrade on top.

Post-flight: if a new kernel package was installed, the script runs `dkms autoinstall -k <new-kernel>` and verifies the NVIDIA module built before recommending a reboot. If DKMS fails, the script will tell you **not to reboot** until you re-run the NVIDIA installer.

Every run produces a transcript at `~/logs/system-os-upgrades-<timestamp>.log`.

### Why `unattended-upgrades` is disabled

The upgrade script is the **only** sanctioned path for installing package upgrades on hosts that use this repo. `unattended-upgrades` is disabled (and the script auto-disables it on every run as a regression guard) so the DKMS verification gate always runs before a kernel change, and so kernel upgrades never happen unattended at 6 AM with no operator present.

If you need to re-enable automatic upgrades for some reason, expect that the upgrade script will switch it back off the next time it runs.

### NVIDIA GPU driver

Kernel updates can break the NVIDIA driver. Two safety nets are in place:

1. **`system-os-upgrades.sh` post-flight gate** (above) catches a failed DKMS build before you reboot.
2. **`system-cron-startup.sh` boot-time check** tries one non-destructive recovery (`modprobe nvidia`, or `dkms autoinstall` for the running kernel) if `sudo -n` is permitted for those commands, then emails on failure. It also checks the NVENC patch state and alerts if it has been reverted.

If both safety nets fail, reinstall the driver as root:

```bash
sudo /opt/nvidia/NVIDIA-Linux-x86_64-*.run --dkms
sudo /opt/nvidia/nvidia-patch/patch.sh
```

GPU-dependent containers (jellyfin, obsidian, secure-browser) will fail to start until the driver is reinstalled.

**Emergency fallback:** if the system boots without a working driver and you need GPU containers up immediately, reboot and choose the previous kernel from GRUB's "Advanced options" menu. The NVIDIA module is still installed for that kernel, so containers will work while you fix DKMS for the newer one.

**Optional: enable boot-time auto-recovery.** The boot script attempts recovery via `sudo -n modprobe nvidia` / `sudo -n dkms autoinstall`. These succeed only if your user has passwordless sudo for those exact commands. To enable, add a sudoers rule in `/etc/sudoers.d/nvidia-recovery` (replace `youruser` with your username):

```
youruser ALL=(root) NOPASSWD: /usr/sbin/modprobe nvidia, /usr/sbin/dkms autoinstall -k *
```

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

### Post-update maintenance checks

Some services need follow-up steps after an image update that are easy to forget — Nextcloud in particular often needs a few `occ` commands run from the command line, and its admin Settings → Overview page can grow new warnings after a major version bump.

`scripts/all-containers.sh --get-updates` automatically runs `scripts/post-update-checks/<container>.sh` for any container that has one, right after that container's update finishes. This never fails the update itself — a checker records what it found (or any internal error) into `~/logs/post-update-checks/<container>.json` and always exits 0.

Findings surface in the web admin: a container with something to review gets a "Needs Attention" chip on its Docker Status row (click it to dismiss), plus an app-wide banner reminding you where to look. A dismissed finding reappears automatically if a later run reports something new — acks are keyed to that run's timestamp, not a one-time flag.

**Nextcloud** (`scripts/post-update-checks/nextcloud.sh`) automatically:

- waits for `occ status` to report installed and out of maintenance mode (a major upgrade runs its own `occ upgrade` on container start, which can take several minutes)
- runs the idempotent `occ db:add-missing-indices`, `occ db:add-missing-columns`, and `occ db:add-missing-primary-keys` and reports whether any of them actually did something
- scans `nextcloud.log` for new error-or-worse entries since the last check

It can't headlessly check everything, though — PHP opcache, `.htaccess`, and memory-caching warnings on Settings → Overview have no clean CLI equivalent, so the findings always include a reminder link to that page. Give it a glance after any major-version Nextcloud upgrade.

**Infisical** (`scripts/post-update-checks/infisical.sh`) has a different failure shape: it runs an irreversible DB migration on every startup, and every other container's secrets flow through it, but Docker's own healthcheck only curls `/api/status` — which can report healthy even when something more specific broke (this bit us once: a stale `DB_PASSWORD` leaking from the web admin's PM2 daemon into a bare `spawn()`, see git history around 2026-07-26). So this checker instead re-runs the exact `infisical export --path=/shared` call `all-containers.sh` itself relies on to inject shared secrets, plus checks the container's restart count — if secret export doesn't work post-update, nothing downstream will either, and that's worth knowing before touching any other container.

To add this for another container, drop an executable `scripts/post-update-checks/<container-dir-name>.sh` that writes a findings file to `~/logs/post-update-checks/<container-dir-name>.json` in the shape:

```json
{
  "timestamp": "2026-08-28T17:53:27-05:00",
  "status": "clean",
  "note": "human-readable summary",
  "reminderUrl": "https://... (optional link for anything the script can't check itself)"
}
```

`status` other than `"clean"` is what drives the "Needs Attention" chip and banner in the web admin.

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

### Non-container PM2 services (e.g. Metatron, Kryten) aren't running

PM2 is a single shared daemon with **no owner**: at boot, `system-cron-startup.sh`
starts web admin, then `post-startup-hook.sh` starts each personal app's PM2
processes (via that app's own `start-pm2.sh`). Nothing runs `pm2 resurrect` and
there is no PM2 systemd unit, so the `dump.pm2` file is written but never read —
recovery comes from **re-running the start scripts**, not from the dump.

That's fine at boot, but a mid-life PM2 daemon death (the whole daemon getting
SIGTERM'd — e.g. the last login/tmux session logging out while user *linger* is
disabled) kills every app, and only web admin has a `*/15` re-ensure. Non-container
apps would then stay down until the next reboot.

`post-health-hook.sh` closes that gap: it runs every health-check cycle and calls
each app's `ensure-running.sh` (in the app's own repo — e.g. `~/Metatron/ensure-running.sh`,
`~/Kryten/ensure-running.sh`). Those are **presence-based** (restart only apps
pm2 reports as missing or not `online`), silent when healthy, and deliberately do
**not** run `pm2 save` (a partial save would clobber the boot-owned dump). Net
effect: a killed app is back within ≤15 minutes instead of at the next reboot.

To recover immediately instead of waiting for the cycle, run the app's script
directly, e.g. `~/Metatron/ensure-running.sh` or `~/Metatron/start-pm2.sh`.

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
| `scripts/post-health-hook.sh` | Custom commands to run every health-check cycle (`*/15`) — used to self-heal non-container PM2 services (must be executable) |
