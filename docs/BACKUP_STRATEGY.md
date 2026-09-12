# Backup Strategy — neuromancer

The consolidated picture of what gets backed up, where, on what schedule, and
how to restore it. Other docs cover the *setup* of individual pieces
(`SETUP-BACKUP-PI.md`, `WINTERMUTE_COVERAGE_SETUP.md`); this one is the map
that ties them together, and the place to record deliberate backup-coverage
decisions so they don't look like gaps on the next audit.

Host-specific details (real names, locations, hardware serials) that don't
belong in a public repo live in the gitignored `docs/config-personal/BACKUP_STRATEGY.md`
companion instead of here.

## The three backup systems

| System | Covers | Destination(s) | Schedule |
|---|---|---|---|
| **Borg** | This host's own container data, DB dumps, `$HOME`, `/etc` | Local (`/mnt/22TB/borg-repo`) + offsite (`backup-pi`, via Tailscale) | Nightly (23:00), weekly restore-test |
| **Kopia** | Windows PCs that back up *to* this host | `/mnt/22TB/container-mounts/kopia/repository` only (see [Kopia risk acceptance](#kopia-risk-acceptance)) | Continuous (client-driven), 6h freshness check, weekly restore-test |
| **Inbound Borg** | Other Linux hosts (wintermute) pushing their own borg backups here | `/mnt/22TB/borg/backups` (received copy; wintermute's own repo + its own backup-pi push are the other two copies) | Whenever wintermute runs its cron; 6h freshness check here |

Each system's job is bounded on purpose: Borg backs up *this machine's* data,
Kopia backs up *other machines'* data, and neither re-backs-up the other
(see the coverage-audit acks for `container-mounts/kopia`,
`container-mounts/kopia-tr0n`, and `borg-repo`/`borg`).

## 1. Borg — this host's data

**Sources** (`scripts/borg-backup.conf` → `BORG_BACKUP_PATHS`): all
container-mounts roots (`ssd-4tb`, `ssd-2tb`, `250`, `22TB`, and `120` if it
ever gets any — see [/mnt/120](#mnt120-swap-only)), `archive/`, `Foundation/`,
`Hyperion/`, `samba/`, `FastmailBackup/`, `$HOME`, and `/etc`.

**DB dumps** (`scripts/borg-db-dump.sh`, runs before the archive job): every
Postgres, MariaDB, MongoDB, and SQLite-backed service gets a logical dump to
`/mnt/22TB/borg-db-dumps/` first, so the archive captures consistent
point-in-time data instead of raw (possibly mid-write) data files. The raw DB
data directories themselves are excluded from the archive
(`borgbackup/exclude-patterns.txt`) since the dump already covers them.

**Exclusions**: re-acquirable media (recon movies/TV, jellyfin libraries),
raw DB data dirs, kopia's own repo, caches, `node_modules`, tailscale-state,
scratch dirs. Full list in `borgbackup/exclude-patterns.txt`.

**Destinations & retention**:
- Local repo `/mnt/22TB/borg-repo` — 7 daily / 4 weekly / 6 monthly / 2 yearly.
- Offsite `backup-pi` (via Tailscale) — 3 daily / 4 weekly / 12 monthly / 5 yearly.

**Schedule**: nightly at 23:00, offsite push first then local
(`--remote-only` then `--skip-remote`, serialized so they don't thrash disk
I/O simultaneously — see `borg-backup.sh` header). Weekly restore-test
Sundays 06:00 (fast repo-check most weeks; full `--verify-data` byte-level
check on the first Sunday of the month), extracting a real sample
(`~/credentials/`, DB dumps, `etc/hostname`) to prove restorability, not just
repo consistency.

**Backup-pi side**: managed from neuromancer via `scripts/borg-pi-manage.sh`
— daily SMART check (07:00), daily prune+freshness (08:00), daily bitrot
check (12:00), weekly archive-check + restore-test (Sun 08:30/09:00). Full
provisioning spec in `docs/SETUP-BACKUP-PI.md`.

**Known accepted exclusions** (see `backup-coverage-acks/<hostname>.json` for
the full list with reasons): the pre-Linux-migration Windows disk image and
the security-camera rolling archive on `/mnt/22TB` are both *kept locally but
not pushed to the Pi* — a deliberate size/priority tradeoff, not an oversight.
Losing the disk drive that holds them would lose that content.

### /mnt/120 (swap-only)

`/mnt/120` is a single-disk ext4 mount used **entirely as swap space**
(`swap.img`) plus an empty `for-homepage/` dir Homepage uses to display free
space. It's deliberately not a backup source. The coverage-audit already
watches it: `backup-coverage-audit.sh`'s ack file acknowledges the mount root
and its known-empty contents specifically, so if anything else ever gets
dropped in there, it will show up as an unacknowledged `uncovered` entry on
the Web Admin's Backup Coverage page automatically — no separate monitoring
needed.

## 2. Kopia — other machines' Windows backups

The `kopia` container runs a repository server at
`/mnt/22TB/container-mounts/kopia/repository` (~4.9 TB packed) that Windows
clients push to directly. As of 2026-09, two active sources:

- **`monami`** — live, backs up daily. Threshold 336h (14 days) before it's
  flagged stale.
- **`max`** — frozen since 2026-06-14, no longer in active use and no
  longer backs up here. Deliberately kept but not actively growing.
  Threshold set high (2160h / 90 days) so it doesn't nag — this is expected
  staleness, not a fault. Plan: let it age further and delete once it's
  stale enough that the data is no longer worth holding "just in case," per
  an explicit decision rather than benign neglect.

**Freshness check**: `scripts/kopia-backup-check.sh`, every 6h, pings
healthchecks.io and writes `homepage/images/kopia-status.json` for the
dashboard.

**Restore test**: `scripts/kopia-restore-test.sh` (added 2026-09-06),
Sundays at 05:00 — runs `kopia snapshot verify`, which walks every blob in
the repo checking for missing/corrupt content. On the first Sunday of the
month it also downloads and hashes a small sample of real file content
(`--verify-files-percent`, default 2%) for a deeper check, mirroring Borg's
fast/full split. Results merge into the same `kopia-status.json` the
freshness check writes (`last_verify`, `verify_status`, `verify_mode`).
Optional healthchecks.io ping via the `kopia-backup-check` Infisical path's
`KOPIA_RESTORE_TEST_HEALTHCHECK_URL` key (not required — the script no-ops
cleanly without it).

### Kopia risk acceptance

The Kopia repository itself has **no second copy anywhere**. It's
deliberately excluded from Borg's own backup run (backing up a backup adds
little value and a lot of size), and nothing else copies it offsite.
Concretely:
- **`monami`** (live): accepted risk. Most of that data lives elsewhere
  too, so a total loss of this backup is inconvenient, not catastrophic.
- **`max`** (frozen): low stakes by design — it's stale, scheduled for
  eventual deletion, not a backup anyone is relying on to stay current.

If a third, currently-relied-upon live source is ever added to this Kopia
repo, revisit this acceptance — a live backup with no second copy is a much
bigger deal than the two sources above.

## 3. Inbound Borg — other Linux hosts

Wintermute runs its own borgmatic-based backup and pushes to **both**
`backup-pi` and a receive-side repo on neuromancer
(`/mnt/22TB/borg/backups`) — so that data already has 2-3 copies independent
of anything neuromancer does with it. Neuromancer just checks freshness
(`scripts/borg-inbound-check.sh`, every 6h) and does **not** re-back-up this
data via its own Borg run (would be a fourth copy of the same bytes for no
real benefit). Wintermute's borgmatic config is translated for the shared
coverage-audit tooling via `scripts/borgmatic-config-adapter.sh` — see
`docs/WINTERMUTE_COVERAGE_SETUP.md` and `docs/WINTERMUTE_BORGMATIC_CONFIG.yaml`.

## 4. Coverage audit — catching drift

`scripts/backup-coverage-audit.sh` runs hourly as `chrisl8` (deliberately not
root — see script header) and walks `/home`, `/mnt`, `/root`, `/opt`, `/srv`,
`/etc` looking for anything not covered by `BORG_BACKUP_PATHS`. It classifies
each candidate as `covered` / `partial` / `uncovered` / `unreadable` by path
membership, not by actually reading file contents — so root-owned data under
an already-covered path (e.g. a container's data dir readable only by its
container's UID) is correctly marked `covered` even though the audit process
itself can't read it; the real Borg backup runs as root and does have access.
Known exceptions are recorded with a reason in
`scripts/backup-coverage-acks/<hostname>.json` (surfaced/editable from the
Web Admin's Backup Coverage page) so they stop showing up as
`needs_review` without being silently forgotten.

## Known accepted gaps (not TODOs — decisions)

- **Kopia has no second copy** — see [Kopia risk acceptance](#kopia-risk-acceptance) above.
- **Local Borg repo lives on a single, non-redundant disk** (`/mnt/22TB`,
  plain ext4, no RAID/ZFS mirror). A drive failure there loses the local
  copy instantly; the offsite `backup-pi` copy is what protects against
  that. This is accepted because the offsite copy exists and is
  independently verified (weekly restore-test, daily freshness/bitrot
  checks) — but it means a local-repo drive failure is a "restore from
  Colorado" event, not a "restore from next door" event. Worth remembering
  when estimating recovery time.
- **The security-camera archive and the pre-migration Windows disk image**
  on `/mnt/22TB` are kept locally only, not pushed offsite (see the Borg
  section above) — a deliberate size tradeoff.

## Open item: tank-2tb disk health — suspected cable, not drive

`tank-2tb` (the ZFS mirror holding every service's live database) is
`ONLINE` with no data errors, but one mirror member (serial in
`docs/config-personal/BACKUP_STRATEGY.md`, `/dev/sdg` as of the 2026-08-04
install — device letters are boot-order dependent, confirm serial before
touching hardware) has been throwing corrected CKSUM errors since
2026-08-18, roughly every 1-3 days, most recently 2026-09-06 — confirmed via
`journalctl`/`zed` events, ongoing, not a one-time blip. The mirror sibling
has zero errors.

**This is not a dying-drive signature.** SMART pulled 2026-08-30
(`~/smart-sdg.txt`) came back clean: 0 reallocated sectors, 0 pending
sectors, 2% wear, overall PASSED — but the SATA PHY event log showed 5
COMRESET events and a UDMA_CRC error, which points to a marginal
cable/connector rather than media failure. `sdg` sits on the add-in JMicron
JMB585 PCIe card while its clean sibling is on the onboard Marvell
controller — different cabling entirely, consistent with only one side of
the mirror being affected. Full write-up and diagnostic data: see
`docs/config-personal/BACKUP_STRATEGY.md`.

**Next steps (still pending as of 2026-09-06 — errors are ongoing, so the
physical fix hasn't happened yet):**
1. Confirm `sdg`'s serial still matches (`docs/config-personal/BACKUP_STRATEGY.md`
   has the exact serial to grep for in `ls -l /dev/disk/by-id/`) before
   touching anything.
2. Power down, reseat or replace the SATA data + power cable for the
   JMB585 card's port 1.
3. `zpool clear tank-2tb` to reset error counters after reseating.
4. Watch `zpool status` / `journalctl -k | grep zed.*checksum` over the
   following days/weeks for recurrence.
5. Only if errors continue after the cable swap, treat it as a genuine
   drive/controller fault and `zpool replace` the drive.

Not urgent (mirror is protecting data live), but shouldn't sit indefinitely
— the fix requires physical on-site access, which is likely why it's still
open.
