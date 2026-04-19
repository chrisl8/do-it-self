// Shared helpers for reading a git repo's upstream state and running a
// best-effort fetch. Used by the /api/git-status endpoint and by the
// background gitStatusPoller. Extracted out of server.js so the poller
// doesn't have to import from server's module graph.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function childEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

// Returns { branch, upstream, ahead, behind, canFastForward } for a repo,
// reading cached refs only. Does not run `git fetch` -- caller decides when
// to fetch.
export async function getUpstreamState(repoPath) {
  const env = childEnv();
  const state = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    canFastForward: false,
  };
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath, env },
    );
    state.branch = stdout.trim();
    if (!state.branch || state.branch === "HEAD") return state;
  } catch { return state; }
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${state.branch}@{u}`],
      { cwd: repoPath, env },
    );
    state.upstream = stdout.trim();
  } catch {
    return state;
  }
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-list", "--left-right", "--count", `${state.upstream}...HEAD`],
      { cwd: repoPath, env },
    );
    const [behindStr, aheadStr] = stdout.trim().split(/\s+/);
    state.behind = parseInt(behindStr, 10) || 0;
    state.ahead = parseInt(aheadStr, 10) || 0;
    state.canFastForward = state.behind > 0 && state.ahead === 0;
  } catch { /* leave zeros */ }
  return state;
}

// 60s timeout tolerates slow networks without leaving a ghost fetch running
// forever. Caller catches -- failure of one repo must not kill the batch.
export async function fetchRemote(repoPath, remote, branch) {
  await execFileAsync(
    "git", ["fetch", "--quiet", remote || "origin", branch || "HEAD"],
    {
      cwd: repoPath,
      env: childEnv(),
      timeout: 60000,
    },
  );
}

// Best-effort fetch: logs + returns on error instead of throwing. Used by
// paths that want to fetch multiple repos in a batch.
export async function bestEffortFetch(repoPath, label) {
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath, env: childEnv() },
    );
    await fetchRemote(repoPath, "origin", stdout.trim());
    return { ok: true };
  } catch (err) {
    console.warn(`git fetch failed for ${label}:`, err.message);
    return { ok: false, error: err.message };
  }
}
