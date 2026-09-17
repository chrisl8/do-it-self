// Shared classification for "does this container's root compose.yaml differ
// from its module source, and if so is that expected?" Three independent
// call sites need this exact same answer -- module-helper.js's `check`/
// `drift-status` subcommands, the web-admin dashboard's "Module Drift" chip,
// and all-containers.sh's start-time warning (via `drift-status`) -- and
// each used to reimplement it separately. That meant the generation-gate
// exception (see `update()` in module-helper.js) had to be remembered and
// re-added in three places; it was missed in two of them until a container
// legitimately held back by an unmigrated breaking-change generation lit a
// false "will be overwritten" alarm on deepthought (2026-09-17). Kept as a
// pure, dependency-free function so it's importable from both the scripts/
// and web-admin/backend node projects without pulling either's
// node_modules into the other.

// Returns the pending generation label if `containerName` is gated by an
// unpinned breaking-change `generation` in its module.yaml entry, or null if
// it's unset or already pinned in user-config.yaml. Mirrors the gate
// `update()` itself enforces when deciding whether to re-render a
// container -- kept here too so drift-reporting and gate-enforcement never
// drift apart from each other.
export function generationGateLabel(moduleYaml, userConfig, containerName) {
  const currentGeneration = moduleYaml?.containers?.[containerName]?.generation;
  if (!currentGeneration) return null;
  const pinnedGeneration =
    userConfig?.containers?.[containerName]?.pinned_generation;
  if (pinnedGeneration === currentGeneration) return null;
  return currentGeneration;
}

// Classifies one container's drift status from its module/root compose text.
//   "clean"              -- texts match, nothing to report.
//   "pending-generation" -- texts differ, but only because of an unmigrated
//                           generation gate -- expected, not an alarm.
//   "drifted"            -- texts differ for any other reason -- a real,
//                           actionable divergence that `module.sh update`
//                           WILL overwrite (or that already overwrote a
//                           root-only edit).
export function classifyContainerDrift({
  moduleText,
  rootText,
  moduleYaml,
  userConfig,
  containerName,
}) {
  if (moduleText === rootText) return { status: "clean" };
  const generation = generationGateLabel(moduleYaml, userConfig, containerName);
  if (generation) return { status: "pending-generation", generation };
  return { status: "drifted" };
}
