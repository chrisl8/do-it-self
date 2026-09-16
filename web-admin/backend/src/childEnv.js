// Children spawned from the backend get an explicit, minimal env rather than
// inheriting process.env. This prevents variables intended for the web-admin's
// own compose.yaml substitution (e.g. TS_STATE_HOST_DIR, HOMEPAGE_GROUP) from
// leaking to docker compose invocations in child scripts — shell env wins over
// project .env files in docker compose, so leaked vars would override each
// target container's own settings. Allowlist exactly what the shell scripts
// need. Callers add back any secrets/overrides they specifically require.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "XDG_RUNTIME_DIR",
  "NODE_ENV",
];

export function childEnv() {
  const out = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}
