# Remote Backup Pi — Provisioning Spec

## Overview

A provisioning script (`setup-backup-pi.sh`) that configures a Raspberry Pi as a headless, network-isolated remote backup node. The Pi receives borg backups from multiple Linux clients over Tailscale (currently `neuromancer` and `wintermute`).

The Pi is **passive**: it accepts append-only `borg serve` connections from each client, and runs `borg-manage.sh` operations when the **manager** host (neuromancer) drives them via SSH with a per-operation passphrase forwarded over `SendEnv`. The Pi holds NO borg passphrases at rest, so physical theft yields encrypted trash.

Management is centralized on neuromancer via `scripts/borg-pi-manage.sh`, which fetches passphrases from Infisical at use-time and drives prune, check, freshness monitoring, and weekly restore-tests against every configured client repo.

The Pi is designed to be provisioned at home, seeded with an initial full backup over LAN, then physically shipped to a remote location (friend or family member's house) where it runs unattended.

## Deliverables

This spec produces:
- `scripts/setup-backup-pi.sh` — provisioning script that runs on the Pi.
- `scripts/setup-backup-pi.conf.example` — template for `/etc/backup-pi.conf`.
- `scripts/borg-pi-manage.sh` — management orchestrator that runs on neuromancer as `chrisl8` (not root). Drives daily prune+freshness, weekly check, weekly restore-test.
- `scripts/borg-pi-manage.conf.example` — template for the manager-side conf.

The setup script generates all supporting files on the Pi (the two wrappers, the sshd hardening drop-in, fail2ban jail, cron file, webadmin RPC scripts, sudoers). These are not separate deliverables.

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

- **Tailscale pre-auth key** — generate from [Tailscale admin console](https://login.tailscale.com/admin/settings/keys). MUST be reusable, non-ephemeral, and tagged with `tag:backup-target` (the tag must already exist in `tagOwners`; see Tailscale ACLs section below).
- **Borg repo passphrases** — one per client, stored in **Infisical on neuromancer** under `/borgbackup` as `BORG_REMOTE_PASSPHRASE` (neuromancer) and `BORG_REMOTE_PASSPHRASE_WINTERMUTE` (wintermute). The Pi never sees them at rest. The web admin's BackupPi page has a "Set passphrase" button per client that writes the value to Infisical via the local API (since Infisical is bound to `127.0.0.1` and not directly reachable from elsewhere on the tailnet). Source of truth for each passphrase is the matching client's borg config: `~/containers/scripts/borg-backup.conf` on neuromancer, the borgmatic config on wintermute. Read the value from there, paste into the web admin.
- **Manager SSH key** — generate on neuromancer as `chrisl8`: `ssh-keygen -t ed25519 -f ~/.ssh/borg-pi-mgmt -N "" -C "neuromancer-borg-pi-mgmt"`. Paste the `.pub` into `MANAGER_SSH_PUBKEY=` in `/etc/backup-pi.conf` on the Pi. This key drives all server-side management; treat as privileged.
- **Healthchecks.io URLs** — four total: one freshness check + one restore-test check per client. Configured in neuromancer's `borg-pi-manage.conf` (not on the Pi).

## Hardware

| Component       | Spec                                | Notes                                                         |
| --------------- | ----------------------------------- | ------------------------------------------------------------- |
| Raspberry Pi    | Pi 4 (2GB) or Pi 5 (2GB)            | 2GB is sufficient; borg is I/O bound, not RAM bound           |
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
       │ tailscale0 (100.x.x.x) — INBOUND-ONLY (per Tailscale ACL)
       │   • SSH (port 22) — only path into the Pi
       │   • Borg over SSH (backup + management paths)
       │
       ▼
  Tailscale Network
    │         │
    ▼         ▼
 Neuromancer  Wintermute
 (manager     (borg client)
  + client)
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
- The Pi **can** reach the internet outbound (apt updates, Tailscale coordination plane, DNS, NTP)
- All Pi services (SSH only) are accessible **over Tailscale only**
- The Pi is invisible to the host network

### Tailscale Configuration

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up \
    --auth-key=<PRE_AUTH_KEY> \
    --hostname=backup-pi \
    --advertise-tags=tag:backup-target
```

- `--auth-key`: Use a reusable, NON-ephemeral auth key from the Tailscale admin console. The key MUST be authorized to claim `tag:backup-target` — set the tag in the key's "Tags" field when generating it. Without that authorization, the `--advertise-tags` claim is refused and you have to manually authorize the device every reboot.
- `--advertise-tags=tag:backup-target`: Tags the Pi at join time so the tailnet ACL policy can restrict it (see *Tailscale ACLs* section below).
- `--hostname`: Sets the Tailscale hostname so other devices can reach it as `backup-pi` via MagicDNS.

**Why no `--ssh`:** Tailscale SSH would expose `backup-pi` as a Tailscale-SSH target. We don't want that — we want sshd to handle keyed auth with forced commands, and we want the Pi to be reachable only on the specific paths we provision (borg + webadmin RPC). The setup script explicitly runs `tailscale set --ssh=false` after join.

**Important:** Generate the auth key just before provisioning. If using a reusable key for multiple Pi nodes in the future, store it securely and rotate it periodically.

### SSH hardening + fail2ban

The provisioning script applies these at the sshd layer (unconditionally; there's no opt-in flag):

- `PasswordAuthentication no`
- `PermitRootLogin no`
- `AllowUsers <ADMIN_USER> borg [webadmin]` — webadmin only if `WEBADMIN_SSH_PUBKEY` is set
- fail2ban installed with an sshd jail (5 retries within 10 min → 1 h ban)

Tailscale-only access is enforced by **UFW**, not by sshd `ListenAddress`. UFW's `default deny incoming` + `allow in on tailscale0` already restricts sshd to the Tailscale interface at the kernel level; doing it again with `ListenAddress=<tailscale-ip>` is redundant and introduces a real boot-time race (sshd starting before tailscaled has assigned the IP, then failing to bind and refusing to start). An earlier version of this script had a `HARDEN_SSHD=true` opt-in that did the `ListenAddress` flip with a `127.0.0.1` console fallback; that path was removed after hitting the race in practice. The setup script will clean up any leftover `/etc/systemd/system/ssh.service.d/wait-tailscale.conf` from that era on the next re-run.

The script validates the rendered sshd_config with `sshd -t` before reloading, so a syntax error aborts the run instead of breaking sshd.

The sshd config also includes `AcceptEnv BORG_PASSPHRASE` and `AcceptEnv BORG_PASSPHRASE_*` — required for the management path (`borg-manage.sh`) and the web admin's status poll (`pi-status.sh`) to receive per-operation passphrases forwarded by the manager over `SendEnv`. Never broaden this to `AcceptEnv *` — that's a credential-leak hole.

### Tailscale ACLs

The Pi joins with `--advertise-tags=tag:backup-target`. By itself the tag does nothing — Tailscale's default ACL is "all members reach all members." To actually restrict the Pi to inbound-only (so a compromised Pi cannot pivot to other tailnet nodes), the operator must edit the tailnet's ACL policy in the admin console.

**Pre-requisite (one-time):**

1. Add the tag to `tagOwners` at [https://login.tailscale.com/admin/acls/file](https://login.tailscale.com/admin/acls/file):
   ```hujson
   "tagOwners": {
     "tag:backup-target": ["autogroup:admin"]
   }
   ```
2. Edit the auth key being used to join the Pi: under "Tags," add `tag:backup-target`. Without this, the Pi's `--advertise-tags` claim is rejected.

**ACL change** (the setup script's STEP 20 summary prints this verbatim at the end of each run):

Replace the default `{"action": "accept", "src": ["*"], "dst": ["*:*"]}` rule with:

```hujson
{
  "tagOwners": {
    "tag:backup-target": ["autogroup:admin"]
  },
  "acls": [
    // Your existing devices reach each other (preserves connectivity
    // between neuromancer, wintermute, anything else you have):
    {"action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:member:*"]},

    // Your devices reach the backup Pi on SSH only:
    {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:backup-target:22"]}

    // NO rule with src=tag:backup-target — the Pi is denied initiating
    // any tailnet connection.
  ]
}
```

**Verification** (after applying the ACL):

| From       | Command                                              | Expected         |
| ---------- | ---------------------------------------------------- | ---------------- |
| Pi         | `tailscale ping -c 1 -timeout 3s neuromancer`        | no path / fail   |
| Neuromancer| `tailscale ping -c 1 backup-pi`                      | success          |
| Pi         | `ssh -o ConnectTimeout=3 chrisl8@neuromancer 'true'` | timeout / refused|

The setup script's `STEP 8b` probe runs the first check automatically and warns if the Pi can still initiate outbound — that's a clear signal the ACL is not yet restrictive.

**What this protects against:** if the Pi is compromised (physical theft → tailscaled.state extracted, or remote root via some future vuln), the attacker has an SSH server they can be reached AT but cannot reach FROM. They can't enumerate neuromancer/wintermute or move laterally.

**What this does NOT change:** the Pi still reaches the public internet (apt repos, Tailscale coordination server). ACLs only govern tailnet-internal traffic.

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

This ensures security patches are applied automatically. The Pi runs only borgbackup, openssh-server, ufw, smartmontools, and fail2ban — a small package set, low blast radius for apt-upgrade surprises.

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
├── borg/                  # neuromancer's borg repo (legacy path)
└── borg-wintermute/       # wintermute's borg repo
                           # New clients go in /mnt/backup/borg-<name>
```

### Drive Health Monitoring

```bash
apt install smartmontools

# Test that SMART works with the USB enclosure (not all support it)
sudo smartctl -i /dev/sda
```

If SMART is supported, add a weekly check via cron. If not (common with USB enclosures), rely on filesystem checks and I/O error monitoring.

## Borg setup

### Pi-side schema (passphrase-free)

`/etc/backup-pi.conf` on the Pi holds **no** borg passphrases. Per-client passphrases live in Infisical on neuromancer (the manager) and are forwarded to the Pi over SSH `SendEnv` for each operation that needs them.

```sh
CLIENTS="neuromancer wintermute"

CLIENT_NEUROMANCER_PUBKEY="ssh-ed25519 …"   # backup-path key
CLIENT_NEUROMANCER_REPO_PATH="/mnt/backup/borg"          # legacy path

CLIENT_WINTERMUTE_PUBKEY="ssh-ed25519 …"
CLIENT_WINTERMUTE_REPO_PATH="/mnt/backup/borg-wintermute"

# The management-path key (one for the whole tailnet — neuromancer).
MANAGER_SSH_PUBKEY="ssh-ed25519 …"
```

A generated `/etc/backup-pi.clients.env` (mode 644, no secrets) is the runtime source of truth that the Pi-side wrappers source on every invocation.

### Two SSH paths

1. **Backup path (per client).** Each client's SSH key has a forced command:
   ```
   command="/usr/local/bin/borg-serve-only.sh <name>",restrict <pubkey>
   ```
   `borg-serve-only.sh` validates `<name>` against `$CLIENTS` and execs `borg serve --restrict-to-path <CLIENT_<NAME>_REPO_PATH> --append-only`. The client can write new archives; it cannot delete or rewrite anything. A leaked client key can only reach its own repo.

2. **Management path (one key shared by manager).** The manager's SSH key has a different forced command:
   ```
   command="/usr/local/bin/borg-manage.sh",restrict <MANAGER_SSH_PUBKEY>
   ```
   `borg-manage.sh` parses `<verb> <client> [args...]` from `$SSH_ORIGINAL_COMMAND`, validates both against the allowlist, reads `BORG_PASSPHRASE` from the SSH env (forwarded via the manager's `SendEnv BORG_PASSPHRASE`), and runs `borg <verb>` with hardcoded args. Allowed verbs: `prune` (hardcoded `--keep-daily 14 --keep-weekly 4`, no `--prefix`), `compact`, `check`, `list`, `list-last`, `info`, `extract <archive> <path>` (path validated, no `..` allowed), `break-lock` (release a stale repo lock; removes only the lock file, never archive data). Anything else is rejected and logged via `logger -t borg-manage`.

### Why two paths

A compromised client can only push corrupt new archives (append-only protects the rest). It cannot trigger prune, list other clients' repos, or invoke arbitrary borg commands. The management path with hardcoded retention bounds the damage even when the manager itself is compromised — `--keep-daily 14 --keep-weekly 4` is non-destructive within retention, and there is no `delete` verb.

### Repository initialization

The provisioning script loops over `$CLIENTS` and only inits a repo when `<repo>/data` is missing. **The conf has no passphrases**, so on a fresh init the operator is prompted at the TTY for the passphrase (must be confirmed by re-entry, must be non-empty). Use the value already stored in Infisical on neuromancer.

After init, the borg key is exported to `/home/$ADMIN_USER/borg-key-backup-<name>.txt`. Copy each file off the Pi and delete it. Without it, the repo is unrecoverable if Infisical is ever lost AND the wrapped repokey inside the repo is damaged — having a separate offsite copy of the key is a belt+suspenders defense.

### Hand-edited authorized_keys are dropped on re-run

The provisioning script rebuilds `/home/borg/.ssh/authorized_keys` from `$CLIENTS` + `MANAGER_SSH_PUBKEY` each run. Any key added by hand will be removed (with a backup written to `/home/borg/.ssh/authorized_keys.bak.<timestamp>` and a warning line listing what got dropped). To make a new client permanent, add it to the `CLIENTS` list and define its `CLIENT_<NAME>_PUBKEY` / `CLIENT_<NAME>_REPO_PATH` in `/etc/backup-pi.conf`.

## Management (neuromancer)

All borg management runs on neuromancer via `scripts/borg-pi-manage.sh`, **as the chrisl8 user** (not root). The script:

- Reads `scripts/borg-pi-manage.conf` for the per-client management config (repo path, freshness hours, HC.io URLs, Infisical key name, restore-test path + expected content).
- Fetches each client's borg passphrase from Infisical at use-time (`infisical secrets get`, mirroring the `load_secret` pattern in `borg-backup.sh`). 5-minute in-memory cache.
- SSHes to `borg@backup-pi` with `~/.ssh/borg-pi-mgmt` and `SendEnv BORG_PASSPHRASE`.

Subcommands:

| Subcommand     | What it does                                                     | Suggested cron   |
| -------------- | ---------------------------------------------------------------- | ---------------- |
| `prune`        | `prune` + `compact` for every client                              | Daily            |
| `check`        | `borg check` for every client (slow; bandwidth-heavy)             | Weekly           |
| `freshness`    | `list-last` per client; ping per-client HC.io URL accordingly     | Daily            |
| `restore-test` | Extract a known file from each latest archive; verify content     | Weekly           |
| `break-lock`   | Release a stale repo lock from a killed borg process              | Manual recovery  |
| `all`          | `prune` + `freshness` (typical daily cron)                        | Daily            |

Recommended chrisl8 user crontab on neuromancer:

```
0 4 * * *  ~/containers/scripts/borg-pi-manage.sh all
0 5 * * 0  ~/containers/scripts/borg-pi-manage.sh check
0 6 * * 0  ~/containers/scripts/borg-pi-manage.sh restore-test
```

### Healthchecks.io structure

Two URLs per client, configured in `borg-pi-manage.conf`:

- **Freshness URL** — pinged daily by `freshness`. `/success` on fresh, `/fail` with reason on stale.
- **Restore-test URL** — pinged weekly by `restore-test`. `/success` if the known file extracts and matches the expected content; `/fail` if anything goes wrong (passphrase, SSH, extract failure, content mismatch).

Set the HC.io period on each check to slightly longer than its expected cadence (e.g. 50h for a daily freshness check with 48h threshold) so a one-time late ping doesn't fire a false positive.

### Restore-test is the long-game ransomware detector

If an attacker pushes corrupt-but-borg-create-valid archives via the legit backup path daily, after 14 days the original good archives age out of retention and only corrupt archives remain. The freshness check stays green (pushes "succeed"). The restore-test catches this: extract a known file (`etc/hostname` is good — small, stable, present in every backup) and confirm the content. If it doesn't match, an attacker is in the loop. Without this check, the 14-day attack is undetectable by anything else in the design.

(Healthchecks.io URLs and cron schedules are documented above in the *Management* section. Configuration lives in `scripts/borg-pi-manage.conf` on neuromancer, not on the Pi.)

## Provisioning Script

### Design

`scripts/setup-backup-pi.sh` runs after flashing the SD card and booting the Pi for the first time. It is idempotent (safe to run multiple times) and is the source of truth — read the script for the authoritative step list.

Headline steps:

1. **Preflight** — validates CLIENTS/CLIENT_*/MANAGER_SSH_PUBKEY/TAILSCALE_AUTH_KEY. Warns about Tailscale auth key requirements (reusable, non-ephemeral, tagged) if Tailscale isn't already connected. Warns about the upcoming piadmin password requirement.
2. **System update + packages** — `apt install borgbackup openssh-server ufw smartmontools fail2ban unattended-upgrades`. No kopia (retired).
3. **USB drive setup** — format/label/mount idempotently.
4. **Service users** — `borg` only (kopiauser is removed/userdel'd by the tear-down block).
5. **Permissions + `/etc/backup-pi.clients.env`** — generates the non-secret clients env file consumed by the wrappers.
6. **`/home/borg/.ssh/authorized_keys`** — rebuilt per-run from `$CLIENTS` (one backup-path line each) + `MANAGER_SSH_PUBKEY` (one mgmt line). Hand-added keys are dropped with a warning.
7. **Tailscale** — `tailscale up --advertise-tags=tag:backup-target`. Disables Tailscale SSH.
8. **SSH hardening + fail2ban** — sshd_config drop-in (no password, no root login, `AllowUsers`, `AcceptEnv BORG_PASSPHRASE BORG_PASSPHRASE_*`). Removes `/etc/sudoers.d/010_pi-nopasswd` and `/etc/sudoers.d/90-cloud-init-users` so piadmin needs a password for sudo.
9. **Tailscale ACL probe** — `tailscale ping` outbound; warn if it succeeds (ACLs not yet restrictive).
10. **Firewall** — UFW default-deny, allow `tailscale0` inbound, allow eth0 DHCP only.
11. **Borg repos** — `borg init` per missing client repo. **Prompts the operator at the TTY for the passphrase** (it's not in the conf). Exports the key to `/home/piadmin/borg-key-backup-<name>.txt`.
12. **Wrappers** — `/usr/local/bin/borg-serve-only.sh` (backup path) and `/usr/local/bin/borg-manage.sh` (mgmt path).
13. **Kopia tear-down** — stops, masks, removes systemd unit, deletes repo + user + package + apt source.
14. **Pi-side cron** — SMART monitoring only. No borg cron on the Pi.
15. **Web admin RPC (optional)** — pi-rpc.sh / pi-status.sh / pi-action.sh / sudoers — minimal allowlist (status, apt-upgrade, reboot). Sudoers has `env_keep += BORG_PASSPHRASE_*` so the web admin's status poll can pass through.

The script ends with a "Next steps" block that includes the exact Tailscale ACL JSON to paste into the admin console.

## Initial backup seeding (at home, before shipping)

Each client runs its first full `borg create` over LAN. With the new `borg-pi-mgmt` key in place and the conf installed, you can also run management commands from neuromancer before shipping:

```bash
# Neuromancer — drive the first management cycle once both clients have at
# least one archive pushed. Verifies the manager path end-to-end.
~/containers/scripts/borg-pi-manage.sh freshness
~/containers/scripts/borg-pi-manage.sh restore-test
~/containers/scripts/borg-pi-manage.sh check     # I/O heavy; weekend OK
```

## Deployment at remote location

### Instructions for the host

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

### Post-deployment verification

```bash
# Pi reachable + Tailscale up
tailscale ping backup-pi
ssh piadmin@backup-pi "uptime && mountpoint /mnt/backup && df -h /mnt/backup"

# Drive a backup from each client; freshness check should ping success.
~/containers/scripts/borg-pi-manage.sh freshness

# ACL verification — Pi should NOT be able to reach you back.
ssh piadmin@backup-pi "tailscale ping -c 1 -timeout 3s neuromancer"   # expect fail
```

## Maintenance

### Borg pruning (run from neuromancer, NOT the Pi)

Prune happens via `scripts/borg-pi-manage.sh prune` on neuromancer, **not** via a Pi-side cron. The Pi holds no passphrases; the manager fetches them from Infisical at use-time and forwards over SSH `SendEnv`. The wrapper on the Pi (`borg-manage.sh`) runs with **hardcoded retention** — `--keep-daily 14 --keep-weekly 4`, no `--prefix` flag, no `--keep-daily 0` override possible.

That retention is deliberately short. The Pi is the **disaster-recovery target** — "house burned down, the Pi is my only copy" or "ransomware ate every machine, the Pi is sealed off." The long historical tail (months / years of recovery points) lives in each client's *local* borg repo, not on the Pi.

Cron line (chrisl8's user crontab on neuromancer):

```
0 4 * * *  ~/containers/scripts/borg-pi-manage.sh all          # prune + freshness
0 5 * * 0  ~/containers/scripts/borg-pi-manage.sh check        # weekly integrity
0 6 * * 0  ~/containers/scripts/borg-pi-manage.sh restore-test # weekly recovery probe
```

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

- **Detects existing state and skips** — packages, service users, drive label/mount, borg repo init, Tailscale connection. These are one-time setup steps; the script checks for them before acting.
- **Unconditionally rewrites generated files** — `/etc/backup-pi.clients.env`, `/etc/cron.d/backup-pi`, `/usr/local/bin/borg-serve-only.sh`, `/usr/local/bin/borg-manage.sh`, `/usr/local/bin/pi-rpc.sh`, `/usr/local/sbin/pi-status.sh`, `/usr/local/sbin/pi-action.sh`, `/etc/sudoers.d/webadmin`, `/etc/fail2ban/jail.d/sshd.local`, `/etc/ssh/sshd_config.d/99-backup-pi.conf`. This is how new features actually land, so **don't hand-edit these files** — your changes will be lost on the next re-run.
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

1. SSH into the Pi.
2. Plug in a new drive.
3. Re-run `sudo bash setup-backup-pi.sh`. The script reformats / mounts / chowns the new drive, prompts you (interactively) for each client's borg passphrase, re-inits the empty repos, and re-exports the borg keys.
4. Initial backups will need to re-seed from each client — there's no shortcut; the data must transfer again over Tailscale.

## Web admin integration

The provisioning script can set up an SSH-based RPC channel that lets the platform's web admin (`~/containers/web-admin`) monitor Pi state and trigger maintenance actions from a browser. **This is fully optional** — leave `WEBADMIN_SSH_PUBKEY` as `CONFIGURE_ME` in `/etc/backup-pi.conf` to skip it.

The web admin has **two SSH paths** to the Pi (mirroring the manager + backup model used by `borg-pi-manage.sh`):

1. **webadmin path** (`pi-rpc.sh` → `pi-action.sh`): minimal allowlist — `status`, `apt-upgrade`, `reboot`. No borg verbs, no passphrases.
2. **manager path** (`borg-manage.sh`): borg-related buttons (`borg-check`, `borg-prune`, per-client variants). The web admin fetches the relevant passphrase from Infisical and forwards it via SSH `SendEnv BORG_PASSPHRASE` for each operation. Same key/wrapper used by `borg-pi-manage.sh`.

### webadmin path — RPC dispatcher

```
web-admin backend
    │  ssh -i <webadmin-key> webadmin@<pi> <command>
    ▼
Pi: /usr/local/bin/pi-rpc.sh   ← forced by ~webadmin/.ssh/authorized_keys
    ├─→ status            → sudo /usr/local/sbin/pi-status.sh
    ├─→ action apt-upgrade → sudo /usr/local/sbin/pi-action.sh apt-upgrade
    ├─→ action reboot      → sudo /usr/local/sbin/pi-action.sh reboot
    └─→ anything else     → logged to `pi-rpc`, exit 1
```

`/etc/sudoers.d/webadmin` grants NOPASSWD only on those exact `(script + arg)` tuples and includes `Defaults:webadmin env_keep += "BORG_PASSPHRASE_*"` so `pi-status.sh` can read per-client passphrases forwarded by the web admin during status polls. No other sudo, no interactive shell, no forwarding, no pty.

### Setup

1. **On the web-admin host**, generate one-time webadmin keypair:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/backup-pi-webadmin -N ""
   ```
2. **In `/etc/backup-pi.conf`** on the Pi, paste the public key into `WEBADMIN_SSH_PUBKEY`.
3. **On the Pi**, re-run `sudo bash setup-backup-pi.sh`. STEP 19b provisions `webadmin`, the dispatcher, the helper scripts, and the sudoers fragment.
4. **In `~/containers/user-config.yaml`** on the web-admin host, add:
   ```yaml
   backuppi:
     enabled: true
     host: backup-pi
     ssh_user: webadmin
     ssh_key_path: ~/.ssh/backup-pi-webadmin
     mgmt_ssh_user: borg
     mgmt_ssh_key_path: ~/.ssh/borg-pi-mgmt
     clients:
       - name: neuromancer
         infisical_path: /borgbackup
         infisical_key: BORG_REMOTE_PASSPHRASE
         freshness_hours: 48
       - name: wintermute
         infisical_path: /borgbackup
         infisical_key: BORG_REMOTE_PASSPHRASE_WINTERMUTE
         freshness_hours: 48
   ```
5. Restart web-admin. A "Backup Pi" tab appears in the dashboard.

### Manual probing

```bash
ssh -i ~/.ssh/backup-pi-webadmin webadmin@backup-pi status                      # JSON
ssh -i ~/.ssh/backup-pi-webadmin webadmin@backup-pi action apt-upgrade          # OK
ssh -i ~/.ssh/backup-pi-webadmin webadmin@backup-pi action reboot               # OK
ssh -i ~/.ssh/backup-pi-webadmin webadmin@backup-pi 'rm -rf /'                  # rejected

# Manager path:
BORG_PASSPHRASE=… ssh -o SendEnv=BORG_PASSPHRASE -i ~/.ssh/borg-pi-mgmt \
    borg@backup-pi list-last neuromancer                                        # most recent archive
ssh -i ~/.ssh/borg-pi-mgmt borg@backup-pi 'delete neuromancer'                  # rejected (verb)
ssh -i ~/.ssh/borg-pi-mgmt borg@backup-pi 'prune nonexistent'                   # rejected (client)
ssh -i ~/.ssh/borg-pi-mgmt borg@backup-pi 'extract neuromancer x ../etc/passwd' # rejected (traversal)
```

`/var/log/auth.log` (sudo) and `journalctl -t pi-rpc -t borg-manage -t borg-serve-only` on the Pi record every RPC attempt — the rejected ones too.

## File structure on the Pi

```
/home/piadmin/
└── borg-key-backup-<name>.txt      # One per client, DELETE AFTER SAVING ELSEWHERE

/etc/
├── backup-pi.conf                  # Passphrase-free schema + Tailscale + manager key (600)
├── backup-pi.clients.env           # Non-secret derived: $CLIENTS + per-client REPO_PATH (644)
├── ssh/sshd_config.d/99-backup-pi.conf  # Hardening drop-in (PasswordAuth=no, PermitRootLogin=no, AllowUsers, AcceptEnv BORG_PASSPHRASE*)
└── fail2ban/jail.d/sshd.local      # 5 retries / 10m → 1h ban

/usr/local/bin/
├── borg-serve-only.sh              # Backup path (append-only, per-client repo restriction)
└── borg-manage.sh                  # Mgmt path (allowlist verbs, env passphrase)

/home/webadmin/                     # Only present if WEBADMIN_SSH_PUBKEY is set
└── .ssh/authorized_keys            # Forced command="/usr/local/bin/pi-rpc.sh"

/usr/local/bin/
└── pi-rpc.sh                   # SSH dispatcher (whitelists SSH_ORIGINAL_COMMAND)

/usr/local/sbin/
├── pi-status.sh                # Emits JSON status (run as root via sudo)
└── pi-action.sh                # Runs whitelisted maintenance actions

/etc/sudoers.d/webadmin         # NOPASSWD only for the (script + arg) tuples above

/mnt/backup/
├── borg/                       # neuromancer's borg repository
└── borg-wintermute/            # wintermute's borg repository
                                # New clients go in /mnt/backup/borg-<name>
```

## Security model

| Threat                          | Defense                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical theft of the Pi        | No borg passphrases at rest. Repos are repokey-blake2 encrypted, keys wrapped by passphrases held only in Infisical on neuromancer. Tailscale node identity must be revoked from the admin console; tag:backup-target ACL limits lateral reach pre-revoke. |
| Long-game theft (Pi discarded years later) | Same. Sealed unit yields encrypted trash forever.                                                                                                                                                                          |
| Network attacker on the LAN     | UFW default-deny on eth0; sshd inaccessible from LAN.                                                                                                                                                                                  |
| Compromised foreign Tailscale node | sshd `PasswordAuthentication=no`; fail2ban jails brute-force; Tailscale ACL limits which tags can reach `tag:backup-target:22`.                                                                                                     |
| Ransomware on neuromancer (manager) | `borg-manage.sh` allowlist with hardcoded retention (`--keep-daily 14 --keep-weekly 4`, no `--prefix`, no `delete` verb). `piadmin` requires a sudo password — wipe attempts via piadmin SSH need an interactive password not on neuromancer. |
| Ransomware on a client (e.g. wintermute) | Backup-path `borg serve --append-only` protects existing archives. Client has no manager key, can't trigger prune. Per-client `--restrict-to-path` keeps the blast radius to its own repo.                                       |
| 14-day-corrupt-archives attack  | Weekly `borg-pi-manage.sh restore-test` extracts a known file (`etc/hostname`) from the latest archive and verifies content. Mismatch = `/fail` ping to HC.io.                                                                         |
| Console access                  | Local TTY login available for emergency diagnostics. `piadmin`'s strong password is now the gate (NOPASSWD sudo is removed by setup).                                                                                                  |
| OS updates                      | Unattended upgrades for security patches.                                                                                                                                                                                              |

## Future: multiple Pi nodes

The schema scales: a second Pi gets its own `MANAGER_SSH_PUBKEY` (could share neuromancer's), its own `CLIENTS` list, and its own entry in `borg-pi-manage.conf` (add a `PI_HOST_2`, etc., or run multiple instances of the script). Each Pi is fully independent — no replication.

## Relationship to client-side tooling

```
neuromancer (manager + borg client)
    ├── scripts/borg-backup.sh                  # creates local + remote archives (append-only path)
    └── scripts/borg-pi-manage.sh               # weekly + daily: prune, check, freshness, restore-test
                                                # uses ~/.ssh/borg-pi-mgmt + Infisical passphrases

wintermute (borg client only — borgmatic)
    └── borgmatic                               # backs up to ssh://borg@backup-pi/mnt/backup/borg-wintermute
                                                # (append-only path only — no mgmt key on wintermute)
```
