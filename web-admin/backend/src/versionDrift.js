// Background cache of "is a container's actual registry tag behind a newer
// one" per stack, computed independently of DIUN (which only tracks digest
// changes on the tag already pinned in compose.yaml) and independently of
// githubReleases.js's SOURCE_OVERRIDES/OCI-label approach (which only covers
// a fraction of the fleet). Works off the live `image` string Docker already
// reports per running container, so it applies uniformly to every stack.
//
// This module never runs from the hot per-poll dockerStatus.js path -- it's
// refreshed on a slow interval (see server.js) and exposes a synchronous
// Map lookup for the fast pipeline to attach to each stack.

import {
  parseImageRef,
  fetchTagList,
  registryTagsUrl,
} from "./registryTags.js";
import { classifyTag, bestNewerTag } from "./tagVersion.js";

// MariaDB ships a rolling release every quarter plus one LTS a year, and only
// the LTS lines are a sane upgrade target for a datastore (rolling majors hit
// community EOL within months -- e.g. 13.0 and 13.1 vs the 12.3 LTS). The
// registry tag list can't tell them apart, so without this the badge nags
// about every rolling major. Maps major -> LTS minors; unknown majors >= 12
// are assumed to follow the current "x.3 is the LTS" cadence.
// https://mariadb.org/about/#maintenance-policy
const MARIADB_LTS_MINORS = { 10: [6, 11], 11: [4, 8], 12: [3], 13: [3] };

function mariadbLtsMinors(major) {
  return MARIADB_LTS_MINORS[major] ?? (major >= 12 ? [3] : []);
}

// Drops MariaDB candidate tags that point at a rolling (non-LTS) release. A
// bare-major tag like "13" only counts once that major has an LTS tag
// published (e.g. "13.3.x"), since before then it floats over rolling builds.
export function filterMariadbRolling(tags) {
  const classified = tags.map((tag) => ({ tag, c: classifyTag(tag) }));
  const hasLts = (major) =>
    classified.some(
      ({ c }) =>
        c &&
        c.parts.length >= 2 &&
        c.parts[0] === major &&
        mariadbLtsMinors(major).includes(c.parts[1]),
    );
  return classified
    .filter(({ c }) => {
      if (!c) return true; // unclassifiable tags are ignored downstream anyway
      const [major, minor] = c.parts;
      return c.parts.length === 1
        ? hasLts(major)
        : mariadbLtsMinors(major).includes(minor);
    })
    .map(({ tag }) => tag);
}

const driftCache = new Map(); // stackName -> null | { container, currentTag, newerTag, registry, repoPath, tagsUrl, checkedAt }

async function computeDriftForContainer(containerName, image) {
  const ref = parseImageRef(image);
  if (!ref.tag) return null; // untagged (implicit latest) or digest-pinned
  if (!classifyTag(ref.tag)) return null; // unparseable shape -- not checkable

  const tags = await fetchTagList(ref);
  if (!tags) return "skip"; // fetch/auth failure -- keep prior cached result

  const isMariadb = /(^|\/)mariadb$/.test(ref.repoPath);
  const newer = bestNewerTag(
    ref.tag,
    isMariadb ? filterMariadbRolling(tags) : tags,
  );
  if (!newer) return null;

  return {
    container: containerName,
    currentTag: ref.tag,
    newerTag: newer.tag,
    registry: ref.registry,
    repoPath: ref.repoPath,
    tagsUrl: registryTagsUrl(ref),
    checkedAt: Date.now(),
  };
}

export async function refreshVersionDrift(runningStacks) {
  for (const [stackName, containers] of Object.entries(runningStacks || {})) {
    const results = [];
    let anySkip = false;

    // Check every container in the stack, not just the first -- a stack's
    // db/redis sidecar can drift independently of its app container, and an
    // early "found one" return would silently hide drift on a later
    // container (or vice versa: hide the sidecar's drift behind the app's).
    for (const [containerName, container] of Object.entries(containers)) {
      let outcome;
      try {
        outcome = await computeDriftForContainer(
          containerName,
          container.image,
        );
      } catch (error) {
        console.error(
          `[versionDrift] Failed checking ${stackName}/${containerName}:`,
          error.message,
        );
        anySkip = true;
        continue;
      }

      if (outcome === "skip") {
        anySkip = true;
        continue;
      }
      if (outcome) results.push(outcome);
    }

    // A confirmed set of results (or a clean "no drift found" with nothing
    // skipped) replaces the cache entry. If some container's check failed
    // this cycle and nothing else drifted, leave the previous cached value
    // in place rather than flapping the badge on transient registry errors.
    if (results.length > 0 || !anySkip) {
      driftCache.set(stackName, results.length > 0 ? results : null);
    }
  }
}

// Returns an array of { container, currentTag, newerTag, registry, repoPath,
// tagsUrl, checkedAt } entries (one per drifted container in the stack), or
// null if none are checkable/drifted.
export function getVersionDrift(stackName) {
  return driftCache.get(stackName) || null;
}
