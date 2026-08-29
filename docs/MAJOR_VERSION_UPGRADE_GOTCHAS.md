# Major-version datastore upgrade gotchas

Reference notes from the 2026-08-29 pass upgrading several pinned images
past DIUN's blind spot (it only tracks digest changes on the tag already in
compose.yaml, never a newer major tag). Full context and per-stack status:
see the web-admin version-drift badge (`web-admin/backend/src/versionDrift.js`)
and the session's working plan at the time,
`~/.claude/plans/enumerated-enchanting-moonbeam.md` (ephemeral — this doc is
the durable version). Applies to any future bump of a datastore image
(Postgres, MariaDB, MongoDB, Redis/Valkey) in this repo, and to anyone else
running the `do-it-self-containers` module who hits the same wall.

## Policy: datastore bumps go in `compose.override.yaml`, not the module

If the container is sourced from a shared module (check
`container-registry.yaml` / `.modules/<module>/<container>/`), a
datastore/engine image bump (anything backed by a persistent volume whose
on-disk format is tied to that image's major version) must **not** go into
the module's shared `compose.yaml`. `module.sh update` is a blind `git pull`
+ file copy with no changelog or migration-gating mechanism — anyone else
who pulls the update and restarts would have their datastore refuse to
start against old-format data with zero warning. Put it in a per-container
`compose.override.yaml` at the platform root instead. An app-level version
bump (the application binary itself, when it isn't also changing its own
infra pins) is generally safe to land in the shared module, since the app
migrates its own schema on startup.

## `compose.override.yaml` merges list-valued keys — it does not replace them

A plain `volumes:` (or `ports:`, etc.) override **appends to** the base
file's list by default; it does not replace it. If you're changing a
volume mount (not just an image tag), the base file's original mount rides
along unnoticed, mounted alongside your new one. This bit us on
infisical-db: overriding to a new Postgres 18 data directory left the old
pg14 directory *also* bind-mounted at the same target the base file used,
which Postgres 18's entrypoint correctly detected and refused to start
against (see below).

**Fix:** use the Compose Spec `!override` YAML tag to force full
replacement instead of merge:

```yaml
services:
  db:
    image: docker.io/library/postgres:18-alpine
    volumes: !override
      - /path/to/new-data-dir:/var/lib/postgresql
```

Verify with `docker compose config` (or `docker inspect <container> --format
'{{json .Mounts}}'` after starting) that only the intended mount is present.

## Postgres 18's official image changed its expected mount point

Every prior major expected the volume at `/var/lib/postgresql/data`.
Postgres 18+ wants it at `/var/lib/postgresql` instead — it manages its own
`<major>/docker` subdirectory inside, to support `pg_ctlcluster`-style
upgrades. Mounting at the old path makes the image refuse to start with a
clear, non-destructive error ("Counter to that, there appears to be
PostgreSQL data in: ... (unused mount/volume)"). Not corruption — just
won't start until you fix the mount target.

## Redis 7.4+ writes an RDB format Valkey can't read

Valkey forked from Redis at 7.2.4. A `redis:7`-family tag can resolve to a
later 7.x point release (confirmed: `redis:7`, `redis:7-alpine`, and
`redis:7.4-alpine` all resolved to **7.4.11** across this fleet on
2026-08-29) that writes RDB persistence files in **format version 12** —
which Valkey (any version, including 9.x) refuses to load: crash-loops with
`Can't handle RDB format version 12`. This is a real, confirmed break, not
a theoretical one — it took down paperless-broker on the first attempt.

**Before swapping any `redis:7.x` sidecar to Valkey:** inspect the actual
key space first (`redis-cli KEYS '*'`, check TYPE/TTL/ZCARD/LLEN on
anything that looks like a job queue) to confirm what's actually at risk —
in every case checked in this fleet (paperless-broker, infisical-redis,
dawarich_redis) the data was disposable (task-result caches, job-queue
metadata with essentially empty queues) and safe to lose, but that must be
verified per-instance, not assumed. Then delete the stale `dump.rdb`
**before** starting the Valkey image (a throwaway container bind-mounting
the volume works even without host root access — see below), and check
after restart whether the app/framework in front of it self-heals (e.g.
BullMQ/Sidekiq generally re-register their own repeatable/cron schedules on
boot; confirmed working for Infisical's ~40 BullMQ queues and dawarich's
Sidekiq).

**Valkey→Valkey major bumps (e.g. 8→9) do not have this problem** — verify
empirically before trusting that, though (see below), don't just assume.

## Verify RDB forward-compatibility empirically, don't assume it

Before touching a production instance, spin up a real test: write data with
the OLD version into a scratch Docker volume, then try loading it with the
NEW version, and check for actual key/value survival — not just "container
started."

```bash
docker volume create test-rdb
docker run --rm -v test-rdb:/data <old-image> sh -c "
  <server-binary> --daemonize no --dir /data --save '' &
  sleep 1
  <cli> set testkey hello
  <cli> save
  <cli> shutdown nosave
"
docker run --rm -v test-rdb:/data <new-image> sh -c "
  <server-binary> --daemonize no --dir /data &
  sleep 2
  <cli> get testkey
  <cli> shutdown nosave
"
docker volume rm test-rdb
```

This caught the Valkey 8→9 case as genuinely safe (confirmed: newer Valkey
reads older Valkey's RDB cleanly) *before* it was applied to searxng, in
contrast to the redis→valkey case above which was wrongly assumed safe and
broke on the first real attempt.

## MongoDB: in-place binary upgrade, but two things assumed from the docs turned out wrong

Unlike Postgres/MariaDB, a Mongo major upgrade is a straight binary swap
against the same data directory (WiredTiger format is compatible across one
major hop) — no dump/restore needed. But:

1. **Don't assume you get a manual "verify before committing" window.**
   MongoDB's official docs describe starting the new binary against the old
   `featureCompatibilityVersion` (FCV), verifying, and *then* manually
   running `setFeatureCompatibilityVersion`. In this fleet, the your_spotify
   app itself issued that command against its own database within ~6
   seconds of the new mongod starting — confirmed via mongod's own log (an
   explicit `setFeatureCompatibilityVersion` command arriving from a client
   connection, not anything done manually here). Any app with its own
   startup/migration logic may do this on its own. Verify data integrity
   *before* restarting into the new binary, not after — you may not get a
   safe window to bail out post-restart.
2. **A bare floating major tag can refuse to start against the
   immediately-preceding major's FCV.** `mongo:8` resolved to 8.2.12,
   which only accepts FCV 8.0/8.1/8.2 already set — it fatally refused FCV
   7.0 (`Wrong mongod version`, exit code 62, before touching any data —
   safe, not destructive, just won't start). MongoDB only guarantees the
   actual FCV-boundary crossing through a new major's **first minor**
   release (e.g. `mongo:8.0` specifically); a later minor in that series
   tightens the accepted floor. A vendor's reference compose pinning a bare
   `mongo:8` only works for a brand-new deployment with no existing data.
   **For any in-place Mongo major upgrade, stage through `<newmajor>.0`
   first, verify, then move to the floating `<newmajor>` tag afterward** —
   confirmed working: 6 → 7 → 8.0 → 8 (floating, landed on 8.2.12), with
   full collection counts verified matching a pre-upgrade `mongodump` at
   every stage.

Always take a `mongodump` before starting, even though it's an in-place
upgrade — it's cheap insurance and the one point-of-no-return in the whole
procedure is the FCV raise, which (per above) may happen automatically and
immediately.

## `all-containers.sh` gotchas when manually controlling migration ordering

A DB migration that needs "start just the database, restore into it, then
start everything else" (to avoid the app racing ahead and initializing its
own empty schema against a fresh cluster) requires stepping outside
`all-containers.sh`'s normal per-container flow for the intermediate steps.
Two things bit us doing that:

1. **A bare `docker compose up` does not have the real secrets.**
   `all-containers.sh` exports secrets into the shell before calling
   `docker compose` (`infisical export --path=/shared` and
   `--path=/<container>`, then `eval`s the dotenv-export output) — a
   `docker compose up` run directly in a fresh shell sees blank env vars
   for anything sourced from Infisical (visible as "variable is not set,
   defaulting to blank string" warnings). Initializing a fresh Postgres/etc.
   cluster with a blank password instead of the real one breaks the app's
   later connection. Replicate the sourcing inline before any direct
   `docker compose` call:
   ```bash
   source ~/credentials/infisical.env
   ARGS="--token=${INFISICAL_TOKEN} --projectId=${INFISICAL_PROJECT_ID} --env=prod --domain=${INFISICAL_API_URL}"
   eval "$(infisical export ${ARGS} --path="/shared" --format=dotenv-export 2>/dev/null)"
   eval "$(infisical export ${ARGS} --path="/<container>" --format=dotenv-export 2>/dev/null)"
   docker compose up -d ...
   ```
2. **After manually starting one service directly, `all-containers.sh
   --start --container <name>` won't bring up the rest of the stack.** It
   sees the one already-healthy container and treats the whole stack as
   already up (the same "`--start` skips already-healthy containers"
   behavior documented elsewhere, just triggered by a partially-up stack
   rather than a stale compose.yaml edit). Finish the bring-up with a
   direct, properly secret-sourced `docker compose up -d` instead of
   falling back to `all-containers.sh` for the remaining services.

## Working around no host root access (no sudo in this environment)

Several data directories are owned by a container-internal UID (e.g. 70 for
postgres, 999 for redis/valkey) that a non-root host user can't read, write,
or `rm`. A throwaway container bind-mounting the same path works without
sudo, since containers run as root by default:

```bash
docker run --rm -v /path/on/host:/target alpine sh -c "rm -rf /target/*; ls -la /target"
```

Used repeatedly this pass: deleting a stale `dump.rdb`, cleaning up a
partially-initialized Postgres 18 data directory after a failed mount-point
attempt, etc.

## For a live user-facing app, pause writes and verify past the SQL layer

Nextcloud's mariadb 10→12 migration was the first of these touching a
service real people actively read/write to (files, contacts, calendar), so
it got two extra precautions worth applying to any similar app, not just
that one:

- **Pause writes for the dump, don't rely on `--single-transaction` alone.**
  `occ maintenance:mode --on` before the `mysqldump`/`pg_dump`, kept on
  through the entire migration, only switched off after full verification.
  Belt-and-braces on top of a transactionally-consistent dump — costs
  nothing (a maintenance-mode window is brief) and removes any question
  about a write landing mid-dump. Most self-hosted apps have an equivalent
  (check for a `occ`/`manage.py`/admin-CLI maintenance or read-only mode).
- **Verify past "the SQL ran without error."** Table/row counts matching
  is necessary but not sufficient — the strongest signal came from asking
  the *application* to independently confirm the data, not just querying
  the database directly: `occ status` reporting `needsDbUpgrade: false`
  (the app recognizes the restored schema as current) and, especially,
  `occ files:scan` against a real user's actual files on disk coming back
  with 0 errors — this cross-checks the restored database's filecache
  metadata against ground truth on the filesystem, which a plain row count
  can't do. Look for an equivalent per-app "reconcile DB against reality"
  command before considering any such migration done.

## `docker compose up -d` can take several minutes on first run after a big change

Bringing a stack back up right after a datastore image swap (new image to
pull, healthchecks with long `start_period`s to clear) has repeatedly taken
long enough to exceed a typical interactive shell/tool timeout (confirmed
on infisical, paperless, and nextcloud) — not a hang, just slow. Don't
assume a timed-out foreground command failed; check `docker ps` for actual
container state, or let it finish in the background and check the exit
code once it does.

## A service with `user: UID:GID` set can't initialize its own fresh mount

If a compose service pins a non-root `user:` explicitly, it never runs as
root at all — unlike the default (root-then-drop-to-an-internal-uid, which
every stock Postgres/MariaDB/Mongo image does on its own). Point such a
service at a brand-new bind-mount directory and it fails outright: Docker
auto-creates the missing host directory as `root:root`, and the
already-non-root container can't `chown`/`mkdir` inside it. Symptom is
blunter than the Postgres 18 mount-point error above — just a plain
`mkdir: can't create directory: Permission denied` loop. Fix: pre-create
and `chown` the new directory to match the service's `user:` *before*
starting it (the same throwaway-container trick below works for this too).

## `ALTER EXTENSION postgis UPDATE` is only needed for an in-place upgrade

If you're doing the dump/restore-to-fresh-cluster pattern below (as
opposed to swapping the binary in place against existing data), don't add
a manual `ALTER EXTENSION postgis UPDATE` step — there's nothing to
update. `pg_dump` only emits a `CREATE EXTENSION postgis` statement, not
the extension's internal version state, so restoring it onto a brand-new
cluster just installs whatever PostGIS version ships in the new image
directly. Confirmed: restoring onto `postgis/postgis:18-3.6-alpine`
produced `postgis` at 3.6.4 immediately, no update command needed.

## Large databases (10M+ rows): use a compressed custom-format dump, expect index rebuild time to dominate

For anything much bigger than a few hundred MB, prefer `pg_dump -Fc`
(custom format, built-in compression) over plain SQL, and restore with
`pg_restore -j <n>` (parallel jobs) rather than piping plain SQL through
`psql`. Confirmed on a 22GB-logical / 10.9M-row database: the dump itself
was fast (~3 min, compressed to 617MB), but the restore took over 30
minutes — almost entirely rebuilding indexes (particularly a GIST spatial
index) on the largest table, not loading the row data itself. Don't be
alarmed by a restore that runs far longer than the dump did, or by
`pg_database_size()` appearing to plateau partway through — that's index
build time, not a stall; watch `pg_stat_activity` for actual running
`CREATE INDEX` statements to confirm forward progress instead of just
watching database size.

## Dump/restore-to-new-directory pattern (Postgres/MariaDB-style engines)

For Postgres and (expected, not yet verified — see nextcloud-db) MariaDB,
prefer dump/restore into a **brand-new data directory** over an in-place
`pg_upgrade` or reusing the old volume path:

1. Take a fresh dump **after** any pending app-level migration has already
   run against the old engine version (an earlier dump taken before an app
   bump will have a stale schema — confirmed real: infisical's app bump
   happened first, and reusing the pre-app-bump dump would have restored
   the wrong schema version).
2. Point the new engine version at a completely new, empty directory —
   never the original. This makes rollback trivial (revert the override)
   and means a failed attempt (e.g. the Postgres 18 mount-point issue above)
   can be cleaned up and retried without any risk to the original data.
3. Restore, then verify table count and a real row count *and* (where
   possible) a count from the application's own ORM/query layer — not just
   "the SQL ran without error." Confirmed this pattern catches real issues:
   the app reporting "no migrations to apply" after restore is strong
   independent confirmation the restored schema is exactly what's expected.
