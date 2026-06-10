# ZFS Migration Runbook — neuromancer

Migration of neuromancer's primary container storage from a single 2TB mdadm+LVM+ext4 mirror (`/mnt/2000`) to a **single encrypted ZFS mirror pool** on two repurposed 4TB SSDs. Adds bulk-growth headroom and on-disk integrity checking for irreplaceable data (immich, nextcloud, paperless, etc.).

> **Status / history.** This runbook was originally written as a two-pool aspiration (4TB + 2TB mirrors) around a not-yet-purchased JMB585 SATA card. Reality intervened (see below), so the plan was revised on **2026-06-09** to a single encrypted 4TB pool. The two-pool design is deferred — see [Deferred: the 2TB drives and the new controller](#deferred-the-2tb-drives-and-the-new-controller).

## What changed from the original plan

| | Original aspiration | Actual plan (2026-06-09) |
|---|---|---|
| Controller | New SYBA/JMB585 PCIe SATA card for the 4TB drives | **Card not purchased yet.** Both 4TB SSDs landed on the Intel C200 native 6 Gb/s ports — *better* placement than planned |
| 2TB tier | Healthy 2-disk PNY mirror → `tank-2tb` | **One PNY died, removed for RMA.** Survivor runs solo (degraded mdadm) on the Marvell, still serving `/mnt/2000` until cutover |
| Topology | Two pools (4TB + 2TB) | **One pool** (`tank-4tb`) now; the 2TB tier is deferred until the RMA part and the new controller arrive |
| Encryption | Undecided (leaning no) | **Yes** — native `aes-256-gcm`, keyfile on root. Benchmark showed no throughput cost on SATA; the RMA of a *dead, unwipeable* drive is the concrete threat it kills |
| Datasets | Per-app datasets | **Hybrid** — dedicated datasets only for the DB + the big irreplaceables; everything else as plain dirs |

## Scope and goals

- **Add headroom.** `/mnt/2000` is at ~69% (1.2T used / 1.9T) and growing — primarily immich and nextcloud. The 4TB mirror lands the whole tree at ~32% full with years of growth.
- **Add integrity checking.** ZFS scrubs detect bit-rot that mdadm cannot see. Especially valuable for photos/scans that sit untouched for years.
- **Restore redundancy.** The source is currently a **degraded, single-disk** mirror (`md1 [2/1]`). Getting the data onto the new 2-disk ZFS mirror restores fault tolerance — this is now a goal, not just a nicety.
- **Encryption at rest.** Any data drive that fails and leaves for RMA/disposal carries unreadable data. The recently-dead 2TB SSD — being RMA'd *with* its data, unwipeable because it's dead — made this concrete.
- **No on-host replication.** Mirror + borg (local on 22TB HDD + offsite to backup-pi) covers the realistic failure modes. ZFS `syncoid` replication is a third belt that doesn't justify the operational cost for this setup.
- **No change to `/mnt/22TB` (bulk HDD) or root.** Out of scope. The 22TB HDD at ~83% is a separate problem requiring a bigger disk.

## Hardware

### Confirmed current state (2026-06-09)

Verified via `lsblk`, `/dev/disk/by-id/`, and `/sys/block/*` controller mapping:

| Dev | Drive | Controller | Role |
|---|---|---|---|
| **sda** | **SPCC 4TB SSD** (serial `…0102594`) | **Intel C200 native, ata1, 6 Gb/s** | **New ZFS mirror leg** (currently NTFS `Backups`, to be wiped) |
| **sdb** | **SPCC 4TB SSD** (serial `…0102580`) | **Intel C200 native, ata2, 6 Gb/s** | **New ZFS mirror leg** (currently NTFS `Matrix`, to be wiped) |
| sdc | Samsung 850 250G | Intel C200 native | `md0` → `/` + `/boot` (boot mirror, healthy) |
| sdd | Samsung 850 250G | Intel C200 native | `md0` → `/` + `/boot` |
| sde | Samsung 850 120G | Intel C200 native | `/mnt/120` (Monitor) |
| sdf | Samsung 840 PRO 238G | Intel C200 native | `/mnt/250` (Cache) |
| sdg | ST22000NM 22TB HDD | Marvell 88SE9172 (add-in), ata7 | `/mnt/22TB` |
| sdh | PNY 2TB SSD (survivor) | Marvell 88SE9172 (add-in), ata8 | `md1` (degraded) → `/mnt/2000`, decommissioned after cutover |

**Why this placement is good:** the new 4TB mirror sits entirely on the trustworthy Intel native controller at full 6 Gb/s — exactly where the busy pool belongs. The least-trusted controller (Marvell 88SE9172, cache-flush-honesty concerns) carries only the HDD and the lone 2TB, **neither of which is in a ZFS pool**. This preserves the controller-trust property the JMB585 purchase was originally meant to buy — achieved for free by the current cabling.

The two 4TB drives are the same SPCC (Silicon Power) model from one batch (consecutive serials). Budget consumer SSDs + correlated batch-failure risk = **borg discipline matters more than ever; the mirror is not the backup.**

### CPU / encryption headroom

i7-2600K (Sandy Bridge), 4C/8T, **AES-NI present**. Measured `openssl speed -evp aes-256-gcm`:

- Single core: **~1.3 GB/s** at 4K–16K blocks
- All 8 threads: ~6.1 GB/s
- A single SATA SSD (the real bottleneck): **~0.55 GB/s**

One core encrypts ~2.4× faster than one of these SSDs can move data, so **encryption costs no measurable sequential throughput** — the disk is always the bottleneck. Power: ~0 at idle (crypto only runs during active IO); ~5–8 W on a partial core during a sustained transfer; no fan change in normal use. **Scrubs cost nothing extra** — ZFS verifies the checksum/MAC over the *ciphertext* and does not decrypt during a scrub. (This "free" verdict holds *because we're on SATA*; on NVMe a single core would bottleneck.)

## Pre-migration preparation

### 1. Verify backup health — PASSED 2026-06-09

The source is a degraded single-disk mirror, so borg is the redundancy during the migration window. **Real borg topology** (the original runbook guessed wrong — there is no `webadmin@backup-pi:/borg-repos/...`):

- **Local (primary) repo:** `/mnt/22TB/borg-repo` on neuromancer itself (no SSH).
- **Offsite push:** `ssh://borg@backup-pi/mnt/backup/borg` (user `borg`, append-only, dedicated key via `BORG_RSH`).
- Config lives in `scripts/borg-backup.conf`. All migration paths (`/mnt/2000/container-mounts/`, `/mnt/2000/Hyperion/`, `/mnt/2000/samba/`, `/mnt/2000/FastmailBackup/`) are in `BORG_BACKUP_PATHS`.

Freshness check without passphrase or SSH — read the status JSON the backup writes:

```bash
cat ~/containers/homepage/images/borg-status.json   # status, last_backup, integrity_status
```

Verified state at migration time: local repo fresh (~12h), 14 archives, 1.84 TB, 0 dump errors, **local integrity verified**; offsite push fresh (~9h). The `remote_integrity_status: "failed"` field is a **stale leftover** from the pre-2026-06-07 client-side `borg check --verify-data` approach (decoupled because it was bandwidth-bound and lock-conflicting); offsite integrity is now checked **server-side on the Pi** by `borg-pi-manage.sh` and reported via healthchecks.io. Not a live alarm; it self-corrects on the next `borg-restore-test.sh` run. The fresh, integrity-verified **local** repo on a separate physical disk is the restore source if `sdh` dies mid-migration.

### 2. Document current state (rollback reference)

```bash
mkdir -p ~/migration-snapshot
df -h > ~/migration-snapshot/df-before.txt
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID > ~/migration-snapshot/lsblk-before.txt
cat /proc/mdstat > ~/migration-snapshot/mdstat-before.txt
sudo vgdisplay > ~/migration-snapshot/vgdisplay-before.txt
sudo pvdisplay > ~/migration-snapshot/pvdisplay-before.txt
cp ~/containers/user-config.yaml ~/migration-snapshot/user-config-before.yaml
sudo du -sh /mnt/2000/container-mounts/* > ~/migration-snapshot/sizes-before.txt
```

## Phase A — Install ZFS

```bash
sudo apt update && sudo apt install -y zfsutils-linux
zfs version
```

Ubuntu 24.04 ships ZFS in-tree; no DKMS needed.

## Phase B — Wipe the two new 4TB SSDs

Using `/dev/disk/by-id/` so there is no chance of hitting the wrong disk (neither of these is the 2TB survivor `sdh` or the boot mirror):

```bash
for id in ata-SPCC_Solid_State_Disk_SP20241213A0102594 \
          ata-SPCC_Solid_State_Disk_SP20241213A0102580; do
  sudo wipefs -a        /dev/disk/by-id/$id
  sudo sgdisk --zap-all /dev/disk/by-id/$id
done
```

## Phase C — Encryption key (and off-host copy)

```bash
sudo install -d -m 700 /etc/zfs/keys
sudo dd if=/dev/urandom of=/etc/zfs/keys/tank-4tb.key bs=32 count=1
sudo chmod 400 /etc/zfs/keys/tank-4tb.key
sudo base64 /etc/zfs/keys/tank-4tb.key   # → store in Infisical / password vault NOW
# restore later with:  base64 -d > /etc/zfs/keys/tank-4tb.key
```

**Critical key-management discipline.** The key lives on the unencrypted root mirror *by design* — it protects data drives that **leave** the building for RMA, not the running host. But if the root disk dies and there is no off-host copy, the pool is unrecoverable. The off-host copy (above) closes the failure mode that encryption introduces. Do it before putting any data on the pool.

## Phase D — Create the encrypted mirror

```bash
sudo zpool create \
  -o ashift=12 -o autotrim=on \
  -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl \
  -O encryption=aes-256-gcm -O keyformat=raw \
  -O keylocation=file:///etc/zfs/keys/tank-4tb.key \
  -O mountpoint=/mnt/ssd-4tb \
  tank-4tb mirror \
  /dev/disk/by-id/ata-SPCC_Solid_State_Disk_SP20241213A0102594 \
  /dev/disk/by-id/ata-SPCC_Solid_State_Disk_SP20241213A0102580

zpool status tank-4tb   # both disks ONLINE, mirror-0, no errors
```

**Property rationale:**
- `ashift=12` — 4K sectors, required for modern SSDs; **immutable** after creation
- `autotrim=on` — background TRIM keeps SSD perf consistent
- `compression=lz4` — near-zero CPU, early-aborts on incompressible data (media), often *faster* than off due to reduced IO; the safe "no speed loss" choice
- `atime=off` — cuts write amplification on SSDs
- `xattr=sa` — xattrs in inodes (faster, less fragmentation)
- `acltype=posixacl` — in case any container uses POSIX ACLs
- `encryption=aes-256-gcm` + `keyformat=raw` + file keylocation — encrypted at rest, unattended boot via the root-disk keyfile. **Encryption is pool-wide; every dataset inherits the key.** Cannot be added later without a rebuild.

## Phase E — Hybrid dataset layout

Datasets are not pre-sized — all draw from the shared pool free space. Dedicated datasets exist only where they earn it (independent snapshots/rollback for the irreplaceables; `recordsize=16K` matching InnoDB pages for the shared DB). The four child datasets mount **inside** `container-mounts`, which is what lets a single whole-tree rsync populate them transparently.

```bash
sudo zfs create tank-4tb/container-mounts
sudo zfs create tank-4tb/container-mounts/immich
sudo zfs create tank-4tb/container-mounts/nextcloud
sudo zfs create tank-4tb/container-mounts/paperless-ngx
sudo zfs create -o recordsize=16K tank-4tb/container-mounts/mariadb
zfs list -o name,used,recordsize,encryption,mountpoint
```

Resulting layout:

```
tank-4tb                                 /mnt/ssd-4tb                       (root; non-container dirs live here)
tank-4tb/container-mounts                /mnt/ssd-4tb/container-mounts      (~49 apps as plain dirs)
tank-4tb/container-mounts/immich         …/immich                          (default 128K — media-dominated)
tank-4tb/container-mounts/nextcloud      …/nextcloud                       (default 128K)
tank-4tb/container-mounts/paperless-ngx  …/paperless-ngx                   (default 128K)
tank-4tb/container-mounts/mariadb        …/mariadb        recordsize=16K   (InnoDB page size)
```

No manual `chown` — the migration `rsync -aHAX` preserves all ownership/ACLs/xattrs (including `samba`'s `scanner:sambashare`). `dawarich`, `jellyfin` (metadata), and the rest stay as plain dirs; promote any of them to a dataset later with `zfs create` if desired.

## Phase E-gate — Reboot test the encryption auto-load (do BEFORE migrating data)

The boot cron (`system-cron-startup.sh`) launches containers at boot; they must **not** start before the pool is imported, decrypted, and mounted, or they will write into empty mountpoints.

```bash
sudo reboot
# after it comes back:
zfs get keystatus,mounted tank-4tb       # expect: keystatus=available, mounted=yes  (no manual key load)
zpool status tank-4tb                     # ONLINE, no errors
```

**Confirmed on this host (2026-06-09): the key does NOT auto-load out of the box.** Ubuntu 24.04's `zfs-load-key.service` is *masked* (the distro expects the `zfs-mount-generator` + a populated `/etc/zfs/zfs-list.cache/`, which doesn't exist by default), so after a plain reboot every dataset showed `keystatus=unavailable, mounted=no`. Fix with an explicit oneshot unit, then re-test with another reboot:

```bash
sudo tee /etc/systemd/system/zfs-load-key-tank.service >/dev/null <<'EOF'
[Unit]
Description=Load ZFS encryption key for tank-4tb
DefaultDependencies=no
After=zfs-import.target
Before=zfs-mount.service
Wants=zfs-import.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/zfs load-key -a
[Install]
WantedBy=zfs-mount.service
EOF
sudo systemctl daemon-reload && sudo systemctl enable zfs-load-key-tank.service
sudo mkdir -p /etc/exports.d   # else `zfs mount -a` prints "failed to lock /etc/exports.d/zfs.exports.lock" (cosmetic NFS-share noise)
```

**Do not proceed to migration until a reboot brings the pool up decrypted and mounted unattended** — verify `zfs get -r keystatus,mounted tank-4tb` → `available`/`yes` and `systemctl status zfs-load-key-tank.service` → active (exited). The boot cron starts containers after `multi-user.target` (well after `zfs-mount.service`), so it naturally lands after the pool is mounted — but confirm nothing races ahead of it.

## Phase F — Migrate `/mnt/2000` → the pool

**Scope:** everything under `/mnt/2000` *except* `lost+found/` (an ext4 fsck artifact ZFS doesn't use). That is: `container-mounts/`, `FastmailBackup/`, `Hyperion/`, `samba/`, `tailscale-state/`, `for-homepage/`.

Because the child datasets are mounted at their natural paths, a single recursive rsync writes into them transparently — no per-app rsync needed.

### Minimize downtime: pre-seed warm, then short stop-and-delta

```bash
# 1. Pre-seed while containers still run (data churns, that's fine — this is a warm copy)
sudo rsync -aHAX --info=progress2 --delete --exclude '/lost+found' \
  /mnt/2000/ /mnt/ssd-4tb/

# 2. Stop everything for the short cutover window
~/containers/scripts/all-containers.sh --stop

# 3. Final delta rsync (only what changed since the warm copy — fast; DB files now at rest)
sudo rsync -aHAX --info=progress2 --delete --exclude '/lost+found' \
  /mnt/2000/ /mnt/ssd-4tb/

# 4. Verify: a third dry-run should report nothing to transfer
sudo rsync -aHAXn --info=progress2 --delete --exclude '/lost+found' \
  /mnt/2000/ /mnt/ssd-4tb/
```

**Database note:** rsync is safe for the DB containers (immich/nextcloud/paperless/dawarich/mariadb) because they are fully stopped for the final delta — files are at rest. If a DB shows corruption after cutover, the old `/mnt/2000` is still intact (not wiped until Phase H) — fall back to it and investigate.

## Phase G — Repoint the platform at the pool

```bash
# Edit ~/containers/user-config.yaml: change mount[0] path from /mnt/2000 to /mnt/ssd-4tb
#   (label e.g. "Primary SSD (4TB ZFS mirror, encrypted)").
# The per-container path mount[0]/container-mounts/<app> now resolves to the pool.

# Regenerate .env files so compose paths reflect the new mount[0]
~/containers/scripts/generate-env.js

# Tailscale node identity: TS_STATE_HOST_DIR points at <mount[0]>/tailscale-state/<container>
#   — it follows mount[0] automatically once tailscale-state/ has been migrated (it has, Phase F).

# Start everything back up via the platform script
~/containers/scripts/all-containers.sh --start
```

Verify: all previously-running containers healthy in web-admin; spot-check immich/nextcloud/paperless UIs and that writes land on the pool (`zfs list` used-space grows).

## Phase H — Decommission the degraded 2TB and clean up

**Only after a few days of clean running on the pool**, and with `/mnt/2000` confirmed no longer referenced anywhere:

```bash
sudo umount /mnt/2000
sudo lvremove vg1/lv1
sudo vgremove vg1
sudo pvremove /dev/md1
sudo mdadm --stop /dev/md1
sudo mdadm --zero-superblock /dev/sdh        # the surviving 2TB
sudo wipefs -a /dev/sdh
# remove the /mnt/2000 line from /etc/fstab
lsblk
```

The freed 2TB (`sdh`) now sits idle on the Marvell port until the [deferred](#deferred-the-2tb-drives-and-the-new-controller) decision.

## Execution notes — what actually happened (2026-06-09 → 06-10)

The migration ran successfully with no data loss and no rollback. Deviations from the plan above and gotchas worth remembering:

- **Hardware:** the JMB585 card was never purchased; both 4TB SSDs landed on the Intel native 6 Gb/s ports (ata1/2), with the surviving 2TB + 22TB HDD on the Marvell. This is the *ideal* placement (ZFS pool on the trusted controller) and made the card unnecessary for now.

- **Encryption auto-load needed a manual systemd unit** (see Phase E-gate) — `zfs-load-key.service` is masked on Ubuntu 24.04. The reboot gate caught it before any data moved.

- **Phase F was a single rsync, not warm-preseed + delta.** Containers were already stopped (cron disabled before the hardware move), so the source was at rest — one `rsync -aHAX --delete --exclude=/lost+found /mnt/2000/ /mnt/ssd-4tb/` did it. ~1.2 T in ~6–8 h, bottlenecked by the budget SPCC SSDs' sustained write (~50–80 MB/s), not CPU/encryption. A clean dry-run rsync (zero output) was the completeness gate.

- **Repointing was far broader than `user-config.yaml`.** Container paths flip automatically (`all-containers.sh --start` re-runs `generate-env.js`), but many **non-container** references had to be fixed by hand. This was the bulk of the real work:
  - **System services (root-owned):** `/etc/samba/smb.conf` (ScanHere, DeathStarPlans shares), `/etc/exports` (DeathStarPlans, Hyperion), `/etc/passwd` (the `scanner` user's home — fix via `usermod -d`), and **`/etc/sudoers.d/chrisl8`** — the landmine: its `NOPASSWD` `chmod/chown` rules hardcode the mount path, so leaving them on `/mnt/2000` would make the platform's mount-permission steps prompt for a password and hang the non-interactive `@reboot` cron. Validate with `visudo -cf` after editing. Reload with `systemctl restart smbd` + `exportfs -ra`.
  - **Generated artifacts — fix the source, not the render:** `scripts/borg-backup.conf` is re-emitted by the web-admin's `writeBorgConf()` from `user-config.yaml`'s `borg:` block; `beszel/` + `homepage/` `compose.override.yaml` are rewritten by `regenerate-monitoring-mounts.js` from `mounts:` on every start. `caddy/mount-permissions.yaml` is a render of the `do-it-self-personal` module source (fix both the module source and the root render).
  - **Personal cron scripts (`~`, outside the repo — easy to miss):** `imapbox-js/config.json5` (FastmailBackup + ScanHere/From Email), `Scripts/fastmail-notmuch-sync.sh`, `Scripts/updateWebstatsOnNeuromancer.sh`, `Scripts/obsidian2paperless.sh`, `Scripts/updateJellyfinFiles.sh`. Find them with `grep -rn /mnt/2000 ~ --include=*.sh --include=*.json5 ...`.

- **Samba & NFS are *system* services, not containers.** They served the frozen `/mnt/2000` for ~8 h after the container cutover, but an mtime check confirmed **no writes** in that window, so nothing diverged.

- **Retire-with-immutable-trap instead of a silent unmount.** Rather than leave `/mnt/2000` mounted as a quiet fallback, we made stragglers fail *loudly* during the soak: `sudo umount /mnt/2000 && sudo chattr +i /mnt/2000` (empty immutable mountpoint → ENOENT/EPERM instead of stale reads or docker auto-creating a tree on root), plus comment the fstab line. `umount` deletes nothing, so rollback = `chattr -i` + remount the LV. **This trap is what surfaced the personal-cron-script stragglers** — they'd otherwise have silently run against frozen data. (Phase H's teardown must `sudo chattr -i /mnt/2000` first.)

- **Outcome:** all 131 containers came up healthy on the pool; pool held 0 errors throughout. Remaining work is the soak, then Phase H.

## Phase I — Operational setup

### Auto-snapshots (sanoid)

```bash
sudo apt install -y sanoid
sudo cp /usr/share/doc/sanoid/examples/sanoid.conf /etc/sanoid/sanoid.conf
```

```ini
[tank-4tb/container-mounts]
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

Confirm the timer: `systemctl list-timers | grep sanoid`.

### Scheduled scrub

```bash
echo '0 3 1 * * root /usr/sbin/zpool scrub tank-4tb' | sudo tee /etc/cron.d/zfs-scrub
```

### Monitoring

- `zpool status -x` → "all pools are healthy" when good; anything else alerts.
- `zpool list -H -o name,health,frag,cap` for capacity/fragmentation tracking.
- SMART monitoring on `sda`/`sdb` (budget batch-matched drives — watch them).
- A ZFS pool-status card in web-admin is a reasonable follow-up (out of scope here).

### Update the backup-coverage audit

`scripts/backup-coverage-audit.sh` (and `BORG_BACKUP_PATHS` / `BORG_CONTAINER_MOUNT_DIRS` in `borg-backup.conf`) currently reference `/mnt/2000/...`. After cutover these become `/mnt/ssd-4tb/...`. Update them to read from `user-config.yaml`'s `mounts:` list rather than hardcoding the path, and re-run the audit to confirm green.

## Rollback procedures

- **Pool creation/migration goes wrong (Phases B–G):** the old `/mnt/2000` is untouched until Phase H. `zpool destroy tank-4tb`, fix params, retry. Per-app issues: restart against the still-mounted `/mnt/2000`.
- **Container misbehaves after cutover but before Phase H:** revert `mount[0]` in `user-config.yaml` to `/mnt/2000`, regenerate `.env`, restart. The original data is still live.
- **After Phase H (2TB wiped):** recovery is from the integrity-verified local borg repo (`/mnt/22TB/borg-repo`) or offsite (`backup-pi`). This is why Phase H waits several days.

## Post-migration checklist

- [ ] `zpool status` clean; `zfs list` shows the expected hierarchy
- [ ] Reboot brings the pool up decrypted + mounted with no manual step
- [ ] All previously-running containers up and healthy in web-admin
- [ ] Encryption key copy stored off-host (Infisical / vault)
- [ ] Backup-coverage audit green against the new paths
- [ ] First scheduled scrub completes clean
- [ ] Sanoid creating snapshots on schedule
- [ ] Old `/mnt/2000` decommissioned (Phase H) after the soak period
- [ ] This runbook updated with anything that surprised us

## Deferred: the 2TB drives and the new controller

Revisit once **both** of these arrive:

1. **The RMA replacement 2TB SSD** returns (pairing with the survivor `sdh`, freed in Phase H — two empty 2TB SSDs).
2. **The new PCIe SATA card** (JMB585 / SYBA SI-PEX40139) is purchased and installed, adding trustworthy 6 Gb/s ports.

At that point, decide how to divvy up the two empty 2TB drives. Open options to weigh then:

- **Second mirror pool (`tank-2tb`)** — the original two-pool design: a separate failure domain for tier-2 data (databases, secrets, code, notes) with its own scrub/snapshot cadence. Needs the new card so both ZFS pools stay off the Marvell.
- **Retire the 2TB tier entirely** — with the 4TB mirror at ~32%, a second pool may be unnecessary. Repurpose the 2TB drives elsewhere (cache, scratch, a non-critical mirror).
- **Other uses** — `/mnt/250`-style cache, a dedicated DB pool, etc.

Controller-placement rule to honor when revisited: **every ZFS pool stays on trustworthy controllers** (Intel native or the new JMB585). The Marvell 88SE9172 carries only the HDD / non-pool disks — putting a mirror leg on it reintroduces the cache-flush-honesty risk the new card is meant to avoid. Update the [Confirmed current state](#confirmed-current-state-2026-06-09) table after any re-cabling.

## Deferred: benchmark all drives to inform data placement

The current layout was chosen for **safety and redundancy, not speed** — the 4TB mirror is the safest home for the irreplaceable data, full stop. But the drives have never been characterized head-to-head, and at some point it's worth measuring **every drive in the box** to decide whether any data should be (re)distributed by speed tier.

What and why:
- The new SPCC 4TB SSDs are budget DRAM-less QLC-class; their **sustained (post-SLC-cache) write** is the unknown. The ~50–80 MB/s seen during the migration is *not* a valid benchmark — it was small-file-bound (immich thumbnails), cross-drive (reading the old 2TB), and mirror-write-amplified. A clean `fio` run (sequential + small-random, read + sustained-write) is the only way to get real numbers.
- Characterize the whole set: SPCC 4TB pool, the surviving PNY 2TB, the Samsung 840/850 SATA SSDs (`/mnt/250`, `/mnt/120`), and the 22TB HDD. Knowing the actual ceilings tells you where a latency- or throughput-sensitive workload (e.g. a database, a cache, scratch space) actually belongs vs. where it sits today by historical accident.
- **Clean opportunity for the old 2TB:** after cutover and before wiping `sdh` in Phase H, it goes idle — benchmark it then, alongside the now-populated 4TB pool, for a direct old-vs-new comparison before it's decommissioned.

This is an optimization pass, not a correctness requirement — the data is safe and mirrored regardless. Revisit when there's a concrete "is X fast enough / where should X live" question, or opportunistically during the Phase H window.
