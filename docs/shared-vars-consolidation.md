# Shared Variables Consolidation: Move to Infisical-Only

## Status

**Not yet implemented.** This document is a self-contained design and execution
plan for a future session. It was written after `TS_AUTHKEY` was successfully
moved to Infisical-only storage, when it became clear the same wart applied to
the rest of the `shared:` variables but at a smaller scale.

A fresh Claude session reading this should be able to execute it end-to-end
without needing the conversation history that produced it. Verify everything
against the live code first — file paths and line numbers in this doc are a
starting point, not gospel; the relevant chunks of code may have moved.

## Problem

`container-registry.yaml` defines four `shared_variables`:

- `TS_AUTHKEY` (secret) — Tailscale auth key, used by 46 containers' sidecars
- `TS_DOMAIN` (non-secret) — Tailnet domain (e.g. `jamnapari-goblin.ts.net`),
  used by 41 containers, no defaults
- `HOST_NAME` (non-secret) — host's hostname on the tailnet, used by 3
  containers as `${HOST_NAME}.${TS_DOMAIN}`, no defaults
- `DOCKER_GID` (non-secret) — host's docker group GID, used by 5 containers as
  `${DOCKER_GID:-985}` (built-in fallback)

`TS_AUTHKEY` is already correctly stored in **Infisical only** and injected at
container start time via `infisical export --path=/shared`. The other three
are **dual-stored**: written to both `user-config.yaml` `shared:` block AND
Infisical `/shared` whenever the user saves them via the web admin
Configuration tab. This dual-write happens at one entry point
(`web-admin/backend/src/server.js` `PUT /api/config/shared`) but the two
stores are then read independently by different code paths and are free to
drift if anyone ever edits one without going through the web admin.

This is the same kind of wart that `TS_AUTHKEY` had before the cleanup, just
smaller — and the fix is the same: pick one canonical store and stick to it.

## Current data flow

These line numbers are accurate as of when this doc was written; verify
against current state before editing.

### Definition

`container-registry.yaml` lines 5-21 declare the four shared variables under
the top-level `shared_variables:` key. `TS_AUTHKEY` is `type: secret`, the
others have no `type` field (defaulting to non-secret).

### On-disk store

`user-config.yaml` (gitignored, lives at the repo root) has a `shared:` block
containing `TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`. The `TS_AUTHKEY: ""`
entry was removed in the earlier cleanup; if you find it back, it was
re-added by something — investigate.

### Secret store

Infisical at `/shared/<name>`. After the `TS_AUTHKEY` cleanup, this currently
holds:

- `TS_AUTHKEY` — canonical
- `TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID` — dual-written from `user-config.yaml`

To verify, source `~/credentials/infisical.env` and run `infisical secrets
list --token="$INFISICAL_TOKEN" --projectId="$INFISICAL_PROJECT_ID"
--path=/shared --env=prod --domain="$INFISICAL_API_URL"`.

### Per-container `.env` writers

Two parallel implementations of the same logic — one for the CLI, one for
the web admin:

- `scripts/generate-env.js` — `buildEnvForContainer()` around lines 134-184.
  Called from `setup.sh` and `all-containers.sh`. Reads `userConfig.shared`
  and writes `DOCKER_GID`, `TS_DOMAIN`, `HOST_NAME` into the per-container
  `.env` file.
- `web-admin/backend/src/configRegistry.js` — `buildEnvForContainer()` around
  lines 64-123. Same logic, called from `writeAllContainerEnvs()` after
  every web-admin save.

After this consolidation, **neither implementation should write the four
shared variables into per-container `.env` files**.

### Runtime injection

`scripts/all-containers.sh:783-785` runs `infisical export --path=/shared`
and `--path=/<container>` and evals the output into the shell env right
before `docker compose up -d`. Docker Compose substitutes `${VAR}` references
in `compose.yaml` from the shell env (winning over the project-dir `.env`),
so secrets and shared variables land in the container's environment via
this path.

After consolidation, **this is the only path that delivers shared
variables**. Containers started outside `all-containers.sh` (direct
`docker compose up`) will not get them. This is consistent with the existing
project convention: always use `scripts/all-containers.sh` to manage
containers, never `docker compose` directly.

### Web-admin save dual-write (the wart)

`web-admin/backend/src/server.js` `PUT /api/config/shared`, around lines
535-578 in the current working tree. The handler:

1. Splits `req.body` into `secrets` and `nonSecrets` based on
   `registry.shared_variables[key].type === "secret"`.
2. Refuses to save if any secret is present and Infisical is unavailable
   (503 response — added in the earlier cleanup).
3. Writes `nonSecrets` to `user-config.yaml.shared`. **This is the
   wart.**
4. Writes `{ ...nonSecrets, ...secrets }` to Infisical `/shared` via
   `setSharedSecrets()`. **This is the keep.**
5. Calls `writeAllContainerEnvs()` to regenerate every per-container
   `.env` file (which currently still includes the now-redundant shared
   vars).

The intent of the dual-write was hedging: making the values available via
either consumption path. After this cleanup, the `infisical export` runtime
injection becomes the only delivery path, so the disk write becomes
redundant and harmful (drift potential).

## Compose-file usage counts (blast radius)

```
TS_AUTHKEY:  46 containers reference ${TS_AUTHKEY}             (no defaults)
TS_DOMAIN:   41 containers reference ${TS_DOMAIN}              (no defaults)
HOST_NAME:    3 containers reference ${HOST_NAME}.${TS_DOMAIN} (no defaults)
DOCKER_GID:   5 containers reference ${DOCKER_GID:-985}        (built-in default)
```

`DOCKER_GID` is the only one with a fallback. The other three must be set
or the containers fail to come up correctly. This means **this consolidation
makes Infisical a hard runtime dependency for ~41 containers**. The earlier
`TS_AUTHKEY` cleanup already established this for 46 containers, so the
marginal increase is small or zero.

To re-verify the counts:

```bash
for v in TS_AUTHKEY TS_DOMAIN HOST_NAME DOCKER_GID; do
  count=$(grep -l "\${$v" /home/chrisl8/containers/*/compose.yaml 2>/dev/null | wc -l)
  echo "$v: $count containers"
done
```

## Target design

**Infisical becomes the sole canonical store for all shared variables.** The
`shared:` block in `user-config.yaml` disappears entirely. Per-container
`.env` files contain only `VOL_*` paths and container-specific defaults
from the registry; shared variables come exclusively from `infisical export
--path=/shared` at start time. The web admin's read path already merges
Infisical `/shared` over the (now-empty) `user-config.yaml.shared` block,
so the Configuration tab UI keeps working unchanged.

Rationale:

- **Eliminates dual-write drift potential.** One source of truth.
- **Consistent with the principle established for `TS_AUTHKEY`.** No
  special-case "secrets are special, non-secrets are different" — all
  shared vars work the same way.
- **Marginal cost is zero.** Infisical is already a hard runtime dependency
  for any container that uses `${TS_AUTHKEY}` after the earlier cleanup.
  Extending the dependency to `${TS_DOMAIN}`/`${HOST_NAME}` containers is
  a no-op in practice — those are the same set of containers.
- **`user-config.yaml` becomes simpler.** It holds only the things it's
  *actually* the source of truth for: mount paths and per-container
  enabled/volume-mount/variables decisions.

## Bootstrap problem (unchanged)

Infisical itself cannot pull its own bootstrap secrets from itself.
`AUTH_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD` for the Infisical container
must live on disk in `infisical/.env`. They are sourced from
`infisical/infisical-secrets.env` and appended to `infisical/.env` by
`scripts/generate-env.js`'s `appendInfisicalBootstrapSecrets()` function
(around lines 210-220). **This consolidation must NOT touch that path.**
The Infisical container is the special case; every other container fetches
its secrets and shared variables from the running Infisical instance.

## Concrete file changes

Verify each file's current state before editing — lines may have shifted.

### `scripts/generate-env.js`

In `buildEnvForContainer()` (around lines 134-184):

- Remove the `DOCKER_GID` write (currently around line 147-149 — `if
  (containerDef.uses_docker_gid) { env.DOCKER_GID = ... }`).
- Remove the `TS_DOMAIN` write inside the `if (containerDef.uses_tailscale)`
  block (currently around lines 151-158, the branch left over from the
  `TS_AUTHKEY` cleanup).
- Remove the `HOST_NAME` write (currently around lines 159-161).
- Add a header comment to `buildEnvForContainer` explaining that shared
  variables are intentionally not handled here — they come from `infisical
  export --path=/shared` at container start time.

### `web-admin/backend/src/configRegistry.js`

Symmetric changes to the web-admin copy of `buildEnvForContainer()` (around
lines 64-123). Make this implementation match `scripts/generate-env.js`.
Same removals: `DOCKER_GID`, `TS_DOMAIN`, `HOST_NAME` no longer written to
the per-container `.env` file.

`getConfigStatus()` (around lines 325-373) and `validateContainer()` (around
lines 289-313) already merge Infisical `/shared` into `userConfig.shared`
before validating. After this change that merge becomes load-bearing — it's
the only way the validation code learns about shared variable values. Add
a comment marking the merge as load-bearing so a future maintainer doesn't
accidentally remove it.

### `web-admin/backend/src/server.js`

`PUT /api/config/shared` handler (around lines 535-578). Remove the
dual-write:

- Delete the lines that write `nonSecrets` to `user-config.yaml.shared`
  (currently around line 562-564 — `userConfig.shared = { ...userConfig.shared,
  ...nonSecrets }; await saveUserConfig(userConfig);`).
- Keep the Infisical write (currently around line 568-570 — `await
  setSharedSecrets({ ...nonSecrets, ...secrets })`).
- Keep the 503 response when Infisical is unavailable (currently around
  lines 554-560). After this change it should fire for *any* shared
  variable save, not just secret saves — update the error message to say
  so. Today it says "Cannot save secret: Infisical is not available";
  change to "Cannot save shared variables: Infisical is not available".
- The 503 guard at line 554 currently only fires when `secrets` is
  non-empty. Change to fire when `req.body` is non-empty (we're requiring
  Infisical for the entire endpoint now).

### `scripts/setup.sh`

Step 7 — `user-config.yaml` template creation (around lines 209-238 in the
working tree). Drop the entire `shared:` block from the template heredoc.
The template should produce just `mounts:` and `containers: {}`.

Step 11b — Infisical seeding (around lines 318-360 in the working tree).
The current code only seeds `TS_AUTHKEY` and `TS_DOMAIN` to Infisical on
first run. Extend it to also seed `HOST_NAME` (already auto-detected as
`DETECTED_HOSTNAME` in step 7) and `DOCKER_GID` (already auto-detected as
`DETECTED_DOCKER_GID` in step 7). Reuse the same "get first, only set if
missing or different" pattern that `TS_AUTHKEY` and `TS_DOMAIN` already
use.

Variable scoping: `DETECTED_HOSTNAME` and `DETECTED_DOCKER_GID` are
currently local to step 7's `if [[ ! -f "$CONFIG_FILE" ]]` block. Move the
detection out of that block (or just re-run it) so step 11b can read them.

### `scripts/all-containers.sh`

The pre-start "Infisical needed for Tailscale containers" check added
during the `TS_AUTHKEY` cleanup (around lines 725-755). Currently the grep
is `grep -q '${TS_AUTHKEY}' compose.yaml`. Broaden it to:

```bash
grep -qE '\$\{(TS_AUTHKEY|TS_DOMAIN|HOST_NAME)\}' compose.yaml
```

This catches containers that use only `TS_DOMAIN` or `HOST_NAME` without
`TS_AUTHKEY`. Don't include `DOCKER_GID` — it has a built-in default of
`985`, so containers using it can start without injection.

Update the error message to say "shared variables" instead of "Tailscale
auth key".

### `container-registry.yaml`

Update the `description` for each shared variable to note that it lives in
Infisical only. `TS_AUTHKEY` already has this note. Add the equivalent for
`TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`. Wording should match the
`TS_AUTHKEY` comment style.

### Live `user-config.yaml`

After all code is updated and tested, hand-remove the entire `shared:`
block from the gitignored `user-config.yaml` on the live system. The block
should currently contain `TS_DOMAIN`, `HOST_NAME`, `DOCKER_GID`. Use the
`Edit` tool, not `sed`. Verify by `cat`-ing the file afterward.

## Edge cases

### Direct `docker compose up`

After this change, containers started via `docker compose up` directly (not
through `all-containers.sh`) will be missing `TS_DOMAIN`/`HOST_NAME` and
will fail or come up misconfigured. `DOCKER_GID` will fall back to its
built-in `985` default. This is consistent with the project convention:
**always use `scripts/all-containers.sh` to manage containers**. Document
this caveat in any user-facing prose, but no code workaround is needed.

### `DOCKER_GID:-985` fallback

The `:-985` default in compose files is intentional and should stay. It
means containers using `DOCKER_GID` can start outside `all-containers.sh`
without breaking, even though they'll get the wrong GID if 985 isn't
correct for the host. This is a soft failure (works but with suboptimal
permissions), not a hard one.

### First-run bootstrap order

`setup.sh` step 6 (Tailscale join) auto-detects `TS_DOMAIN` from `tailscale
status --json` (around lines 197-204). The detected value sits in the
`$TS_DOMAIN` shell variable through the rest of the script. After this
change, step 11b consumes it (writes to Infisical), and step 7 no longer
writes it to the user-config template.

`HOST_NAME` is detected as `DETECTED_HOSTNAME=$(hostname)` in step 7.
Currently scoped to the `if [[ ! -f "$CONFIG_FILE" ]]` block. Lift the
detection out so step 11b can use it. Same for
`DETECTED_DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3)`.

### Infisical's own bootstrap secrets

Out of scope. `infisical/.env` continues to hold `AUTH_SECRET`,
`ENCRYPTION_KEY`, `DB_PASSWORD` from `infisical/infisical-secrets.env`.
This is the chicken-and-egg case — Infisical can't bootstrap from itself.
The `appendInfisicalBootstrapSecrets()` path in `scripts/generate-env.js`
must continue to function exactly as it does today. **Do not touch it.**

## Verification

After implementing all the file changes above, run these checks:

1. **`user-config.yaml` has no `shared:` block.**
   ```bash
   grep -A1 '^shared:' user-config.yaml || echo "OK: no shared block"
   ```

2. **Infisical `/shared` has all four variables.**
   ```bash
   source ~/credentials/infisical.env
   for v in TS_AUTHKEY TS_DOMAIN HOST_NAME DOCKER_GID; do
     val=$(infisical secrets get "$v" \
       --token="$INFISICAL_TOKEN" --projectId="$INFISICAL_PROJECT_ID" \
       --path=/shared --env=prod --domain="$INFISICAL_API_URL" \
       --silent --plain 2>/dev/null)
     printf "%-12s %s\n" "$v" "${val:+set (${#val} chars)}"
   done
   ```

3. **A regenerated container `.env` has no shared vars.**
   ```bash
   node scripts/generate-env.js homepage --quiet
   cat homepage/.env
   # Expected: VOL_* paths and container defaults only.
   # No DOCKER_GID, no TS_DOMAIN, no HOST_NAME.
   ```

4. **`bash scripts/setup.sh` is a no-op on a healthy system.** Same checks as
   the verification done during the `TS_AUTHKEY` cleanup: web-admin PM2 PID
   unchanged, `infisical/.env` size unchanged, no containers recreated.

5. **`all-containers.sh --start` fails fast when Infisical is down.**
   ```bash
   docker stop infisical
   bash scripts/all-containers.sh --start --container homepage
   # Expected: skipped with the "Infisical must be running" error.
   docker start infisical
   sleep 10
   bash scripts/all-containers.sh --start --container homepage
   # Expected: starts successfully (or no-op if already running).
   ```

6. **Web admin Configuration tab round-trip.** Open the Configuration tab,
   edit `TS_DOMAIN` to a dummy value, save. Confirm:
   ```bash
   # Should reflect the dummy value:
   infisical secrets get TS_DOMAIN --token="$INFISICAL_TOKEN" \
     --projectId="$INFISICAL_PROJECT_ID" --path=/shared --env=prod \
     --domain="$INFISICAL_API_URL" --silent --plain
   # Should NOT contain a shared block:
   grep -c '^shared:' user-config.yaml
   ```
   Restore the original value via the same UI.

## Out of scope

- The `infisical/.env` bootstrap secrets path. Leave it alone.
- The per-container secrets path (`infisical export --path=/<container>`).
  Already works correctly. This consolidation is only about *shared*
  variables.
- Any UI changes to the Configuration tab. The frontend
  (`web-admin/frontend/src/ContainerConfig.jsx` `SharedVarsSection`) is
  fully generic and renders fields from `registry.shared_variables` —
  no frontend changes are required.
- Removing `shared_variables` from `container-registry.yaml`. The registry
  entries are still needed for the web-admin UI to know what fields to
  render and which are secrets.
