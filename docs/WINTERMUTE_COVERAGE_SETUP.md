# Wintermute Coverage Audit Setup

This doc covers running the same backup-coverage audit on wintermute
(CachyOS desktop, borgmatic-based) and pushing the report to
neuromancer so it shows up in the web admin's host tabs.

The architecture: wintermute runs the audit locally, then `rsync`s the
resulting JSON over SSH to `neuromancer:~/logs/coverage-reports/`.

## Prerequisites on wintermute

```
sudo pacman -S python python-yaml rsync openssh
```

`python-yaml` is needed by `scripts/borgmatic-config-adapter.sh` to
parse `~/.config/borgmatic/config.yaml`.

## 1. Clone the repo on wintermute

```
git clone <forgejo-or-github-url>/containers ~/containers
```

(Wintermute only uses the audit scripts, not the docker compose stack.
The rest of the repo is harmless clutter.)

## 2. Generate an SSH key for the report push

On **wintermute**:

```
ssh-keygen -t ed25519 -f ~/.ssh/coverage-push -N "" \
    -C "coverage-push from wintermute"
cat ~/.ssh/coverage-push.pub
```

## 3. Authorize the key on neuromancer

On **neuromancer**, append the public key to `~/.ssh/authorized_keys`
with a `from=` restriction so only wintermute (over Tailscale) can use
it. Find wintermute's Tailscale IP first:

```
tailscale status | awk '/wintermute/ {print $1; exit}'
```

Then add the line (substitute the IP and the public key text):

```
from="100.x.y.z" ssh-ed25519 AAAA...wintermute coverage-push
```

That gives wintermute SSH-key access to chrisl8 on neuromancer; the
`from=` restricts to wintermute's Tailscale identity. Test from
**wintermute**:

```
ssh -i ~/.ssh/coverage-push chrisl8@neuromancer \
    ls /home/chrisl8/logs/coverage-reports/
```

Should list `neuromancer.json` (and `wintermute.json` once the first
push lands).

## 4. Create wintermute's audit conf

On **wintermute**:

```
cp ~/containers/scripts/backup-coverage-audit.conf.example \
   ~/containers/scripts/backup-coverage-audit.conf
```

Edit `~/containers/scripts/backup-coverage-audit.conf`:

- Set `BORG_CONFIG_SOURCE` to the borgmatic adapter:
  ```
  BORG_CONFIG_SOURCE="$HOME/containers/scripts/borgmatic-config-adapter.sh"
  ```
- Adjust `CANDIDATE_ROOTS` to match wintermute's filesystem layout
  (probably `/home|1`, `/etc|0`, and any extra mounts you keep data on).
- Uncomment + set the push variables to ship the report to neuromancer:
  ```
  COVERAGE_REPORT_PUSH_DEST="chrisl8@neuromancer:/home/chrisl8/logs/coverage-reports/$(hostname).json"
  COVERAGE_REPORT_PUSH_KEY="$HOME/.ssh/coverage-push"
  ```

## 5. First-run test

```
bash ~/containers/scripts/backup-coverage-audit.sh
```

Expected: a local report at `~/logs/coverage-reports/wintermute.json`,
followed by `[OK] Report pushed`. Reload the web admin's Backup
Coverage page and the `wintermute` tab should appear (and replace the
synthetic test report neuromancer's been showing).

## 6. Schedule it

Add to wintermute's user crontab (`crontab -e`):

```
# Backup coverage audit + push to neuromancer
17 * * * * /home/chrisl8/containers/scripts/backup-coverage-audit.sh >> /home/chrisl8/logs/coverage-audit.log 2>&1
```

`:17` past the hour matches neuromancer's schedule (different minute
just to avoid pile-up on the same wallclock tick — they're independent
processes either way).

## Ack-write behavior

Acknowledgements work only for the host the web admin runs on
(neuromancer). For wintermute entries, the Ack/Un-ack buttons are
hidden — the audit is read-only from the web admin. If you need to
ack something on wintermute, edit
`~/containers/scripts/backup-coverage-acks.json` on wintermute
directly (same JSON shape as on neuromancer); the next audit run will
honor it and the new state will surface in the web admin after the
next push.

## Troubleshooting

- **`[borgmatic-adapter] PyYAML not installed`** — install `python-yaml`
  via pacman.
- **`[ERROR] BORG_CONFIG_SOURCE not readable`** — verify the path in
  the `.conf` resolves; the audit prints what it tried to source.
- **`Report push failed`** — try the rsync manually with verbose:
  ```
  rsync -avz -e "ssh -i ~/.ssh/coverage-push -v" \
      ~/logs/coverage-reports/wintermute.json \
      chrisl8@neuromancer:/home/chrisl8/logs/coverage-reports/wintermute.json
  ```
  SSH `-v` shows whether the key is being offered and accepted.
- **Web admin shows wintermute as "stale"** — the report is timestamped
  in the JSON; if the timestamp is old, wintermute's cron didn't fire
  or the push failed. Check `~/logs/coverage-audit.log` on wintermute.
