import Docker from "dockerode";
import { getStatus, updateStatus } from "./statusEmitter.js";

const docker = new Docker();

// A container is "settled healthy" when it is actually running and not
// reporting a problem: it either passes its healthcheck ("(healthy)") or has no
// healthcheck at all. Anything still starting, unhealthy, created, exited, or
// restarting means the stack has not fully recovered. This mirrors the
// wait_for_containers_to_settle logic in scripts/all-containers.sh.
function containerIsSettledHealthy(container) {
  if (container.State !== "running") {
    return false;
  }
  const status = container.Status || "";
  return (
    !status.includes("(unhealthy)") && !status.includes("(health: starting)")
  );
}

// Auto-clear stale "Update Failed" badges. A web-admin upgrade that exits
// non-zero leaves restartStatus.<stack> = { status: "failed" }, which used to
// persist until the user manually dismissed it -- even when the stack went on
// to recover on its own moments later (e.g. a slow healthcheck that timed out
// the compose `--wait` but came up healthy just after). Once every container in
// the stack is running and healthy again the failure is no longer actionable,
// so we drop the badge. The independent DIUN "update available" chip is left
// untouched, so an upgrade that genuinely failed and rolled back to the old
// image still surfaces via that signal.
//
// Queries Docker with { all: true } so a container still stuck in Created or
// Exited keeps the badge: the running-only view the rest of the UI uses cannot
// see those, and clearing on a partial recovery would hide a real problem.
//
// Normally a no-op -- it returns immediately when no stack carries a "failed"
// badge, so the common case costs nothing.
export default async function reconcileUpgradeStatus() {
  const { restartStatus } = getStatus();
  if (!restartStatus) {
    return;
  }

  const failedStacks = Object.entries(restartStatus)
    .filter(([, value]) => value && value.status === "failed")
    .map(([name]) => name);
  if (failedStacks.length === 0) {
    return;
  }

  for (const stackName of failedStacks) {
    try {
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${stackName}`] },
      });
      if (
        containers.length > 0 &&
        containers.every(containerIsSettledHealthy)
      ) {
        updateStatus(`restartStatus.${stackName}`, undefined);
        console.log(
          `[reconcileUpgradeStatus] Cleared stale 'Update Failed' badge for '${stackName}': all containers healthy again.`,
        );
      }
    } catch (error) {
      console.error(
        `[reconcileUpgradeStatus] Health re-check failed for '${stackName}':`,
        error?.message || error,
      );
    }
  }
}
