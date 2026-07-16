# Infisical CLI/Server Version Coupling — and how to upgrade the server

## STATUS: server upgrade COMPLETED 2026-07-16

neuromancer's server was upgraded **v0.132.2 → v0.162.7** and the CLI hold was
lifted (CLI now tracks current). Both proven against the live server: it serves
`/api/v3` (old CLIs) AND `/api/v4` (current CLIs), on-boot migrations ran clean,
and secret injection works end-to-end. The coupling risk below is now guarded,
not pinned — the `all-containers.sh` export-fail guard (commit 4dba111) catches
any future mismatch loudly instead of blanking secrets.

**Tag trap (cost real confusion):** the `-postgres` suffix was DROPPED upstream
between v0.140 and v0.150 — plain `vX.Y.Z` images ARE the Postgres build. The old
pin was `v0.132.2-postgres`; the current tag is `v0.162.7` (no suffix). Do not
append `-postgres` to modern tags — it 404s on Docker Hub.

**Confirmed compat:** PostgreSQL 14 and Redis 7 are supported upstream ("versions
14 and up"), so `postgres:14-alpine` / `redis:7-alpine` needed no change — the
upgrade was an app image-tag bump, not a DB migration.

The procedure below is retained as reference (for deepthought or a future major
bump). It has been reconciled with what was actually done: minimal-disruption
(recreate only the infisical project; the other ~117 containers were left running
and untouched), pg_dump as the primary rollback (the ZFS snapshot reverts the
whole shared dataset, so it is a last resort only).

## TL;DR

The Infisical **CLI** (apt, auto-updating third-party repo) and the Infisical
**server** (pinned image tag in compose) speak a versioned API to each other.
They are coupled, but only the server is pinned. An `apt upgrade` can therefore
move the CLI past what the server understands, at which point **every secret
silently becomes a blank string** and every container starts with empty
passwords.

- Server pinned at: `infisical/infisical:v0.132.2-postgres`
- **Last CLI that works with that server: `0.43.98`** (bisected against the live
  server, 2026-07-15)
- First broken CLI: `0.43.99` — switches to `/api/v4/secrets`, which v0.132.2
  does not route (404). There is **no fallback to v3**.
- neuromancer is pinned at `0.43.84` and `apt-mark hold`ed.

## What happened on 2026-07-15

`system-os-upgrades.sh` upgraded the CLI `0.43.84 -> 0.43.107` at 22:04. The box
rebooted at 22:06. Every `infisical export` then 404'd, and because the call
sites swallow errors (`2>/dev/null`, `|| true`), startup continued and brought up
50 containers with blank secrets — 81 `"variable is not set"` warnings, 5
containers crash-looping (actual_api, beszel-agent, kopia, cloudflared,
immich_server), 4 stuck in `Created`.

Nothing was lost: the databases all had existing datadirs, so blank passwords
caused auth failures rather than re-initialization.

Fixed by downgrading the CLI to `0.43.84` and holding it.

### Why it was silent

- The Tailscale preflight in `all-containers.sh` is **dead code on the boot
  path**: its guard requires the infisical container to already be running, but
  the block runs *before* the container loop, and infisical is `.start-order`
  `000` — it is started *by* that loop. On a cold boot it is never up yet.
- The `secrets get`/`export` call sites discard stderr and `|| true` the exit
  code, so a hard failure looked identical to "no secrets configured".

Both are addressed by the guard on the in-loop `/shared` export (see
`all-containers.sh`, the `INFISICAL_AVAILABLE` block). `/shared` is the canary:
it always exists. Exit code — not emptiness — is the signal:

| condition | exit | keys |
|---|---|---|
| pipeline broken (API mismatch) | 1 | 0 |
| path absent or empty (legitimate) | 0 | 0 |
| path has secrets | 0 | N |

## Other hosts

**deepthought** (`deepthought.hedgehog-avior.ts.net`, other user's box) has CLI
`0.43.76` — works, but **not held**. Its `unattended-upgrades` is enabled yet
`Allowed-Origins` covers only Ubuntu origins, so the third-party Infisical repo
is *not* auto-upgraded. The risk there is a human running `apt upgrade`
(candidate `0.43.106` — verified broken). Consider `apt-mark hold infisical`.

## Upgrading the server (the real fix)

Goal: get onto a current server so the CLI no longer needs holding. Latest at
time of writing: `v0.162.7` (~30 minors ahead — expect one-way schema
migrations).

### Before you start

1. **Verify Postgres compatibility.** Current DB is `postgres:14-alpine`
   (`infisical/compose.yaml`). Confirm the target Infisical supports PG14, or
   plan a PG upgrade *first*, as a separate change.
2. Read Infisical release notes between v0.132.2 and the target for breaking
   changes and required env vars.
3. Pick a **specific tag**, never `latest`.
4. Do it when the platform can be down. Infisical gates every container's start.

### Edit the MODULE, not the root render

`infisical/compose.yaml` at the platform root is **gitignored** — it is a render.
Edits there are lost on the next `module.sh update`. The authoritative file is:

    .modules/do-it-self-containers/infisical/compose.yaml   (line 10, image: tag)

Commit and push to
`https://forgejo.jamnapari-goblin.ts.net/Chris10/do-it-self-containers.git`.

### Procedure

    # 0. Pause the crons that would fire mid-upgrade and page or churn
    crontab -l > /tmp/ct-backup.txt
    # comment out: */15 system-health-check.sh   and   0 23 borg-backup.sh
    # (health-check calls all-containers.sh --restart-unhealthy; borg needs secrets)

    # 1. Snapshot (instant, atomic rollback — the DB lives on ZFS)
    sudo zfs snapshot tank-4tb/container-mounts@infisical-pre-upgrade
    zfs list -t snapshot | grep infisical

    # 2. Belt and braces: logical dump
    docker exec infisical-db pg_dump -U infisical infisical \
      > ~/infisical-pre-upgrade.sql
    ls -lh ~/infisical-pre-upgrade.sql   # sanity-check it is not empty

    # 3. Stop the stack
    ~/containers/scripts/all-containers.sh --stop

    # 4. Bump the tag in the MODULE, then sync it to the root render
    #    (edit .modules/do-it-self-containers/infisical/compose.yaml line 10)
    ~/containers/scripts/module.sh update

    # 5. Bring up ONLY infisical and watch the migrations
    ~/containers/scripts/all-containers.sh --start --container infisical
    docker logs -f infisical      # watch for migration errors

    # 6. Verify the pipeline BEFORE starting anything else.
    #    Prints key NAMES only — never echo secret values.
    bash -c '
      source ~/credentials/infisical.env
      ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
      OUT=$(infisical export $ARGS --path=/shared --format=dotenv-export 2>&1); echo "exit=$?"
      printf "%s" "$OUT" | grep -oE "^export [A-Za-z_0-9]+" | sed "s/export //"
    '
    # Expect exit=0 and the /shared keys (DOCKER_GID HOST_NAME TS_API_TOKEN
    # TS_AUTHKEY TS_DOMAIN ...). exit=1 -> STOP and roll back.

    # 7. Now unhold and upgrade the CLI to match the new server
    sudo apt-mark unhold infisical
    sudo apt-get update && sudo apt-get install -y infisical
    # Re-run the step 6 verification with the new CLI. If it fails, the CLI has
    # outrun the server again -- re-pin and reassess, do not proceed.

    # 8. Full cycle so every container gets real secrets
    #    (--start alone SKIPS already-healthy containers)
    ~/containers/scripts/all-containers.sh --stop --start

    # 9. Restore crons, run the missed backup by hand
    crontab /tmp/ct-backup.txt
    ~/containers/scripts/borg-backup.sh --remote-only && \
      ~/containers/scripts/borg-backup.sh --skip-remote

### Rollback

    ~/containers/scripts/all-containers.sh --stop
    sudo zfs rollback tank-4tb/container-mounts@infisical-pre-upgrade
    # revert the tag in .modules/do-it-self-containers/infisical/compose.yaml
    ~/containers/scripts/module.sh update
    sudo apt-get install -y --allow-downgrades infisical=0.43.84
    sudo apt-mark hold infisical
    ~/containers/scripts/all-containers.sh --start

Once verified and soaked, drop the snapshot:

    sudo zfs destroy tank-4tb/container-mounts@infisical-pre-upgrade

## Gotchas

- **Never print secret values** when debugging. Check exit codes and key *names*
  or counts. `infisical export ... | head` dumps live credentials to the
  terminal and the scrollback.
- `.env` files are **not** the secret store. `generate-env.js` writes only
  non-secret config (volume paths, `HOMEPAGE_GROUP`, `TS_STATE_HOST_DIR`).
  Secrets come from Infisical at container-start time only. A populated `.env`
  says nothing about whether secrets work.
- **Do not edit `all-containers.sh` while it is running.** Bash reads scripts
  incrementally by byte offset; editing in place can send the running shell to a
  garbage offset.
- Binary string analysis is **useless** for detecting the v4 switch — both
  working and broken CLIs contain `api/v4` strings; the version is chosen at
  runtime. Test against the live server instead.
- After a downgrade the CLI nags on stderr about a newer release. Harmless
  (call sites discard stderr); `INFISICAL_DISABLE_UPDATE_CHECK` silences it.
- `apt-mark hold` is **host-local state**, not in the repo. A fresh `setup.sh`
  installs the current CLI and would hit this wall — the in-loop guard is what
  protects that case, by failing loudly instead of silently.
