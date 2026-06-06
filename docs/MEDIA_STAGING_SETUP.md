# Media Staging Setup

The **Media Staging** page in the web admin lets the operator of a *client*
host (e.g. **deepthought**) browse the *source* Jellyfin library (on
**neuromancer**) and copy selected movies and shows to the client's own local
Jellyfin, so they play from local disk instead of streaming over the WAN.
Useful when the source's upload link would force transcoding, for off-peak
pre-staging, and for rewatches.

## Topology (important — this drives the whole design)

The connection is **one-way**: the client (deepthought) **cannot** reach the
source host (neuromancer), but neuromancer **can** reach deepthought over
Tailscale, and deepthought **can** reach your Jellyfin (its sidecar is shared).
So:

- **Browsing** is done by deepthought, directly against neuromancer's Jellyfin
  REST API (the shared sidecar) — read-only.
- **Transfers are PUSHED by neuromancer.** deepthought writes a small job file
  into a local spool; neuromancer polls that spool over SSH, runs the `rsync`
  push into deepthought's Jellyfin mount, and writes status back into the
  spool for deepthought's UI to display.

This keeps neuromancer **off Melissa's tailnet** — no new node sharing — and
reuses the access you already have (neuromancer → deepthought), exactly like
the backup-coverage push (manager reaches client; client never reaches back).

Two config blocks, one per host, each activating only where it's present:
- deepthought: `mediaStaging:` (the **receiver** / UI).
- neuromancer: `mediaStagingPush:` (the **sender** / transfer engine).

## Order of operations

The config blocks are **hand-edited** in `~/containers/user-config.yaml` on
each host (there is no UI to create them — same as the `backuppi:` block). The
order matters: the API-key dialog only appears, and only knows where to write,
**after** deepthought's config block exists. So:

0. Get this code onto deepthought (`git pull` + the platform update, which
   rebuilds the web admin).
1. SSH key (neuromancer → deepthought).
2. Create the two Jellyfin API keys (dashboards only — copy the strings).
3. Hand-edit deepthought's `user-config.yaml` (`mediaStaging:` block).
4. In deepthought's web admin, paste the keys via the **Jellyfin API keys**
   dialog (works now that the block exists).
5. Hand-edit neuromancer's `user-config.yaml` (`mediaStagingPush:` block).
6. Verify.

## 1. SSH key: neuromancer → deepthought

On **neuromancer**:

```
ssh-keygen -t ed25519 -f ~/.ssh/media-staging-push -N "" \
    -C "media-staging push to deepthought"
cat ~/.ssh/media-staging-push.pub
```

On **deepthought**, authorize it in `~/.ssh/authorized_keys`, restricted to
neuromancer's Tailscale IP (find it on neuromancer with
`tailscale ip -4`):

```
from="100.x.y.z",no-pty,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...neuromancer media-staging-push
```

This is the same trust shape as the existing `coverage-push` key, just in the
neuromancer → deepthought direction. It writes into deepthought (the client
box), never into neuromancer.

Test from **neuromancer**:

```
ssh -i ~/.ssh/media-staging-push <deepthought-user>@deepthought.<her-tailnet>.ts.net 'echo ok && hostname'
```

> **Optional hardening.** If you'd rather not give this key a general shell,
> wrap it in a forced-command script (`command="…/media-staging-rpc.sh"`) that
> only permits the spool verbs (`ls`/`cat`/`mkdir`/status-write) plus
> `rsync --server`, modeled on `scripts/` + the backup-pi `pi-rpc.sh`
> whitelist. Not required for a first install.

## 2. Create the Jellyfin API keys

Only the **receiver** (deepthought) talks to Jellyfin — neuromancer just runs
rsync, so it needs no Jellyfin key. Create them now and keep the strings handy;
you'll paste them through the web admin in step 4 (after the config block
exists). Don't try to store them yet.

1. **Source key** — in **neuromancer's** Jellyfin: Dashboard → API Keys → **+**
   → `media-staging`. deepthought uses it to list the library via the shared
   sidecar URL.
2. **Local key** (optional) — in **deepthought's** Jellyfin, same steps. Used
   only to kick a library scan after a copy so new files appear automatically.
   If absent, scanning is skipped and you can refresh manually in Jellyfin.

## 3. Receiver config — hand-edit deepthought's `~/containers/user-config.yaml`

Edit the file by hand and add the block below. No web-admin restart is needed —
config is re-read on each request and poll; just reload the Media Staging page
afterward and the tab will appear.

A Jellyfin library is often built from **several folders** (multiple mount
points). List each one under `folders:` — items from any of them stage into the
single `dest_root`. Find a library's container folders with:

```
docker exec jellyfin sh -c 'find /config -name "*.mblink" | while read f; do echo "$(basename "$(dirname "$f")") -> $(cat "$f")"; done'
```

```yaml
mediaStaging:
  enabled: true
  jellyfin_base_url: https://jellyfin.<your-tailnet>.ts.net   # shared sidecar, reachable from deepthought
  jellyfin_api_key_infisical_path: /mediaStaging
  jellyfin_api_key_infisical_key: NEUROMANCER_JELLYFIN_API_KEY
  spool_dir: ~/media-staging                 # job + status files (neuromancer reads this over SSH)
  libraries:
    - name: Movies                           # MUST match the Jellyfin library name
      collection_type: movies                # "movies" or "tvshows"
      dest_root: ~/container-data/container-mounts/jellyfin/movies   # everything in this library lands here
      folders:                               # one entry per container folder the library spans
        - key: recon                         # arbitrary label; MUST match the sender's key
          jellyfin_path_prefix: /media/recon/movies   # container path Jellyfin reports
        - key: downloads
          jellyfin_path_prefix: /media/downloads/movies
    - name: Shows
      collection_type: tvshows
      dest_root: ~/container-data/container-mounts/jellyfin/series
      folders:
        - key: recon
          jellyfin_path_prefix: /media/recon/series
        - key: downloads
          jellyfin_path_prefix: /media/downloads/shows
  local_jellyfin_base_url: http://localhost:8096
  local_jellyfin_api_key_infisical_key: DEEPTHOUGHT_JELLYFIN_API_KEY
  free_space_path: ~/container-data/container-mounts/jellyfin
  poll_interval_seconds: 5
```

A single-folder library can instead use the short form — put
`jellyfin_path_prefix` directly on the library and omit `folders:` (it's
treated as one folder with key `default`).

> **Prerequisite — dest must be writable by the push user.** Docker creates
> bind-mount directories as `root:root` on first `up`, so the `dest_root` paths
> are typically root-owned and the push (which runs as `ssh_user`) can't write
> to them — you'll see `rsync exited 23`. Fix on deepthought:
> `sudo chown -R <ssh_user>:<ssh_user> <dest_root> …`. Jellyfin runs as root, so
> it still reads them fine. (Safe as long as deepthought doesn't run its own
> radarr/sonarr writing to those same dirs.)

## 4. Store the API keys via the web admin

Infisical here is reached through the web admin's machine-identity token
(`~/credentials/infisical.env`), **not** an interactive `infisical login` — so
there's no CLI to run. Now that the config block from step 3 exists, reload
deepthought's web admin → **Media Staging** tab → **Jellyfin API keys** button,
and paste the source key (and optionally the local key) from step 2. The web
admin writes them to Infisical at `/mediaStaging` under
`NEUROMANCER_JELLYFIN_API_KEY` / `DEEPTHOUGHT_JELLYFIN_API_KEY` — the same
mechanism Backup Pi uses for its passphrase.

(This is why the keys live in their own `/mediaStaging` folder and not
`/shared`: `/shared` is exported into every container's environment, which
would leak the keys everywhere. And it's why this step comes *after* step 3 —
the dialog reads the path and key names from the config block.)

## 5. Sender config — hand-edit neuromancer's `~/containers/user-config.yaml`

Each folder's `key` must match the receiver's, and its `source_root` is the
**host** side of the bind mount backing that container prefix — read them out
of `jellyfin/compose.yaml` (e.g. `/media/recon` ← `…/recon/data/media`,
`/media/downloads` ← `…/container-mounts/jellyfin`).

```yaml
mediaStagingPush:
  enabled: true
  poll_interval_seconds: 10
  clients:
    - name: deepthought
      host: deepthought.<her-tailnet>.ts.net      # reachable from neuromancer
      ssh_user: <deepthought-user>
      ssh_key_path: ~/.ssh/media-staging-push
      spool_dir: /home/<deepthought-user>/media-staging   # MUST match deepthought's spool_dir (absolute)
      libraries:
        - name: Movies                              # MUST match the receiver's library name
          folders:
            - key: recon                            # MUST match the receiver's folder key
              source_root: /mnt/22TB/container-mounts/recon/data/media/movies
            - key: downloads
              source_root: <host path mounted at /media/downloads>/movies
        - name: Shows
          folders:
            - key: recon
              source_root: /mnt/22TB/container-mounts/recon/data/media/series
            - key: downloads
              source_root: <host path mounted at /media/downloads>/shows
```

(Short form still works for a single-folder library: `source_root` directly on
the library, no `folders:`.)

### How the path mapping lines up

Jellyfin reports each item's path as the path **inside the Jellyfin
container** (e.g. `/media/recon/movies/Inception (2010)/...`). The receiver
finds which of the library's `folders` the item lives under, strips that
folder's `jellyfin_path_prefix` to a library-relative path
(`Inception (2010)/...`), and ships the relative path **plus the folder `key`**
in the job. The sender looks up the `source_root` for that `key`, reads the
file, and pushes it under the receiver's `dest_root`, recreating the same
layout (via an `rsync --relative` pivot) so deepthought's Jellyfin recognizes
it. Two join keys must line up across the configs: the library `name`, and each
folder `key`. An item that matches none of the configured folders shows as
**unmappable** (greyed out) in the UI rather than failing silently.

## 6. Verify

1. **SSH + push path, dry run** from **neuromancer** (no files written),
   confirming the key and a real source path resolve:

   ```
   rsync -an --relative --info=progress2 -e "ssh -i ~/.ssh/media-staging-push" \
       "/home/chrisl8/container-data/container-mounts/jellyfin/movies/./<a known movie dir>" \
       <deepthought-user>@deepthought.<her-tailnet>.ts.net:"/home/<deepthought-user>/container-data/container-mounts/jellyfin/movies/"
   ```

2. On **deepthought**, open the web admin → **Media Staging** tab. You should
   see the disk-usage bar and a Movies / Shows browser. Stage one small movie;
   within a few seconds the **source-side poller** picks the job up and the
   copy queue advances to 100%. Confirm files land under
   `…/jellyfin/movies/<Title (Year)>/` on deepthought and the title appears in
   deepthought's Jellyfin after the auto-refresh.

3. Expand a series → season → episode and stage a single **episode**; confirm
   only that `Show/Season NN/episode.mkv` is pushed, not the whole series.

4. Delete the staged title from **Staged on this server** and confirm the
   files (and the Jellyfin entry, after refresh) are gone.

### Troubleshooting

- **Nothing happens after "Copy".** Check the job landed in the spool on
  deepthought: `ls ~/media-staging/pending`. Then check neuromancer's
  web-admin log for `[mediaStagingPush]` lines — it polls every
  `poll_interval_seconds`.
- **`failed` in the queue.** The `error` shown is the rsync exit reason. Re-run
  the dry-run above (step 6.1); a path mismatch (wrong `source_root` /
  `jellyfin_path_prefix`) is the usual cause.
- **Out of space.** The source side won't pre-flight disk; deepthought's UI
  shows free space and warns when a selection exceeds it. `--partial` leaves a
  resumable remnant if a transfer is interrupted; re-staging the same title
  resumes it.
- **SSH check** from neuromancer:
  `ssh -v -i ~/.ssh/media-staging-push <deepthought-user>@deepthought.<her-tailnet>.ts.net true`
