This folder contains scripts that I use to maintain my containers and the system that runs them.

Like the other bits, you will probably need to use these as examples rather than copying them directly, as they are highly personalized to my system.

# Script Notes

## all-containers.sh

**This is a fully automated script to stop, start, restart and update containers.**

I basically use this instead of something like Portainer to manage my system.

## Enabling/disabling containers

Use the web admin Configuration tab. The enabled state is stored in
`user-config.yaml` (gitignored). On a fresh install, only `infisical`
and `homepage` are enabled by default.

## system-cron-startup.sh

**This script will start everything on your system.**

This script is used to start up the containers when the system boots.  
**You need to edit it to remove stuff that you don't have, like my "Metatron" script.**

You should add it to crontab by running `crontab -e` and adding a line like this:
`@reboot $HOME/containers/scripts/system-cron-startup.sh`

## system-health-check.sh

**This script will check the health of your system and notify you if anything is down.**

I use Healthcheck.io with this. In order for that to work you must get a key from that site for yourself, and add it to a file called  
`healthcheck.conf`  
with contents that look like this:  
`HEALTHCHECK_PING_KEY=YOUR_HEALTHCHECK_PING_KEY`

This script also checks for down Tailscale devices and notifies about them. However you likely have many that you don't care about, so you can create a file called:  
`excluded_devices.conf`  
and add the following lines:

```
EXCLUDED_DEVICES_FOR_EMAIL="mycomputer1|mycomputer2|myphone"
EXCLUDED_DEVICES_FOR_ERROR_COUNT="this-server|something-else"
```

Note the use of the `|` character to separate entries.

The first entry excludes things from all checks, including emailing you.  
Devices in the second entry only will still send you an email if they are down, but they won't result in an "error" state flagging the system as "down" in healtchecks.io

## setup-backup-pi.sh

**This script provisions a Raspberry Pi as an offsite backup target for Borg + Kopia.**

It's the server-side counterpart to `borg-backup.sh` (which pushes backups *to* this Pi). Designed to run on a fresh Raspberry Pi OS Lite install with a USB drive plugged in. It sets up Tailscale, an append-only Borg repo, a Kopia server, email alerts via SMTP, and weekly prune/check cron jobs.

Usage:

1. Copy `setup-backup-pi.conf.example` to `backup-pi.conf`, fill in the `CONFIGURE_ME` values, and `scp` it to the Pi along with the script.
2. On the Pi: `sudo bash setup-backup-pi.sh /path/to/backup-pi.conf`

The script is idempotent — re-running it handles drive replacement and config updates safely. After the first run the conf is persisted to `/etc/backup-pi.conf` so subsequent runs only need the script.

### Updating an existing Pi

To pick up new features after the script has been updated, just `scp` the latest `setup-backup-pi.sh` to the Pi and re-run it — no flags or special mode needed:

```bash
scp setup-backup-pi.sh piadmin@backup-pi:~/
ssh piadmin@backup-pi "sudo bash setup-backup-pi.sh"
```

What re-running does:
- **Skips** packages, users, drive format, borg/kopia repo init, and Tailscale auth that are already done.
- **Overwrites** the generated helper scripts (`/home/$ADMIN_USER/check-health.sh`, `borg-prune.sh`), `/etc/msmtprc`, the kopia systemd unit, `/etc/cron.d/backup-pi`, and `/usr/local/bin/borg-serve-only.sh`. This is how new behavior actually lands — so don't hand-edit those files; add a sibling script if you need a custom check.
- **Never touches** `/etc/backup-pi.conf` (your secrets stay).

When new conf vars are added, they always have sensible defaults (`${VAR:-...}`) so an old conf keeps working. To see what's available to opt into, diff `/etc/backup-pi.conf` against the current `setup-backup-pi.conf.example`.

See `docs/SETUP-BACKUP-PI.md` for the full provisioning spec — what to flash to the SD card, how to ship the Pi, how to connect clients, and drive-replacement procedures.
