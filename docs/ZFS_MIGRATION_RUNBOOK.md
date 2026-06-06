# ZFS Migration Runbook — neuromancer

Migration of neuromancer's primary container storage from a single 2TB mdadm+LVM+ext4 mirror to two ZFS mirror pools (4TB + 2TB). Adds bulk-growth headroom and on-disk integrity checking for irreplaceable data (immich, nextcloud, paperless, etc.).

## Scope and goals

- **Add headroom.** `/mnt/2000` was at 70% (1.3T used / 1.9T) and growing — primarily immich (696G) and nextcloud (278G). The 4TB pool absorbs the giants with room for years of growth.
- **Add integrity checking.** ZFS scrubs detect bit-rot that mdadm cannot see. Especially valuable for photos/scans that sit untouched for years.
- **Keep two pools as separate failure domains.** 4TB for bulk-growth data, 2TB for smaller mirror-worthy stuff (databases, secrets, code, notes). Each pool independently scrubable, replaceable, expandable.
- **No on-host replication.** Mirror + borg-to-backup-pi covers the realistic failure modes. ZFS `syncoid` replication is a third belt that doesn't justify the operational cost for this setup.
- **No change to `/mnt/22TB` (bulk HDD) or root.** Out of scope. The 22TB HDD at 82% is a separate problem requiring a bigger disk, not addressable by this migration.

## Hardware

### Decisions made

| Item | Choice | Why not the alternative |
|---|---|---|
| PCIe SATA card | **SYBA SI-PEX40139** (JMB585 chipset, 5 native ports, PCIe 3.0 x2) | Cheap unbranded 4-port cards silently swap chipsets between batches (ASM1064 / ASM1061+port-multiplier / Marvell 88SE9215). Port multipliers can lie about cache flushes — dangerous under ZFS. JMB585 is the well-regarded "just works on Linux, doesn't lie" chip. Extra ~$18 over an unknown-chipset card is trivial insurance against CKSUM errors with no real cause. |
| SSDs | **2x 4TB SATA SSD** (repurposed from wintermute) | Already owned. Wipe before use. |
| Layout | **Two separate ZFS mirror pools** (4TB and 2TB) | RAID10 across all 4 disks would give ~6TB single pool with better perf but: (a) loses the independent-failure-domain property, (b) requires both old and new disks to be wiped and rebuilt simultaneously, (c) one pool corruption = all data gone. Two pools = staged migration, independent scrub cycles, can replace disk sets at different times. |
| Filesystem | **ZFS** (not mdadm+ext4) | Bit-rot detection via scrub is the killer feature for irreplaceable data. Native snapshots replace ad-hoc backup scripts. Per-dataset properties (compression, recordsize, atime) tune per workload. Cost is operational overhead — accepted because the data being protected justifies it. |
| Replication target | **None** (2TB is primary storage, not a replica) | Mirror + borg covers disk failure and catastrophic loss. `syncoid` only adds value for "logical corruption caught quickly" — narrow window, not worth the ongoing maintenance for a home server. |

### Current SATA topology (neuromancer, pre-migration)

This board has **two** SATA controllers, and the Intel chipset ports are **not all the same speed**. The Intel 6-Series/C200 PCH provides only **2× SATA 6 Gb/s** ports (ata1/ata2) and **4× SATA 3 Gb/s** ports (ata3–ata6) — a hardware limit of this PCH generation, not a BIOS setting. Captured from `lsblk` + `/sys/class/ata_port` link speeds:

| Dev | Drive | ATA port | Controller | Port max | Negotiated | Current use |
|---|---|---|---|---|---|---|
| sda | PNY 2TB SSD | ata1 | Intel C200 (chipset) | 6 Gb/s | 6.0 Gb/s | md1 → `/mnt/2000` (→ future tank-2tb) |
| sdb | PNY 2TB SSD | ata2 | Intel C200 (chipset) | 6 Gb/s | 6.0 Gb/s | md1 → `/mnt/2000` (→ future tank-2tb) |
| sdc | Samsung 850 233G | ata3 | Intel C200 (chipset) | 3 Gb/s | 3.0 Gb/s | md0 → `/` + `/boot` |
| sdd | Samsung 850 233G | ata4 | Intel C200 (chipset) | 3 Gb/s | 3.0 Gb/s | md0 → `/` + `/boot` |
| sde | Samsung 850 112G | ata5 | Intel C200 (chipset) | 3 Gb/s | 3.0 Gb/s | `/mnt/120` (Monitor) |
| sdf | Samsung 840 238G | ata6 | Intel C200 (chipset) | 3 Gb/s | 3.0 Gb/s | `/mnt/250` (Cache) |
| sdg | ST22000NM 22TB HDD | ata7 | Marvell 88SE9172 (add-in) | 6 Gb/s | 6.0 Gb/s | `/mnt/22TB` |
| — | (empty) | ata8 | Marvell 88SE9172 (add-in) | 6 Gb/s | — | free |

**Why this layout is already correct (don't rearrange existing drives):**
- The two PNY 2TB SSDs (future `tank-2tb` mirror) occupy the only two 6 Gb/s chipset ports — keep them there.
- The 3 Gb/s-throttled drives are exactly the ones that don't care (boot/root mirror, cache, monitor); un-throttling them isn't worth a scarce 6 Gb/s port.
- The 22TB HDD sits on the least-trusted controller (Marvell 88SE9172) — correct, because an HDD can't use 6 Gb/s anyway and this **keeps the flaky controller off every ZFS pool**, which is the same cache-flush-honesty concern that drove the JMB585 purchase.

**Where the new 4TB SSDs go:** both on the JMB585 card. All native 6 Gb/s ports are already taken, and `tank-4tb` is the busiest pool (immich/nextcloud), so it must not land on a 3 Gb/s port. This keeps both ZFS pools on trustworthy controllers (tank-2tb on Intel native, tank-4tb on JMB585). **Do not split the tank-4tb mirror across the JMB585 and the Marvell's free port** — putting a mirror leg on the 88SE9172 reintroduces the exact risk the card was bought to avoid.

**Verify after install:**
- `sudo lspci -vv -s <card> | grep LnkSta` → confirm `Width x2` (an x1 slot makes the two 4TB drives share ~985 MB/s; put the card in an x4-or-wider physical slot).
- Re-check the 4TB drives negotiated **6.0 Gb/s** (a bad cable silently falls back to 3.0).

### Hardware purchase list

- [ ] SYBA SI-PEX40139 PCIe SATA card — Amazon B07ST9CPND or equivalent JMB585 card (~$35)
- [ ] 4x SATA cables if not included with card (card typically ships with some)
- [ ] Verify chassis has 2 free 2.5" mounting locations or use adhesive/bracket mounts

## Pre-migration preparation

### 1. Verify backup health

Critical — borg is the only safety net during the migration window.

```bash
# Check most recent borg run for neuromancer
ssh webadmin@backup-pi 'ls -lath /borg-repos/neuromancer/data/ | head -5'

# Verify backup-coverage audit is green for everything being migrated
# (use the web admin Backup Coverage page, or run the audit script directly)
~/containers/scripts/backup-coverage-audit.sh --host neuromancer
```

Do not proceed if any "must-migrate" container shows uncovered paths.

### 2. Document current state (snapshot for rollback reference)

```bash
mkdir -p ~/migration-snapshot
df -h > ~/migration-snapshot/df-before.txt
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID > ~/migration-snapshot/lsblk-before.txt
cat /proc/mdstat > ~/migration-snapshot/mdstat-before.txt
sudo vgdisplay > ~/migration-snapshot/vgdisplay-before.txt
sudo pvdisplay > ~/migration-snapshot/pvdisplay-before.txt
cp ~/containers/user-config.yaml ~/migration-snapshot/user-config-before.yaml
du -sh /mnt/2000/container-mounts/* > ~/migration-snapshot/sizes-before.txt
```

### 3. Install ZFS

```bash
sudo apt update
sudo apt install zfsutils-linux
zfs version  # confirm install
```

Ubuntu 24.04 ships ZFS in-tree; no DKMS needed.

### 4. Wipe wintermute SSDs (do this on wintermute before pulling them)

Per disk:
```bash
sudo wipefs -a /dev/sdX
sudo sgdisk --zap-all /dev/sdX
```

## Phase 1 — Hardware installation

1. `~/containers/scripts/all-containers.sh --stop`
2. `sudo systemctl poweroff`
3. Install SYBA card in available PCIe slot (x4 or wider — x1 will work but bottleneck).
4. Connect both 4TB SSDs to ports on the new card.
5. Boot.
6. Verify detection:
   ```bash
   lspci | grep -i sata    # should show JMicron JMB58x
   lsblk                   # should show two new ~3.7T disks
   dmesg | grep -i ahci    # check no errors
   ```
7. Note the device names assigned (likely `/dev/sdh` and `/dev/sdi` or similar). Use `/dev/disk/by-id/` paths for the pool — they survive device renames.
   ```bash
   ls -la /dev/disk/by-id/ | grep -i ata- | grep -v part
   ```

## Phase 2 — Create the 4TB pool

### Pool creation

```bash
# Replace IDs with the actual /dev/disk/by-id/ paths for the two 4TB SSDs
sudo zpool create \
  -o ashift=12 \
  -o autotrim=on \
  -O compression=lz4 \
  -O atime=off \
  -O xattr=sa \
  -O acltype=posixacl \
  -O mountpoint=/mnt/ssd-4tb \
  tank-4tb mirror \
  /dev/disk/by-id/ata-SSD_MODEL_SERIAL_A \
  /dev/disk/by-id/ata-SSD_MODEL_SERIAL_B

zpool status tank-4tb
zpool list tank-4tb
```

**Property rationale:**
- `ashift=12` — 4K sectors, required for modern SSDs; cannot be changed after pool creation
- `autotrim=on` — background TRIM keeps SSD perf consistent
- `compression=lz4` — near-zero CPU cost, modest space win, sometimes *faster* than uncompressed due to reduced IO
- `atime=off` — cuts unnecessary write amplification on SSDs
- `xattr=sa` — stores xattrs in inodes instead of hidden dirs (faster, less fragmentation)
- `acltype=posixacl` — needed if any container ever uses POSIX ACLs

### Create datasets (one per app)

```bash
# Top-level organizational dataset
sudo zfs create tank-4tb/containers

# Per-app datasets — bulk-growth tier going to 4TB pool
for app in immich nextcloud jellyfin paperless-ngx dawarich; do
  sudo zfs create tank-4tb/containers/$app
done

# Permissions (mirror current /mnt/2000/container-mounts ownership)
sudo chown -R chrisl8:chrisl8 /mnt/ssd-4tb/containers
sudo chmod 770 /mnt/ssd-4tb/containers/*
```

### Per-dataset overrides

None required for the bulk-growth tier — defaults are correct for photo/file/metadata workloads. (If jellyfin's media library DB grows large, revisit `recordsize=16K` on its dataset.)

## Phase 3 — Migrate giants to 4TB pool

For each app in order: **immich → nextcloud → paperless-ngx → dawarich → jellyfin**.

Do them one at a time. Each app's downtime is its own copy duration (immich will be the longest — ~hours for 696G over SATA).

### Per-app procedure

```bash
# 1. Stop the container
~/containers/scripts/all-containers.sh --stop --container <app>

# 2. Copy data preserving everything
sudo rsync -aHAX --info=progress2 --delete \
  /mnt/2000/container-mounts/<app>/ \
  /mnt/ssd-4tb/containers/<app>/

# 3. Verify with a second rsync (should report nothing to do)
sudo rsync -aHAXn --info=progress2 \
  /mnt/2000/container-mounts/<app>/ \
  /mnt/ssd-4tb/containers/<app>/

# 4. Rename the old data (don't delete yet — keep as fallback)
sudo mv /mnt/2000/container-mounts/<app> /mnt/2000/container-mounts/<app>.pre-zfs

# 5. Bind-mount the new location at the old path so compose doesn't need editing yet
sudo mkdir /mnt/2000/container-mounts/<app>
sudo mount --bind /mnt/ssd-4tb/containers/<app> /mnt/2000/container-mounts/<app>

# 6. Start the container, verify it works
~/containers/scripts/all-containers.sh --start --container <app>
# Check the app's UI, check logs, check writes go through
```

**Why bind-mounts here:** lets you migrate apps one at a time without touching the mount-priority logic in `user-config.yaml`. The compose file's path stays `/mnt/2000/container-mounts/<app>` and the kernel transparently redirects to `/mnt/ssd-4tb/...`. The "real" reconfiguration happens after Phase 5 when paths are updated in `user-config.yaml` and bind-mounts are removed.

### Database considerations

For containers with databases (immich, nextcloud, paperless, dawarich):
- **`rsync` is fine if the container is fully stopped** (which it is). The DB files are at rest.
- If a DB sees corruption after the move, restore from the `.pre-zfs` directory and investigate before retrying.

### Verification gate at end of Phase 3

Before proceeding:
- [ ] All migrated apps running, UIs responsive
- [ ] At least 24h elapsed since each app started writing to new location (catches latent issues)
- [ ] `zpool status tank-4tb` shows no errors
- [ ] `zpool scrub tank-4tb && zpool wait tank-4tb && zpool status tank-4tb` — clean

## Phase 4 — Snapshot before destructive step

```bash
# Snapshot every dataset on the 4TB pool
sudo zfs snapshot -r tank-4tb@pre-2tb-wipe

# Confirm
zfs list -t snapshot
```

Run a fresh borg backup:
```bash
~/containers/scripts/borg-backup.sh
```

Wait for borg to complete and verify it shows up on backup-pi before proceeding.

## Phase 5 — Tear down 2TB mdadm+LVM, rebuild as ZFS

### Stop remaining containers using /mnt/2000

```bash
# Stop everything still using /mnt/2000
~/containers/scripts/all-containers.sh --stop

# Identify still-resident apps (everything except the .pre-zfs leftovers)
ls /mnt/2000/container-mounts/ | grep -v pre-zfs
```

### Move tier-2 apps to a holding area on the 4TB pool

These will land on the 2TB pool eventually, but use 4TB as a holding tank during the rebuild:

```bash
sudo zfs create tank-4tb/holding
for app in mariadb infisical forgejo obsidian obsidian-babel-livesync caddy code; do
  sudo rsync -aHAX --info=progress2 \
    /mnt/2000/container-mounts/$app/ \
    /mnt/ssd-4tb/holding/$app/
done
```

(Add/remove apps from the list based on what you've decided is tier-2 worth-mirroring vs tier-3 acceptable-on-old-storage.)

### Verification gate (do all three before wiping)

- [ ] All tier-2 data copied to `/mnt/ssd-4tb/holding/` — verify sizes match
- [ ] `tank-4tb@pre-2tb-wipe` snapshot exists (`zfs list -t snapshot`)
- [ ] Borg backup completed within last few hours

### Destroy mdadm + LVM, wipe disks

```bash
sudo umount /mnt/2000
sudo lvremove vg1/lv1
sudo vgremove vg1
sudo pvremove /dev/md1
sudo mdadm --stop /dev/md1
sudo mdadm --zero-superblock /dev/sda /dev/sdb
sudo wipefs -a /dev/sda
sudo wipefs -a /dev/sdb

# Confirm
lsblk
```

Remove the `/mnt/2000` line from `/etc/fstab` (the new pool will mount via ZFS, not fstab).

### Create the 2TB ZFS pool

```bash
sudo zpool create \
  -o ashift=12 \
  -o autotrim=on \
  -O compression=lz4 \
  -O atime=off \
  -O xattr=sa \
  -O acltype=posixacl \
  -O mountpoint=/mnt/ssd-2tb \
  tank-2tb mirror \
  /dev/disk/by-id/ata-OLD_SSD_A \
  /dev/disk/by-id/ata-OLD_SSD_B

# Datasets for tier-2 apps
sudo zfs create tank-2tb/containers
for app in mariadb infisical forgejo obsidian obsidian-babel-livesync caddy code; do
  sudo zfs create tank-2tb/containers/$app
done

# Per-dataset overrides
sudo zfs set recordsize=16K tank-2tb/containers/mariadb  # InnoDB page size
```

### Move tier-2 data from holding → 2TB pool

```bash
for app in mariadb infisical forgejo obsidian obsidian-babel-livesync caddy code; do
  sudo rsync -aHAX --info=progress2 \
    /mnt/ssd-4tb/holding/$app/ \
    /mnt/ssd-2tb/containers/$app/
done

# Verify, then clean up holding area
sudo zfs destroy tank-4tb/holding
```

## Phase 6 — Cleanup and reconfiguration

### Update user-config.yaml mount priorities

Edit `~/containers/user-config.yaml`:

```yaml
mounts:
  - path: /mnt/ssd-4tb         # was /mnt/2000 — bulk-growth tier (mount[0])
    label: Primary SSD (4TB ZFS mirror)
  - path: /mnt/22TB             # unchanged (mount[1])
    label: Large HDD
  - path: /mnt/ssd-2tb         # was implicit — tier-2 (mount[2])
    label: Secondary SSD (2TB ZFS mirror)
  - path: /mnt/250              # unchanged (mount[3])
    label: Cache SSD
  - path: /mnt/120              # unchanged (mount[4])
    label: Monitor
```

For each tier-2 app, set `volume_mounts: data: 2` so they land on the new 2TB pool:

```yaml
mariadb:
  enabled: true
  volume_mounts:
    data: 2
# repeat for infisical, forgejo, obsidian, obsidian-babel-livesync, caddy, code
```

### Remove the bind-mounts and `.pre-zfs` fallback dirs

```bash
# Stop containers using bind-mounted paths
~/containers/scripts/all-containers.sh --stop

# Unmount the binds
for app in immich nextcloud jellyfin paperless-ngx dawarich; do
  sudo umount /mnt/2000/container-mounts/$app
done

# /mnt/2000 no longer exists — clean up the empty bind mount points if they remain
# (they were on the old ext4 which is gone — N/A after Phase 5)

# Regenerate .env files so compose paths reflect new mount[0]
~/containers/scripts/generate-env.js  # or whatever the regenerate command is

# Start everything back up via the platform script
~/containers/scripts/all-containers.sh --start
```

### Delete the `.pre-zfs` fallback data (only after a few days of clean running)

Wait at least 3-7 days with everything working before deleting. Once confident:
```bash
# On the 4TB pool — these would only exist if you kept them as a safety net
# (after Phase 5 the old /mnt/2000 is gone, so this is mostly N/A)
```

## Phase 7 — Operational setup

### Auto-snapshots with sanoid

```bash
sudo apt install sanoid
sudo cp /usr/share/doc/sanoid/examples/sanoid.conf /etc/sanoid/sanoid.conf
```

Edit `/etc/sanoid/sanoid.conf` — recommended starting point:

```ini
[tank-4tb/containers]
  use_template = production
  recursive = yes

[tank-2tb/containers]
  use_template = production
  recursive = yes

[template_production]
  hourly = 36
  daily = 30
  monthly = 6
  yearly = 0
  autosnap = yes
  autoprune = yes
```

Sanoid timer is enabled by default on Ubuntu — confirm with `systemctl list-timers | grep sanoid`.

### Scheduled scrubs

```bash
# Run monthly via cron (the first of each month at 3am)
echo '0 3 1 * * root /usr/sbin/zpool scrub tank-4tb && /usr/sbin/zpool scrub tank-2tb' | sudo tee /etc/cron.d/zfs-scrub
```

### Monitoring

Add to whatever your existing health checks consume:
- `zpool status -x` returns "all pools are healthy" when good; anything else is an alert
- `zpool list -H -o name,health,frag,cap` for capacity/fragmentation tracking

The web-admin dashboard could grow a ZFS pool status card — out of scope for this migration but worth noting.

### Update backup-coverage audit

The audit currently scans `/mnt/2000/container-mounts/*` — after migration this becomes `/mnt/ssd-4tb/containers/*` and `/mnt/ssd-2tb/containers/*`. Update `scripts/backup-coverage-audit.sh` (or wherever the mount enumeration lives) to read from `user-config.yaml`'s `mounts:` list rather than hardcoding `/mnt/2000`.

## Rollback procedures

### If 4TB pool fails during Phase 2-3

- 4TB pool destruction: `sudo zpool destroy tank-4tb` then re-create with corrected params
- Per-app rollback during Phase 3: `umount` the bind, `mv /mnt/2000/container-mounts/<app>.pre-zfs /mnt/2000/container-mounts/<app>`, restart container

### If something fails during Phase 5 (after wiping 2TB)

The 2TB is gone — recovery is from:
1. Holding area on 4TB pool (`/mnt/ssd-4tb/holding/`) — still present until explicitly destroyed
2. Snapshot `tank-4tb@pre-2tb-wipe` — covers the migrated tier-1 data
3. Borg backups on backup-pi — covers everything

### If a container misbehaves after migration

The `.pre-zfs` dirs (kept until Phase 6 cleanup) are the fast path. If those are already gone, restore from borg.

## Post-migration checklist

- [ ] `zpool status` clean on both pools
- [ ] `zfs list` shows expected dataset hierarchy
- [ ] All previously-running containers up and healthy in web-admin
- [ ] Backup coverage audit green for all containers
- [ ] First scheduled scrub completes clean on both pools
- [ ] Sanoid creating snapshots on schedule (check `zfs list -t snapshot | head`)
- [ ] `df -h` shows expected free space distribution
- [ ] Old `.pre-zfs` directories cleaned up (after 3-7 day soak)
- [ ] This runbook updated with anything that surprised us during execution

## Open questions / decisions deferred

- **Jellyfin metadata move?** 75G of jellyfin config/metadata currently on `/mnt/2000`. Listed for migration to 4TB above, but if pool space gets tight in years, this is the first candidate to demote — metadata is regeneratable from media (just slow).
- **Game saves on 2TB pool?** Valheim/Minecraft/Starbound saves are on `/mnt/2000` now (~70G combined). Not in either tier above. Decide whether to migrate to 2TB pool (mirror protection) or leave on `/mnt/250` (cheap, no mirror, accept loss risk).
- **22TB HDD headroom.** At 82% and not addressed by this migration. Separate hardware purchase needed (likely a single larger HDD; mirroring 20TB+ HDDs is its own conversation).
