# Remote Backup Pi — Provisioning Spec

## Overview

A provisioning script (`setup-backup-pi.sh`) that configures a Raspberry Pi as a headless, network-isolated remote backup node. The Pi receives backups from two sources over Tailscale:

- **Borg** — from a Linux home server (server system data)
- **Kopia** — from a Windows desktop client (user files via marker-based backup system)

The Pi is designed to be provisioned at home, seeded with an initial full backup over LAN, then physically shipped to a remote location (friend or family member's house) where it runs unattended.

## Deliverables

This spec produces **one artifact**: `setup-backup-pi.sh` — a single bash script. Claude Code can build this on any platform (Windows, Mac, Linux) since it's just a text file. Nothing needs to compile or run locally.

The script generates all supporting files during execution on the Pi (health check script, borg prune script, kopia systemd unit, msmtp config, cron entries). These are not separate deliverables.

## Prerequisites — Before Running the Script

These steps are done **manually by hand** before the provisioning script enters the picture:

### 1. Flash the SD Card

On your Windows desktop, use [Raspberry Pi Imager](https://www.raspberrypi.com/software/):

1. Select **Raspberry Pi OS Lite (64-bit, Bookworm)** — no desktop environment
2. Click the gear icon (advanced settings) and configure:
   - Hostname: `backup-pi`
   - Enable SSH: **Yes** (password authentication)
   - Username: `piadmin`
   - Password: a strong password (you'll use this for initial SSH and emergency console access)
   - WiFi: only if ethernet won't be available during initial setup
   - Locale/timezone: your preference
3. Flash to the MicroSD card

### 2. Boot the Pi

1. Insert the SD card into the Pi
2. Plug in the USB backup drive
3. Plug in ethernet to your home router
4. Plug in power — the Pi will boot

### 3. Find the Pi on Your Network

Wait ~60 seconds for it to boot, then find its IP:

```
ping backup-pi.local
```

Or check your router's DHCP client list.

### 4. SSH In and Copy the Script

```
scp setup-backup-pi.sh piadmin@backup-pi.local:~/
ssh piadmin@backup-pi.local
```

### 5. Edit Configuration and Run

```bash
nano ~/setup-backup-pi.sh    # Edit the config variables at the top
sudo bash ~/setup-backup-pi.sh
```

### 6. Before Running: Have These Ready

You'll need the following values to fill in the script's configuration section:

- **Tailscale pre-auth key** — generate from [Tailscale admin console](https://login.tailscale.com/admin/settings/keys) (reusable, set an expiry)
- **Borg repo passphrase** — generate a strong passphrase and store it in your password manager
- **Kopia repo password** — generate a strong password and store it in your password manager
- **Kopia server control password** — a separate password for the server management API
- **SMTP credentials** — app-specific password from your SMTP provider for sending alert emails (Fastmail used as the default example, but any provider works — set `SMTP_HOST` and `SMTP_PORT` in the conf)

## Hardware

| Component       | Spec                                | Notes                                                         |
| --------------- | ----------------------------------- | ------------------------------------------------------------- |
| Raspberry Pi    | Pi 4 (2GB) or Pi 5 (2GB)            | 2GB is sufficient; borg/kopia are I/O bound not RAM bound     |
| MicroSD card    | 32GB, Class A2                      | OS only — all backup data goes to USB drive                   |
| USB drive       | 6 TB external USB HDD               | Bus-powered 2.5" or externally-powered 3.5" — must be USB 3.0 |
| Power supply    | Official USB-C PSU for the Pi model | Use the official one to avoid undervoltage issues             |
| Ethernet cable  | Cat5e or better                     | Wired connection strongly preferred over WiFi for reliability |
| Case (optional) | Any passive-cooled case             | Keeps dust out, no fan needed for this workload               |

## Network Architecture

### Isolation Model

The Pi's entire security model is: **LAN is untrusted, Tailscale is trusted.**

```
Internet
    │
    ▼
┌──────────────┐
│ Host's Router │  ◄── Pi gets DHCP address here, outbound internet only
└──────┬───────┘
       │ eth0 (LAN) — FIREWALLED
       │   • No inbound connections accepted
       │   • Outbound allowed (Tailscale, apt, DNS, NTP)
       │
┌──────┴───────┐
│  Raspberry Pi │
└──────┬───────┘
       │ tailscale0 (100.x.x.x) — ALL SERVICES HERE
       │   • SSH (port 22)
       │   • Borg (via SSH)
       │   • Kopia server (port 51515)
       │
       ▼
  Tailscale Network
    │         │
    ▼         ▼
 Linux     Neuromancer
 Server    (Windows)
```

### Firewall Rules (ufw)

```bash
# Default: deny all incoming, allow all outgoing
ufw default deny incoming
ufw default allow outgoing

# Allow everything on the Tailscale interface
ufw allow in on tailscale0

# Allow DHCP on LAN interface (needed to get an IP)
ufw allow in on eth0 from any port 67 to any port 68 proto udp

# Enable
ufw enable
```

This means:

- Devices on the host's LAN **cannot** reach the Pi at all (no SSH, no ping, nothing)
- The Pi **can** reach the internet outbound (Tailscale, apt updates, DNS)
- All services (SSH, borg, kopia) are accessible **only** over Tailscale
- The Pi is invisible to the host network

### Tailscale Configuration

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key=<PRE_AUTH_KEY> --ssh --hostname=backup-pi
```

- `--auth-key`: Use a reusable, pre-authorized auth key from the Tailscale admin console. Set an expiry (90 days) and tag it appropriately.
- `--ssh`: Enables Tailscale SSH, so SSH access is authenticated via Tailscale identity — no need to manage SSH keys on the Pi itself.
- `--hostname`: Sets the Tailscale hostname so other devices can reach it as `backup-pi` via MagicDNS.

**Important:** Generate the auth key just before provisioning. If using a reusable key for multiple Pi nodes in the future, store it securely and rotate it periodically.

## Operating System

### Base Image

- **Raspberry Pi OS Lite (64-bit, Bookworm)**
- No desktop environment
- Flash with Raspberry Pi Imager
- In Imager's advanced settings (gear icon), pre-configure:
  - Hostname: `backup-pi`
  - Enable SSH (password authentication for initial setup)
  - Set username: `piadmin` (not the default `pi`)
  - Set a strong password
  - Configure WiFi only if ethernet won't be available during initial setup at home
  - Set locale/timezone

### Emergency Console Access

Raspberry Pi OS Lite displays a standard TTY login prompt on HDMI by default. No additional configuration needed. If someone plugs in a monitor and keyboard at the remote location, they will see:

```
backup-pi login: _
```

They can log in with the `piadmin` credentials. This is the "break glass" access path for when Tailscale is unreachable and someone needs to be walked through diagnostics over the phone.

**The local console login does NOT bypass the firewall.** Services only listen on the Tailscale interface. Local console access is only for system diagnostics, reboots, and network troubleshooting.

### Unattended Upgrades

```bash
apt install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

This ensures security patches are applied automatically. Borg and Kopia are stable enough that apt upgrades rarely break anything.

## USB Drive Setup

### Formatting

```bash
# Identify the drive (usually /dev/sda)
lsblk

# Create a single partition and format as ext4
sudo parted /dev/sda mklabel gpt
sudo parted /dev/sda mkpart primary ext4 0% 100%
sudo mkfs.ext4 -L backupdrive /dev/sda1
```

### Mount Configuration

Add to `/etc/fstab`:

```
LABEL=backupdrive /mnt/backup ext4 defaults,noatime,nofail 0 2
```

- **`noatime`**: Reduces write overhead by not updating access times
- **`nofail`**: Critical — if the drive is unplugged or dies, the Pi still boots instead of hanging

```bash
sudo mkdir -p /mnt/backup
sudo mount -a
```

### Directory Structure

```
/mnt/backup/
├── borg/           # Borg repository (Linux server backups)
├── kopia/          # Kopia repository (Neuromancer backups)
└── health/         # Health check timestamps and logs
```

### Drive Health Monitoring

```bash
apt install smartmontools

# Test that SMART works with the USB enclosure (not all support it)
sudo smartctl -i /dev/sda
```

If SMART is supported, add a weekly check via cron. If not (common with USB enclosures), rely on filesystem checks and I/O error monitoring.

## Borg Setup

### Dedicated User

```bash
sudo useradd -m -s /bin/bash borg
sudo mkdir -p /mnt/backup/borg
sudo chown borg:borg /mnt/backup/borg
```

### Repository Initialization

Run this during provisioning (at home, before shipping):

```bash
sudo -u borg borg init --encryption=repokey-blake2 /mnt/backup/borg
```

- **`repokey-blake2`**: Encryption key stored in the repo, passphrase-protected. Faster than `repokey` (AES) on ARM.
- **CRITICAL:** Back up the repo key immediately after init:
  ```bash
  sudo -u borg borg key export /mnt/backup/borg /home/piadmin/borg-key-backup.txt
  ```
  Copy this key off the Pi and store it somewhere safe (password manager, printed in a safe). Without it, the repo is unrecoverable.

### Borg Access Over Tailscale

The Linux home server will connect to the Pi via Tailscale SSH:

```bash
# From the Linux server:
borg create borg@backup-pi:/mnt/backup/borg::home-{now:%Y-%m-%d} /path/to/data
```

No special borg daemon needed — borg runs over SSH natively. Since Tailscale SSH is enabled, the server authenticates via Tailscale identity.

### Borg Server-Side Restrictions (Optional but Recommended)

To limit what the remote borg client can do, restrict the borg user's SSH access. Create `/home/borg/.ssh/authorized_keys` with a forced command:

```
command="borg serve --restrict-to-path /mnt/backup/borg --append-only",restrict ssh-ed25519 AAAA... server-backup-key
```

- **`--restrict-to-path`**: Client can only access this repo
- **`--append-only`**: Client can create new archives but cannot delete or prune (protects against ransomware or accidental deletion from the server side)

**Note:** With `--append-only`, pruning must be done directly on the Pi (over Tailscale SSH as piadmin). This is a deliberate security trade-off.

If using Tailscale SSH exclusively (no traditional SSH keys), this restriction is configured differently — the `borg serve` restriction would need to be enforced via a wrapper script that Tailscale SSH invokes. This is a detail to work out during implementation.

## Kopia Server Setup

### Dedicated User

```bash
sudo useradd -m -s /bin/bash kopiauser
sudo mkdir -p /mnt/backup/kopia
sudo chown kopiauser:kopiauser /mnt/backup/kopia
```

### Repository Initialization

```bash
sudo -u kopiauser kopia repository create filesystem \
    --path /mnt/backup/kopia \
    --password <REPO_PASSWORD>
```

Store this password securely — it's needed to connect from Neuromancer.

### Kopia Server Mode

Kopia can run as a server that clients connect to over HTTPS. This is how Neuromancer will push backups to the Pi.

Create a systemd service at `/etc/systemd/system/kopia-server.service`:

```ini
[Unit]
Description=Kopia Repository Server
After=network-online.target tailscaled.service
Wants=network-online.target
RequiresMountsFor=/mnt/backup

[Service]
Type=simple
User=kopiauser
Group=kopiauser
ExecStart=/usr/bin/kopia server start \
    --address=100.x.x.x:51515 \
    --tls-generate-cert \
    --server-control-password=<SERVER_CONTROL_PASSWORD> \
    --no-legacy-api
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

**Important configuration:**

- **`--address=100.x.x.x:51515`**: Bind ONLY to the Tailscale IP, not `0.0.0.0`. This ensures the Kopia server is not accessible from the LAN, only over Tailscale. Replace `100.x.x.x` with the Pi's actual Tailscale IP.
- **`--tls-generate-cert`**: Auto-generates a TLS certificate for encrypted transport.
- **`--server-control-password`**: Password for server management API.

```bash
sudo systemctl daemon-reload
sudo systemctl enable kopia-server
sudo systemctl start kopia-server
```

### Connecting Neuromancer to the Kopia Server

On the Windows desktop, connect KopiaUI to the remote server:

```
kopia repository connect server \
    --url https://backup-pi:51515 \
    --server-cert-fingerprint <FINGERPRINT> \
    --password <REPO_PASSWORD> \
    --config-file repository-remote.config
```

The `--server-cert-fingerprint` is printed when the Kopia server first starts. Record it during provisioning.

### Kopia Server User Management

Add Neuromancer as an authorized user on the server:

```bash
# On the Pi
kopia server user add chris10@wintermute --user-password <USER_PASSWORD>
```

This allows the Windows Kopia client to authenticate and create snapshots.

## Monitoring & Health Checks

### Backup Freshness

Create a script at `/home/piadmin/check-health.sh`:

```bash
#!/bin/bash

# Check if backup drive is mounted
if ! mountpoint -q /mnt/backup; then
    echo "CRITICAL: Backup drive not mounted" | mail -s "[Backup Pi] Drive not mounted" user@example.com
    exit 1
fi

# Check disk usage
USAGE=$(df --output=pcent /mnt/backup | tail -1 | tr -d ' %')
if [ "$USAGE" -gt 85 ]; then
    echo "WARNING: Backup drive at ${USAGE}% capacity" | mail -s "[Backup Pi] Disk space warning" user@example.com
fi

# Check borg repo - last archive timestamp
LAST_BORG=$(sudo -u borg borg list --last 1 --format '{time}' /mnt/backup/borg 2>/dev/null)
# Parse and compare to threshold (e.g., 48 hours)

# Check kopia server is running
if ! systemctl is-active --quiet kopia-server; then
    echo "WARNING: Kopia server is not running" | mail -s "[Backup Pi] Kopia server down" user@example.com
    systemctl start kopia-server  # Attempt restart
fi

# Touch a health file for external monitoring
date > /mnt/backup/health/last-check.txt
```

Schedule via cron:

```
0 */6 * * * /home/piadmin/check-health.sh
```

### External Monitoring (Optional)

Ping a healthcheck endpoint (e.g., healthchecks.io free tier) from the health check script. If the ping stops, you get alerted that the Pi is offline.

```bash
curl -fsS --retry 3 https://hc-ping.com/<CHECK_UUID> > /dev/null
```

### Disk Space Alerts

In addition to the percentage-based check, monitor absolute free space:

```bash
FREE_GB=$(df --output=avail /mnt/backup | tail -1)
FREE_GB=$((FREE_GB / 1048576))
if [ "$FREE_GB" -lt 500 ]; then
    # Less than 500 GB free — send alert
fi
```

### Borg Repo Health

Schedule a weekly `borg check`:

```
0 4 * * 0 sudo -u borg borg check /mnt/backup/borg 2>&1 | logger -t borg-check
```

This verifies repository integrity. It's I/O intensive so run it during off-hours.

## Provisioning Script

### Design

A single `setup-backup-pi.sh` script that runs after flashing the SD card and booting the Pi for the first time. It should be idempotent (safe to run multiple times).

### Variables at Top of Script

```bash
#!/bin/bash
set -euo pipefail

# ============================================================
# CONFIGURATION — Edit these before running
# ============================================================

# Tailscale
# https://login.tailscale.com/admin/settings/keys
TAILSCALE_AUTH_KEY="tskey-auth-XXXXXXXX"
TAILSCALE_HOSTNAME="backup-pi"

# Borg
BORG_REPO_PATH="/mnt/backup/borg"
BORG_REPO_PASSPHRASE="CONFIGURE_ME"

# Kopia
KOPIA_REPO_PATH="/mnt/backup/kopia"
KOPIA_REPO_PASSWORD="CONFIGURE_ME"
KOPIA_SERVER_CONTROL_PASSWORD="CONFIGURE_ME"
KOPIA_SERVER_PORT=51515

# USB Drive
DRIVE_DEVICE="/dev/sda"
DRIVE_LABEL="backupdrive"
MOUNT_POINT="/mnt/backup"

# Email for alerts (configured later for msmtp or similar)
ALERT_EMAIL="CONFIGURE_ME"

# ============================================================
# END CONFIGURATION
# ============================================================
```

### Script Steps (in order)

1. **System update**

   ```bash
   apt update && apt upgrade -y
   ```

2. **Install packages**

   ```bash
   apt install -y borgbackup ufw smartmontools msmtp msmtp-mta mailutils unattended-upgrades
   ```

   Kopia is not in the default repos — install from Kopia's official repo:

   ```bash
   curl -s https://kopia.io/signing-key | gpg --dearmor -o /usr/share/keyrings/kopia-keyring.gpg
   echo "deb [signed-by=/usr/share/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" > /etc/apt/sources.list.d/kopia.list
   apt update && apt install -y kopia
   ```

3. **Format and mount USB drive**
   - Check if already formatted (idempotent)
   - Partition, format ext4 with label
   - Add fstab entry
   - Mount
   - Create directory structure

4. **Create service users**

   ```bash
   useradd -m -s /bin/bash borg
   useradd -m -s /bin/bash kopiauser
   ```

5. **Set directory permissions**

   ```bash
   mkdir -p /mnt/backup/{borg,kopia,health}
   chown borg:borg /mnt/backup/borg
   chown kopiauser:kopiauser /mnt/backup/kopia
   chown piadmin:piadmin /mnt/backup/health
   ```

6. **Install and configure Tailscale**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   tailscale up --auth-key="$TAILSCALE_AUTH_KEY" --ssh --hostname="$TAILSCALE_HOSTNAME"
   ```

7. **Get Tailscale IP** (needed for Kopia server binding and firewall)

   ```bash
   TAILSCALE_IP=$(tailscale ip -4)
   ```

8. **Configure firewall**

   ```bash
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow in on tailscale0
   ufw --force enable
   ```

9. **Initialize Borg repo**

   ```bash
   sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
       borg init --encryption=repokey-blake2 "$BORG_REPO_PATH"
   # Export key for backup
   sudo -u borg BORG_PASSPHRASE="$BORG_REPO_PASSPHRASE" \
       borg key export "$BORG_REPO_PATH" /home/piadmin/borg-key-backup.txt
   echo "!!! SAVE THIS KEY FILE AND STORE IT SECURELY !!!"
   ```

10. **Initialize Kopia repo and start server**

    ```bash
    sudo -u kopiauser kopia repository create filesystem \
        --path "$KOPIA_REPO_PATH" \
        --password "$KOPIA_REPO_PASSWORD"
    ```

    - Write systemd unit file (templated with `$TAILSCALE_IP` and `$KOPIA_SERVER_PORT`)
    - Enable and start the service
    - Print the TLS certificate fingerprint for the user to record

11. **Configure email alerts (msmtp)**

    ```bash
    # Write /etc/msmtprc with Fastmail SMTP settings
    # This allows the health check script to send email
    ```

12. **Install health check script and cron jobs**
    - Write `/home/piadmin/check-health.sh`
    - Add cron entries for health checks (every 6 hours) and borg check (weekly)

13. **Configure unattended upgrades**

14. **Print summary**

    ```
    ============================================
    Backup Pi provisioning complete!

    Tailscale IP:          100.x.x.x
    Tailscale hostname:    backup-pi

    Borg repo:             /mnt/backup/borg
    Borg key exported to:  /home/piadmin/borg-key-backup.txt
    >>> SAVE THIS KEY SECURELY AND DELETE FROM PI <<<

    Kopia server:          https://100.x.x.x:51515
    Kopia cert fingerprint: XXXXXXXX
    >>> RECORD THIS FINGERPRINT FOR CLIENT SETUP <<<

    Firewall:              Active (Tailscale only)
    Health checks:         Every 6 hours via cron

    Next steps:
    1. Save the borg key and kopia cert fingerprint
    2. Run initial borg backup from the Linux server
    3. Connect Neuromancer's KopiaUI to the remote server
    4. Run initial Kopia backup from Neuromancer
    5. Verify both backups with test restores
    6. Ship the Pi to the remote location
    ============================================
    ```

## Initial Backup Seeding (At Home)

Before shipping the Pi, run the full initial backups over LAN:

### Borg (from Linux server)

```bash
# First backup — this will take hours for TB-scale data
export BORG_PASSPHRASE="<passphrase>"
borg create --progress --stats \
    borg@backup-pi:/mnt/backup/borg::initial-{now:%Y-%m-%d} \
    /path/to/server/data

# Verify
borg check borg@backup-pi:/mnt/backup/borg
```

### Kopia (from Neuromancer)

1. Connect KopiaUI to the remote server using the cert fingerprint from provisioning
2. The backup-manager script will have already set up policies for all `.backupme` folders
3. Trigger a manual "Snapshot Now" for all sources
4. Wait for completion — this is the big initial transfer

### Verify Before Shipping

```bash
# Check borg repo size and integrity
ssh piadmin@backup-pi "sudo -u borg borg info /mnt/backup/borg"
ssh piadmin@backup-pi "sudo -u borg borg check /mnt/backup/borg"

# Check kopia repo size
ssh piadmin@backup-pi "du -sh /mnt/backup/kopia"

# Check total disk usage
ssh piadmin@backup-pi "df -h /mnt/backup"

# Check Tailscale is stable
ssh piadmin@backup-pi "tailscale status"
```

## Deployment at Remote Location

### Instructions for the Host

Provide the person hosting the Pi with simple instructions:

```
Setup Instructions for Backup Device
=====================================

1. Plug the black USB cable into the Pi (power)
2. Plug the USB drive into one of the blue USB ports on the Pi
3. Plug an ethernet cable from your router into the Pi

That's it! The device will start automatically.
The blue/green lights on the Pi mean it's working.

If I ask you to restart it: unplug the black USB cable,
wait 10 seconds, plug it back in.

You don't need to do anything else. Thank you!
```

### Post-Deployment Verification

After the Pi is set up at the remote location:

```bash
# Verify Tailscale connectivity
tailscale ping backup-pi

# Verify SSH access
ssh piadmin@backup-pi "uptime"

# Verify drive is mounted
ssh piadmin@backup-pi "mountpoint /mnt/backup && df -h /mnt/backup"

# Verify Kopia server is running
ssh piadmin@backup-pi "systemctl status kopia-server"

# Trigger a test borg backup
borg create --stats borg@backup-pi:/mnt/backup/borg::test-remote-{now:%Y-%m-%d} /tmp/testfile

# Trigger a test Kopia snapshot from Neuromancer
# (via KopiaUI "Snapshot Now" button)
```

## Maintenance

### Borg Pruning (Run from the Pi)

Since the borg repo may be in append-only mode from the server's perspective, pruning must be done on the Pi itself. Schedule a weekly prune via cron on the Pi:

```bash
# /home/piadmin/borg-prune.sh
#!/bin/bash
export BORG_PASSPHRASE="<passphrase>"  # Or use a key file
borg prune \
    --keep-daily 3 \
    --keep-weekly 2 \
    /mnt/backup/borg

borg compact /mnt/backup/borg
```

```
0 3 * * 0 /home/piadmin/borg-prune.sh 2>&1 | logger -t borg-prune
```

### Kopia Maintenance

Kopia runs automatic maintenance when the server is running. No additional cron needed. The retention policy set on the remote repo's global policy controls how many snapshots are kept.

### Remote Updates

Since unattended-upgrades handles security patches, manual intervention should be rare. When needed:

```bash
ssh piadmin@backup-pi "sudo apt update && sudo apt upgrade -y"
```

### Updating the Provisioning Script

The provisioning script is itself the upgrade mechanism — it's idempotent, so to pick up new features just copy the latest version over and re-run it:

```bash
scp setup-backup-pi.sh piadmin@backup-pi:~/
ssh piadmin@backup-pi "sudo bash setup-backup-pi.sh"
```

(After the first install, `/etc/backup-pi.conf` already holds the secrets, so no conf path argument is needed on re-run.)

What re-running does:

- **Detects existing state and skips** — packages, service users, drive label/mount, borg/kopia repo init, Tailscale connection. These are one-time setup steps; the script checks for them before acting.
- **Unconditionally rewrites generated files** — `/home/$ADMIN_USER/check-health.sh`, `/home/$ADMIN_USER/borg-prune.sh`, `/etc/msmtprc`, `/etc/systemd/system/kopia-server.service`, `/etc/cron.d/backup-pi`, `/usr/local/bin/borg-serve-only.sh`. This is how new features actually land, so **don't hand-edit these files** — your changes will be lost on the next re-run. If you need a custom check or cron job, add it as a separate sibling script.
- **Never touches `/etc/backup-pi.conf`** — your stored secrets are safe across upgrades.

#### Adding new conf variables

The convention is to declare new config vars with shell-default fallbacks at the top of the script, e.g.:

```bash
NEW_FEATURE_FLAG="${NEW_FEATURE_FLAG:-default-value}"
```

This means an existing `/etc/backup-pi.conf` that doesn't mention the new var keeps working unchanged. The new var is opt-in: to override the default, append a line to `/etc/backup-pi.conf` and re-run.

To discover what's new since you last set things up, diff your conf against the example in the repo:

```bash
ssh piadmin@backup-pi "sudo cat /etc/backup-pi.conf" | diff - setup-backup-pi.conf.example
```

For features that *require* a secret with no sensible default (e.g., a new third-party API key), add the variable to the `CONFIGURE_ME` preflight check loop in the script. The script will fail fast with a clear error pointing at the missing var, telling the user exactly what to add to their conf.

### Drive Replacement

If the USB drive fails:

1. SSH into the Pi
2. Plug in a new drive
3. Re-run the drive formatting portion of the setup script
4. Re-init the borg and kopia repos
5. Initial backups will need to re-seed (there is no shortcut here — the data must transfer again)

## File Structure on the Pi

```
/home/piadmin/
├── check-health.sh             # Health monitoring script
├── borg-prune.sh               # Borg pruning script
└── borg-key-backup.txt         # DELETE AFTER SAVING ELSEWHERE

/mnt/backup/
├── borg/                       # Borg repository
├── kopia/                      # Kopia repository
└── health/
    └── last-check.txt          # Timestamp of last health check

/etc/systemd/system/
└── kopia-server.service        # Kopia server systemd unit

/etc/msmtprc                    # Email relay config for alerts
```

## Security Summary

| Layer                 | Protection                                                                        |
| --------------------- | --------------------------------------------------------------------------------- |
| Network               | UFW blocks all LAN inbound; services only on Tailscale interface                  |
| Transport             | Tailscale (WireGuard) encrypts all traffic between nodes                          |
| SSH access            | Tailscale SSH — no password auth over network, no exposed SSH port on LAN         |
| Borg data at rest     | repokey-blake2 encryption — data unreadable without passphrase                    |
| Kopia data at rest    | Repository password encryption — data unreadable without password                 |
| Borg write protection | append-only mode from server (optional) — compromised server can't delete backups |
| Console access        | Local TTY login available for emergency diagnostics only                          |
| OS updates            | Unattended upgrades for security patches                                          |

## Future: Multiple Pi Nodes

This setup is designed to be repeatable. To deploy a second Pi at another location:

1. Flash a new SD card
2. Edit the configuration variables (different hostname, new Tailscale auth key, new passwords)
3. Run the provisioning script
4. Seed initial backups
5. Ship

Each Pi is a fully independent backup target. The borg repo and kopia repo on each Pi are separate — there is no replication between Pi nodes.

## Relationship to Client-Side Tooling

The Pi provisioning script sets up the infrastructure that client-side backup tooling targets:

```
Windows desktop client (Kopia)
    │
    ├── Manages Kopia policies on LOCAL repo (home server)
    │       └── KopiaUI takes snapshots per schedule
    │
    └── Manages Kopia policies on REMOTE repo (this Pi)
            └── KopiaUI takes snapshots per schedule, pushed over Tailscale

Linux home server cron job (see scripts/borg-backup.sh)
    └── Runs borg create to REMOTE repo (this Pi) over Tailscale
```
