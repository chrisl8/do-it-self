# BorgBackup Setup Walkthrough

Follow these steps in order from the web admin on the host you want to back up. Every checkbox-able thing lives on the Backups page — you shouldn't need a shell for any of it.

## What borg gives you

- Encrypted, deduplicated nightly backups of your container volumes, database dumps, `$HOME`, and `/etc`.
- Optional offsite replication to a second server (typically a Raspberry Pi on your tailnet) so a host loss or ransomware event doesn't take your backups with it.
- Daily backup at 03:00 and a weekly restore test on Sundays at 06:00, both installed as user cron jobs.

## What borg does **not** give you

- Real-time replication. A file deleted at 02:59 is gone until the 03:00 run captures its absence.
- Any protection you haven't opted into — media directories, Jellyfin libraries, etc. are only backed up if you leave their path enabled in **Step 3**.
- Recovery of encrypted archives if you lose the passphrase. Treat **Step 4** as the single most important part of this page.

## Prerequisites

- You can reach the web admin. The Backups page is at `/backup-status`.
- Infisical is running on this host. It holds the borg passphrases. If it isn't up, the Borg Backup Configuration section will show a prereq banner and refuse to proceed — enable it on the Containers page first.
- You've run `sudo apt install borgbackup sqlite3` once. The setup script tries this but needs sudo; the web admin can't self-escalate. On a brand-new host:

  ```bash
  sudo apt install -y borgbackup sqlite3
  ```

  Already installed on neuromancer; shown here for deepthought and anything new.

- A mount with enough headroom for the deduplicated repo. Borg dedupes and compresses, but containers with large media libraries will still cost real disk.

---

## Step 1 — Open the Backups page

In the web admin, go to **Backups**. Above the existing "Borg Backup" status card you'll see a new section titled **Borg Backup Configuration**.

If that section shows an *Infisical is required* alert, stop and go fix that first — Infisical stores your passphrase, and nothing below works without it.

If the section shows a small yellow "Not yet saved — showing live conf" chip, that's fine — it means you're on a host that had a hand-edited `scripts/borg-backup.conf` before this UI existed. Your first **Save configuration** click in Step 5 quietly imports those values into `user-config.yaml:borg` and starts generating the conf from there.

---

## Step 2 — Pick where the repo lives

**What to set:** `Repository location` (which becomes `BORG_REPO`).

Pick a mount from the dropdown. The UI auto-appends `/borg-repo` so your value ends up like `/mnt/22TB/borg-repo`. You can edit the path field directly if you want a different name.

Picking a mount also seeds `Database dump directory` as `<mount>/borg-db-dumps`. Dumps are written there just before each backup run, so they're captured by borg as ordinary files. Put it on the same drive as the repo unless you have a reason to split.

**Tradeoffs:**

- More headroom = longer retention before compaction prunes. 1-2× your data size is usually plenty.
- Avoid putting the repo on the same drive as your largest single source of risk (the drive holding the live data you're protecting). If that drive dies, so does the repo.
- If you're on a host with only one mount, that's fine — offsite backup in Step 6 is the redundancy.

Don't click Save yet — keep configuring.

---

## Step 3 — Choose what gets backed up

**What to set:** `Paths to back up` (which becomes `BORG_BACKUP_PATHS`).

The list auto-seeds on a fresh host with every mount's `container-mounts/` dir, the DB dump dir, `$HOME`, and `/etc`. Each row has a toggle switch, the path, a size estimate chip, and a delete button.

**What to look at:**

- **Size estimates** appear on the right of each row via `du -sh`. The first estimate for a large directory can take 30-60 seconds to come back; results cache for 10 minutes.
- **"Mounts not currently in backup"** below the list lists any configured mount whose content is entirely uncovered by the enabled paths. If you intentionally don't back up a scratch drive, leave it. If a mount there holds data you'd miss after a host loss, add it.

**Common adjustments:**

- **Large media directories.** Movies, TV libraries, ROM collections etc. are often re-downloadable or not worth the encrypted-backup space. Toggle their specific sub-path off, or remove it entirely. Anything not in this list is silently excluded.
- **Sub-directory precision.** You can list specific sub-paths of a container-mounts dir (e.g. `/mnt/22TB/container-mounts/recon/data/media/comics/`) without including the whole parent. That's how curated setups stay focused.
- **Add a path.** Click **Add path**, paste the directory, leave the switch on.

Exclusions inside a backed-up path are governed by `borgbackup/exclude-patterns.txt` (shared across hosts). It already skips things like torrent working dirs, container caches, and Tailscale state. Edit that file if you want host-specific ignores beyond what the web admin toggles cover.

---

## Step 4 — Set (or generate) the local passphrase

**Read this section before clicking anything.**

The borg passphrase is:

1. **What encrypts every archive.** Without it, the repo is a ciphertext blob.
2. **What you need on a new box to restore** after your host is gone. The encrypted key file in `~/credentials/borg-repo-key.txt` is useless without the passphrase.
3. **A single point of loss.** If you lose both the host and the passphrase, your backups are **unrecoverable**. No vendor support call will help. No reset button in this UI will restore your archives; it can only start a new, empty repo.

### How to save it off-box

Before generating, open two places where you can paste a secret:

- **A password manager** (1Password, Bitwarden, etc.). Primary.
- **A second, independent place** — a sealed envelope in a fireproof box, an encrypted USB stick you don't keep on the same desk, a second password vault, a text file in a different cloud account. Something that doesn't die when your primary does.

Aim for two-of-three survival: host, primary vault, backup location. Any two should be recoverable.

### Running the generator

In the **Local passphrase** row, click **Generate strong passphrase**. A dialog opens showing the plaintext passphrase. Features:

- **Copy button** — puts it on your clipboard.
- **Red warning** — the load-bearing text. While the host is alive you can Reveal the passphrase again later; once the host is gone, you can't.
- **Regenerate** — pick a new one; resets the 5-second wait.
- **Cancel** — bails entirely; nothing is written.
- The primary button stays disabled for five seconds. Read the warning. Then copy it, paste it into your password manager, paste it into your backup location, verify both saved, and only then click **I've saved it — write to Infisical**.

After you confirm, Infisical at `/borgbackup` stores it. The UI row switches to showing `●●●●●●●●` with a *stored in Infisical* chip and a **Reveal** button. The Reveal button retrieves the passphrase from Infisical on demand so you can re-copy it later, but that only works while this host and Infisical are alive — which is exactly why off-box save matters.

### If you already have a passphrase you like

Click **Enter my own** instead, paste, Save. Same storage path, same rules about off-box saving.

### Lost passphrases

There are two distinct scenarios people lump together here. They behave very differently.

**Host alive, you just don't remember the passphrase.** Not a disaster. Infisical on the host still has it. Open the Backups page and click **Reveal** next to the passphrase row — the plaintext comes back. Copy it to a password manager and an offline location so you don't hit this again. Save off-box *right now* while you have the chance.

**Host lost (disk died / machine stolen / fire / flood) and the passphrase wasn't saved off-box.** Different story. Infisical went with the host. The encrypted local repo went with it too. The remote repo at backup-pi is encrypted with a *different* passphrase — if that one is saved off-box, the remote archives are still recoverable; if not, both repos are permanently unreadable. Your options at that point are:

- Restore whatever is still reachable from the remote (only possible if you have the remote passphrase saved off-box) and start a new local repo.
- Accept the loss and start over.

This second scenario is why the generate dialog warns so loudly about saving off-box. The web admin can give you the passphrase back while the host is up; it cannot conjure it after the host is gone.

---

## Step 5 — Save and initialize

Scroll to the bottom of the section and click **Save configuration**. This:

- Writes your settings to `user-config.yaml:borg`.
- Regenerates `scripts/borg-backup.conf` from that.
- If you were on an older hand-edited setup, this is also your migration.

Then click **Initialize repositories**. That runs `scripts/setup-borg-backup.sh`, which:

1. Verifies / installs borgbackup and sqlite3 (requires passwordless sudo; if not available, install them manually once as shown in Prerequisites).
2. Creates the dump directory and log dir.
3. Confirms Infisical is reachable.
4. Runs `borg init --encryption=repokey-blake2` against your local repo.
5. Exports the encrypted repo key to `~/credentials/borg-repo-key.txt`. **Save this file off-box too** — same two-place rule as the passphrase. It's still encrypted by the passphrase, but recovery is simpler if you have both.
6. Installs the two cron jobs (daily backup, weekly restore test).
7. Writes an initial status JSON for the dashboard.

The output streams into a dialog. When it finishes, look for `Setup complete`. If it warned that any step was skipped, that step is something you still owe — the dialog will list them.

Then click **Run backup now**. This starts `scripts/borg-backup.sh` in the background. Backups take 20-40 minutes for a fresh medium-sized setup. Watch progress in the existing *View Log* button on the status card or in the status JSON refresh.

---

## Step 6 — (Optional but recommended) Offsite backup

An offsite mirror protects you against the host dying, the disk dying, the house burning, or ransomware encrypting the local repo. It's a restricted-shell user on a separate server that accepts borg push-only traffic.

Expand the **Offsite (remote) backup** subsection.

### Fresh Pi

If you haven't set up the backup Pi yet, run `setup-backup-pi.sh` on it (the canonical provisioning script — handles restricted shell, append-only, weekly server-side prune, email alerts on low disk). That's outside the scope of this UI. Come back here when the Pi is provisioned and reachable over SSH on your tailnet.

### Existing Pi (second host pointing at the same backup-pi)

This is the common case if you already have a working offsite target from another machine.

1. On *this* host, run:

   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```

2. Append that public key to the Pi's `borg` user's `~/.ssh/authorized_keys`. The Pi's shell is restricted so that key can only run `borg serve --append-only` — it can't be used to log in for arbitrary commands.
3. Fill in **Remote repo URL** — format: `ssh://borg@backup-pi/mnt/backup/borg` (match what the Pi is configured for).
4. Generate or paste the **Remote passphrase**. Same one-time-reveal, same off-box save, same unrecoverable-if-lost. **Use a different passphrase from the local one** — it encrypts a separate repo and is stored separately.
5. Optional: set **Rate limit** if the Pi is off-site and you'd otherwise saturate the uplink. Typical: 5000 (kB/s) for a 50 Mbit upload.
6. Click **Save configuration**, then **Initialize repositories** again. The setup script detects the remote config and inits the offsite repo without retouching local.

The key file for the remote repo is exported to `~/credentials/borg-remote-repo-key.txt` — save it off-box too.

---

## Step 7 — Verify

- **Dashboard banner.** The "Borg backup is not configured" banner disappears once `state: ok` (local succeeded, and remote either succeeded or is disabled).
- **Status card Overall chip.** `Success` = both sides succeeded. `Partial` = local succeeded, remote failed. `Failed` = local failed. The Local: and Remote: rows break this down explicitly.
- **Cron.** Two cron lines should be present in your user crontab:

  ```
  0 3 * * * ~/containers/scripts/borg-backup.sh
  0 6 * * 0 ~/containers/scripts/borg-restore-test.sh
  ```

  The setup script installs them. The weekly restore test extracts a known-present file (`/etc/hostname` by default) and confirms it matches, flagging silent archive corruption before you need it.

- **healthchecks.io.** Optional. Set `BORG_HEALTHCHECK_URL` and `BORG_RESTORE_TEST_HEALTHCHECK_URL` on the Backups page so you get emailed when a run is missed or fails.

---

## Troubleshooting

- **Borg Backup Configuration section shows the Infisical banner.** Infisical isn't running. Start it from the Containers page; refresh the Backups page.
- **Initialize repositories fails on `apt install`.** Passwordless sudo isn't set up for the web-admin user. Run `sudo apt install -y borgbackup sqlite3` once manually, then re-click Initialize.
- **Initialize repositories fails at `borg init`.** Usually means `BORG_PASSPHRASE` isn't in Infisical. Go back to Step 4.
- **Remote setup warns "Cannot SSH to ..."**. The Pi's `borg` user doesn't have your public key in `authorized_keys`, or the Pi isn't reachable on the tailnet. Verify with `ssh borg@backup-pi echo ok` from this host.
- **Nightly backup runs but reports "Partial"**. The status card Remote row tells you which side failed; check the *View Log* output and the Pi's disk space.
- **Restore test fails.** Look at `borg-restore-test.sh`'s log in `~/logs/`. Most common cause is that your configured sample file isn't in the latest archive (e.g. you changed hosts and `/etc/hostname` is different). Update `BORG_RESTORE_TEST_SAMPLE_PATH` in the conf to a file you know is always there.

---

## Shell-only path (advanced)

If you're on a host without the web admin, or scripting unattended setup:

1. Copy the template: `cp scripts/borg-backup.conf.example scripts/borg-backup.conf`.
2. Edit `scripts/borg-backup.conf`: set `BORG_REPO`, `BORG_DB_DUMP_DIR`, `BORG_BACKUP_PATHS`, `BORG_CONTAINER_MOUNT_DIRS`, and (if offsite) `BORG_REMOTE_REPO`.
3. Store passphrases in Infisical at `/borgbackup`:
   - `BORG_PASSPHRASE` (required)
   - `BORG_REMOTE_PASSPHRASE` (required if offsite)
   - `BORG_HEALTHCHECK_URL`, `BORG_RESTORE_TEST_HEALTHCHECK_URL` (optional)
4. Run `scripts/setup-borg-backup.sh` — idempotent.
5. `scripts/borg-backup.sh` for the first backup; `borg list $BORG_REPO` to confirm.

When the web admin next writes to `user-config.yaml:borg` on this host, it will take over and regenerate `scripts/borg-backup.conf` — your manual edits to the conf get replaced. Either stay shell-only or switch to the web admin, not both.

---

## Recovery

Full disaster-recovery runbook: see [RECOVERY.md](RECOVERY.md).
