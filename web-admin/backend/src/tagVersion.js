// Pure tag-classification/comparison logic, kept separate from
// registryTags.js so it's testable without mocking network calls.
//
// Goal: decide whether a candidate tag is a genuinely *newer, comparable*
// version of a currently-pinned tag -- without guessing at tag shapes we
// can't parse with confidence. A false negative (badge doesn't show) is
// fine; a false positive (wrong "newer version" claim) is not, so anything
// that doesn't cleanly fit "leading integer, optionally dotted, optionally
// suffixed" is deliberately left unclassified rather than pattern-matched
// further. That excludes compound multi-version tags (e.g.
// "14-vectorchord0.4.3-pgvectors0.2.0"), channel names ("stable", "release",
// "V2-Beta"), and anything without a leading digit.

// The suffix (after the version digits) is deliberately restricted to a
// single letters-only word (e.g. "-alpine", "-bookworm", "-slim") -- no
// further digits, dots, or dashes. That's what a genuine distro/variant tag
// looks like; a compound tag that embeds a second project's version number
// (e.g. postgres's "14-vectorchord0.4.3-pgvectors0.2.0", postgis's
// "17-3.5-alpine") fails this pattern entirely and falls through to
// unclassifiable, rather than being matched against another tag's suffix
// text that will almost certainly differ release-to-release anyway.
const TAG_RE = /^(\d+)((?:\.\d+){0,2})(-[a-zA-Z][a-zA-Z0-9]*)?$/;

// Classifies one tag into { parts, suffix, shapeKey } or null if it doesn't
// match the narrow "version-shaped" pattern this feature trusts. `parts` is
// the numeric [major, minor?, patch?] tuple; `shapeKey` groups tags that are
// structurally comparable -- same number of dotted components and same
// trailing suffix -- so e.g. "16-alpine"/"17-alpine" compare against each
// other, "7.4-alpine"/"7.9-alpine" compare against each other, but a bare
// "16" is never compared against "16-alpine" (different shape).
export function classifyTag(tag) {
  if (!tag) return null;
  // Only strip a lowercase leading "v" (the near-universal semver
  // convention, e.g. "v0.162.7") -- NOT case-insensitively, since a
  // capitalized "V" is more often a channel/label prefix on a non-semver
  // tag (e.g. stirling-pdf's "V2-Beta") that would otherwise be misread as
  // a comparable version-shaped tag.
  const stripped = tag.replace(/^v(?=\d)/, "");
  const match = stripped.match(TAG_RE);
  if (!match) return null;

  const [, majorStr, dotted, suffix] = match;
  const parts = [
    parseInt(majorStr, 10),
    ...(dotted
      ? dotted
          .slice(1)
          .split(".")
          .map((n) => parseInt(n, 10))
      : []),
  ];
  const shapeKey = `depth${parts.length}${suffix || ""}`;

  return { parts, suffix: suffix || "", shapeKey };
}

function compareParts(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// True if `candidateTag` is a strictly newer, same-shape version of
// `currentTag`. Both must classify, and must share a shapeKey.
export function isNewerTag(currentTag, candidateTag) {
  const current = classifyTag(currentTag);
  const candidate = classifyTag(candidateTag);
  if (!current || !candidate) return false;
  if (current.shapeKey !== candidate.shapeKey) return false;
  return compareParts(candidate.parts, current.parts) > 0;
}

// Finds the best (highest-version) same-shape tag in `allTags` that is
// newer than `currentTag`. Returns { tag } or null if currentTag is
// unclassifiable or nothing newer of the same shape exists.
export function bestNewerTag(currentTag, allTags) {
  const current = classifyTag(currentTag);
  if (!current) return null;

  let best = null;
  for (const tag of allTags) {
    const candidate = classifyTag(tag);
    if (!candidate) continue;
    if (candidate.shapeKey !== current.shapeKey) continue;
    if (compareParts(candidate.parts, current.parts) <= 0) continue;
    if (!best || compareParts(candidate.parts, best.parts) > 0) {
      best = { tag, parts: candidate.parts };
    }
  }
  return best ? { tag: best.tag } : null;
}
