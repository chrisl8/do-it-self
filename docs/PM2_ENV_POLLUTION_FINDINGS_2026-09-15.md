# PM2 Daemon Env Pollution — investigation notes, 2026-09-15

## STATUS: RESOLVED 2026-09-16

## Summary

While restarting the "Container Web Admin" PM2 process to refresh a stale
version-drift cache (after bumping infisical to v0.165.10), `pm2 jlist` was run
to check the process's uptime. It dumped the full environment of every
PM2-managed process, which contained live secrets in plaintext:
`INFISICAL_TOKEN`, `TS_AUTHKEY`, and `TS_API_TOKEN` were present in the
"Container Web Admin" process's stored env. That output was captured into a
Claude Code session tool-results file. **The user has already deleted that
file.**

## What this confirmed

This was a recurrence of the class of issue described in the
`project_webadmin_env_leak_infisical_upgrade` memory / the commit history
around 2026-07-26 (`eb5b274`, `b734020`, `055ae08`), where the PM2 "God Daemon"
freezes secrets from whatever shell environment was live at the moment
`pm2 start` or `pm2 restart --update-env` last ran, and hands that same frozen
env to every app it manages for the rest of its life — regardless of what the
project's own `.env` files say.

## Root cause found 2026-09-16

`scripts/start-web-admin.sh`'s `rebuild()` function ran
`pm2 restart "$PM2_NAME" --update-env` with whatever env the calling shell
happened to have. `rebuild` is invoked by `scripts/update-platform.js`
(`maybeRebuildWebAdmin`) via a detached `bash -c "... rebuild ... &"` with no
env override. When `update-platform.js`/`.sh` is triggered through the web
admin's own API it goes through `spawnTracked()`, which already used the
`childEnv()` allowlist — clean. But run manually from an interactive or cron
shell — e.g. one that had sourced `setup-infisical.sh`, `all-containers.sh`,
or `borg-backup.sh` (which legitimately export `INFISICAL_TOKEN`/
`TS_AUTHKEY`/`TS_API_TOKEN` for their own use) — that shell's full env rode
along and got permanently frozen into the web-admin's PM2-stored env via
`--update-env`. This is a *different* exposure path than the one fixed
2026-07-26 (which patched docker-compose child-spawn sites in `server.js`),
which is why it recurred with a different secret set.

## Fixes applied 2026-09-16

1. **`scripts/start-web-admin.sh`**: `rebuild()` now runs the `--update-env`
   restart through `env -i` with an explicit allowlist (mirrors
   `CHILD_ENV_ALLOWLIST`) plus whatever's in `web-admin/backend/.env`, so
   nothing else present in the calling shell can ride along and get frozen in.
2. Extracted the existing `childEnv()`/`CHILD_ENV_ALLOWLIST` helper out of
   `server.js` into a shared `web-admin/backend/src/childEnv.js` module and
   applied it to every remaining full-`process.env`-passthrough spawn site
   found during the investigation: `gitRepoStatus.js` (git commands),
   `backupPi.js` (three ssh spawn sites), `mediaStagingPush.js` (ssh + rsync),
   `mediaStaging.js` (df), and the Tailscale preflight spawn in `server.js`
   (which also had a local variable named `childEnv` shadowing the shared
   helper — renamed to `preflightEnv`).

## Underlying design issue (not fully fixable in code)

`pm2 restart --update-env` does not appear to fully *replace* an app's stored
env — it merges the newly-provided env on top of whatever was already stored,
without clearing stale keys. Confirmed empirically 2026-09-16: after the
`rebuild()` fix above ran cleanly, the web admin's stored env still carried
leftover cruft (`TMUX_PANE`, `SSH_CLIENT`, `CLAUDE_CODE_*`, `FNM_*`,
`STARSHIP_*`) from some earlier dirty `--update-env` invocation — the fix
stopped *new* pollution but couldn't retroactively scrub what was already
merged in. Separately, the PM2 God Daemon **process itself** (not just the
apps it manages) had `INFISICAL_TOKEN`/`TS_API_TOKEN`/`TS_AUTHKEY` baked into
its own environ (`/proc/<pid>/environ`) — a live exposure, since a running
process's environment is immutable once it's started. There is no way to
"clean" a running process's env short of killing and respawning it.

This means:
- The `rebuild()` fix closes the one *automated* path that caused this
  recurrence, but cannot protect against a human (or an agent session with
  shell access) manually running `pm2 restart <app> --update-env` or
  `pm2 start` from a dirty shell — that remains an operator-discipline
  problem PM2's design doesn't structurally prevent.
- Other PM2 apps on this box (Kryten, the Meshtastic/Minecraft/Starbound
  watchers) live outside this repo, in `~/Kryten`, `~/docker-log-watchers`,
  and `~/meshtastic`, and have **no** env-hardening at all on their spawn
  paths — not actionable from this repo, just worth knowing.
- The only real remediation once a daemon/app env is already polluted is a
  full `pm2 kill` + respawn of every app from a deliberately clean shell —
  same shape as the 2026-07-26 fix.

## Remediation performed 2026-09-16

Ran a one-time clean restart of the entire PM2 stack (God Daemon + all 8
managed apps + the pm2-logrotate module) using an explicit minimal env
(`HOME`/`PATH`/`USER`/`LOGNAME`/`SHELL`/`LANG`/`LC_ALL`/`PM2_HOME` only, no
inherited shell secrets or session cruft):

1. `pm2 kill` (clean env) — killed the daemon and all managed processes.
2. Respawned every app fresh (clean env) via `scripts/start-web-admin.sh
   start`, `~/docker-log-watchers/start-pm2.sh`, `~/Kryten/scripts/start-pm2.sh`,
   and `~/meshtastic/start.sh` (this last one wasn't in the initial pass — the
   Meshtastic apps are launched from a separate `~/meshtastic/ecosystem.config.cjs`
   / `~/meshtastic/start.sh` that isn't wired into `post-startup-hook.sh`,
   worth knowing if a full restart is ever needed again).
3. Reinstalled the `pm2-logrotate` module (doesn't come back via the app
   launchers, needed `pm2 install pm2-logrotate` separately).

Verified afterward (variable **names only**, never values, per the handling
notes below): every app's stored env and the new daemon process's own environ
contain only expected system vars + each app's legitimate config — no
`INFISICAL_TOKEN`/`TS_AUTHKEY`/`TS_API_TOKEN`, no leftover session cruft.

## Deferred — explicitly out of scope for this fix

Secret rotation for the three tokens exposed on 2026-09-15
(`INFISICAL_TOKEN`, `TS_AUTHKEY`, `TS_API_TOKEN`) — these were briefly written
to a plaintext file on disk (now deleted) and were live in the daemon's own
process memory until the 2026-09-16 clean restart. User will handle rotation
in a separate session.

## Handling notes for whoever picks this up

- **Never run `pm2 jlist` or `pm2 env <id>` and let the raw output land in a
  file, log, or session transcript** — it prints real secret *values*, not just
  names. Prefer grepping for variable *names* only, e.g.
  `pm2 env <id> | grep -oE '^[A-Z_]+='`, if you just need to know what's
  present without exposing values.
- If secrets do get captured into a Claude Code session tool-result file, the
  user deleting it themselves works fine; Claude's own auto-mode classifier
  blocks a same-session self-delete of tool-result files as "session
  transcript tampering" by design, so it will need to hand that back to the
  user rather than trying to work around the block.
- A full `pm2 kill` is blocked by Claude Code's auto-mode classifier as
  "workload interference" (it stops every managed process on the box) even
  with explicit user sign-off in chat — the user has to run it themselves.
  Build them a reviewable script rather than trying to run it directly.

## Context: what prompted this investigation

Session was upgrading infisical from v0.164.1 to v0.165.10 (module commit
`f95aef9` in `do-it-self-containers`, root-cause fix for the "module update
restarts everything" issue committed as `0dd08df` in the main `do-it-self`
repo). After confirming infisical was healthy on the new version, the
dashboard at `https://admin.jamnapari-goblin.ts.net/docker-status` still showed
"v0.165.10 available" — a stale `versionDrift.js` cache (12h refresh interval,
last populated before the tag bump). Restarting the web admin to force an
immediate re-check is what led to running `pm2 jlist` to verify the restart
took effect, which is what surfaced this finding.
