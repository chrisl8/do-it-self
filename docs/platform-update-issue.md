# `scripts/update-platform.sh` is permanently blocked after first `setup.sh` run

## Symptom

On any freshly-provisioned client machine, after running `scripts/setup.sh` once to bootstrap the platform, `scripts/update-platform.sh` refuses to run:

```
── Preconditions ──
  FAIL Platform repo has uncommitted changes:
      M container-registry.yaml
       M web-admin/frontend/package-lock.json
  Commit or stash changes before updating. Do not use --force.
```

This state is **unavoidable** for a downstream user: neither file is something the user edited. Both were mutated by the platform's own install machinery during `setup.sh`. The user's only paths forward are:

1. Commit the modifications as a local commit on `main` (ugly: content they don't own, with an identity that isn't really theirs in the maintainer sense).
2. `git update-index --skip-worktree <files>` as an out-of-band workaround.
3. Use `--force` (but the script explicitly tells them not to).

The supported forward-update flow is broken for every downstream user from install #1.

## Reproduction

```bash
# Fresh Ubuntu box
git clone https://github.com/chrisl8/do-it-self.git ~/containers
cd ~/containers
# (provide TS_AUTHKEY, TS_API_TOKEN via env)
bash scripts/setup.sh
git status
#  M container-registry.yaml
#  M web-admin/frontend/package-lock.json
scripts/update-platform.sh
#  FAIL Platform repo has uncommitted changes ...
```

No user edits between `setup.sh` and `update-platform.sh`. The files are modified by setup.sh itself:

- `container-registry.yaml` is rewritten by `scripts/migrate-to-modules.sh` (the `regenerate-registry` branch — it **prunes** the containers map down to only the ones actually installed on this host; see `migrate-to-modules.sh:137-138`) and again by each `scripts/module-helper.js install` call (which adds a `source:` field to the installed container and re-sorts — see `module-helper.js:274-283`).
- `web-admin/frontend/package-lock.json` is mutated by `npm run install:all` during setup.sh step 8 (`setup.sh:464`). Node/npm versions differ across machines, lockfile regenerates with minor differences.

## Root cause

Two tracked files that the platform itself treats as *mutable local state*:

### `container-registry.yaml`

This file conflates two different things:
1. **Upstream catalog data**: `shared_variables:` block and the *schema* of each container (description, volumes, variables, tags). Rightly tracked.
2. **Local install state**: the `containers.<name>.source` field is set to `do-it-self-containers` (or `personal`) only after the container is actually installed on this host. The set of keys in `containers:` is pruned to match the local install. This is fundamentally per-machine state.

The per-machine slice is already duplicated in `installed-modules.yaml` (which holds `modules.<name>.installed_containers: []`). So there's both duplication and a tracking-mismatch.

### `web-admin/frontend/package-lock.json`

Committing a lockfile at the *platform* level makes sense for reproducible upstream builds, but every downstream `npm install` produces slight deltas. Current behavior is worst-of-both: tracked, so dirty diffs persist; regenerated, so the tracked version drifts immediately.

## Proposed fixes (ranked)

### A. Unify install state in `installed-modules.yaml`; treat `container-registry.yaml` as read-only catalog

**Shape:** `container-registry.yaml` ships with *all* catalog entries for all modules (equivalent to a merged view of every `module.yaml`), never rewritten by install operations. `installed-modules.yaml` remains the sole record of what's installed locally. Scripts that currently read `registry.containers.<name>.source` read it from `installed-modules.yaml` instead.

**Pros:** Eliminates the duplication. Registry becomes truly static upstream data. Diff stays clean across installs.
**Cons:** Touches every consumer of `registry.containers[x].source`. Some migration of schema (source field read location).

This is the cleanest long-term answer.

### B. Split into `container-registry.yaml` (tracked) + `container-registry.local.yaml` (gitignored)

Ship the pristine catalog in the tracked file; write pruning/source-tagging to the `.local` variant. Readers merge at load time (local overrides tracked).

**Pros:** Small change; tracked file stays pristine; no data moves.
**Cons:** Adds a file; readers gain a merge step. Two sources of truth for "what's installed."

### C. `.gitignore container-registry.yaml` and regenerate it on install

Generate the registry entirely from `.modules/*/module.yaml` at `setup.sh` time. The committed registry becomes a seed/example only, or is removed entirely in favor of a generator.

**Pros:** Simplest conceptually — derived data isn't tracked.
**Cons:** Requires a deterministic generator and a way for users who don't want the full catalog to influence it (which `installed-modules.yaml` already serves).

### D. `update-platform.sh` stashes these two files automatically

Before `git fetch/merge`, `git stash` the known-volatile paths, do the update, `git stash pop`. Treats the symptom rather than the cause.

**Pros:** Zero change to the rest of the platform.
**Cons:** Stash-pop on a registry file that upstream also changed will produce merge conflicts — doesn't actually help during real upstream changes.

### For `web-admin/frontend/package-lock.json` specifically

Either:
- `.gitignore` it and rely on `package.json` version ranges for reproducibility (matches how `setup.sh:464` invokes `npm run install:all` every time anyway), or
- Explicitly assert it as reproducible upstream state and have `setup.sh` run `npm ci` (which *won't* modify the lockfile) instead of `npm install` (which will). `npm ci` also fails fast if the lockfile is out of sync with `package.json`, which is probably what you want.

`npm ci` is the cheapest fix for the lockfile half of this issue.

## Minimal patch sketch (Option A + `npm ci`)

1. `scripts/migrate-to-modules.sh:137-138` — remove the `regenerate-registry` call; the registry is no longer written by the installer.
2. `scripts/module-helper.js:271-283` — stop writing `registry.containers[x].source`; remove the registry write at the end of `install`. Keep only the `installed-modules.yaml` write.
3. Consumers of `registry.containers[x].source` — search `rg 'containers\.[a-zA-Z_-]+\.source' scripts/ web-admin/`. Each site should read the source from `installed-modules.yaml` instead (one reverse-lookup: "for this container name, which module's `installed_containers` contains it?").
4. Ship a fully-populated `container-registry.yaml` with every known container from every catalog module (build step, or just check in the merged view).
5. `scripts/setup.sh:464` — change `npm run install:all` → a dedicated `npm ci` step in `web-admin/` (or whatever matches the existing `install:all` structure).

With those five changes, both tracked files stop moving on install, `update-platform.sh`'s "no uncommitted changes" gate stops firing spuriously, and the duplication between `container-registry.yaml` and `installed-modules.yaml` goes away.

## Evidence captured on the client box

- Platform: `~/containers` on `deepthought.hedgehog-avior.ts.net` (Ubuntu, docker, fnm/node).
- HEAD: `1ec182fd80ea8bcb2d020b5df6b8300e13d6288a`.
- Setup.sh ran to `Setup Complete!` without human-authored file edits in between.
- `git status` output after setup: the two `M` lines above, nothing else.
- `scripts/update-platform.sh` output: the `FAIL Platform repo has uncommitted changes` block above.
- `installed-modules.yaml` contains the *same* install state already (`modules.do-it-self-containers.installed_containers: [...]`), confirming the duplication claim.

## Temporary workaround in use on this box

```
git update-index --skip-worktree container-registry.yaml web-admin/frontend/package-lock.json
```

This lets `update-platform.sh` run, but it's a per-user workaround that hides real upstream changes to those files from the user. Not a fix.
