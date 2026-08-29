// Generic OCI Distribution API client (GET /v2/<repo>/tags/list) with the
// standard WWW-Authenticate: Bearer challenge/response. Docker Hub, GHCR,
// lscr.io, Codeberg's OCI registry, and GCR all speak this same protocol, so
// one code path covers every registry the fleet uses -- no per-registry auth
// branches needed, just host/name normalization for Docker Hub's implicit
// "library/" prefix and bare "registry-1.docker.io" host.

const TAG_LIST_CACHE_TTL = 24 * 60 * 60 * 1000; // registries rate-limit anonymous
// pulls (Docker Hub: ~100 req/6h/IP) and new tags land on a scale of weeks,
// not minutes -- keep this far slower than githubReleases.js's 10-minute cache.
const tagListCache = new Map(); // "registry/repoPath" -> { tags, fetchedAt }

const DOCKERHUB_HOSTS = new Set(["docker.io", "registry-1.docker.io"]);

// Parses a resolved image reference (e.g. Docker's own `c.Image`, which has
// already substituted any compose env-var interpolation) into a registry/
// repoPath/tag triple. Returns tag: null for untagged images (implicit
// `latest`) and for digest-pinned images (`@sha256:...`) -- both are "not
// checkable against a prior version" and are the caller's decision to skip,
// not this function's.
export function parseImageRef(image) {
  if (!image) return { registry: null, repoPath: null, tag: null };

  // Strip a digest suffix entirely; there's no "current tag" to compare from.
  const withoutDigest = image.split("@")[0];

  // Only the FIRST path segment can be a registry host (e.g. "ghcr.io" out
  // of "ghcr.io/owner/repo:tag") -- everything after it, however many more
  // slashes it contains, is the repo path.
  const segments = withoutDigest.split("/");
  const firstSegment = segments[0];
  const looksLikeHost =
    segments.length > 1 &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost");

  let registry;
  let rest;
  if (looksLikeHost) {
    registry = firstSegment;
    rest = segments.slice(1).join("/");
  } else {
    registry = "docker.io";
    rest = withoutDigest;
  }

  const tagSplit = rest.lastIndexOf(":");
  // Guard against a bare port-looking colon in a path segment (not a
  // concern here since `rest` has no host component left, but be safe if a
  // ":" appears before the last "/").
  const lastSlashInRest = rest.lastIndexOf("/");
  let repoPath;
  let tag;
  if (tagSplit !== -1 && tagSplit > lastSlashInRest) {
    repoPath = rest.slice(0, tagSplit);
    tag = rest.slice(tagSplit + 1);
  } else {
    repoPath = rest;
    tag = null; // implicit `latest`
  }

  if (DOCKERHUB_HOSTS.has(registry)) {
    registry = "registry-1.docker.io";
    if (!repoPath.includes("/")) repoPath = `library/${repoPath}`;
  }

  return { registry, repoPath, tag };
}

function parseAuthChallenge(header) {
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const params = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header))) {
    params[m[1]] = m[2];
  }
  if (!params.realm) return null;
  return params;
}

async function getBearerToken(challenge) {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  if (challenge.scope) url.searchParams.set("scope", challenge.scope);
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Auth token request failed: ${response.status}`);
  }
  const data = await response.json();
  return data.token || data.access_token;
}

// Fetches the full tag list for one repo, following pagination up to a
// bounded number of pages. Returns null (not throws) on failure so a single
// bad image never aborts a whole refresh cycle -- callers keep whatever
// drift result was previously cached.
export async function fetchTagList({ registry, repoPath }) {
  if (!registry || !repoPath) return null;

  const cacheKey = `${registry}/${repoPath}`;
  const cached = tagListCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TAG_LIST_CACHE_TTL) {
    return cached.tags;
  }

  try {
    const tags = [];
    // Heavily-tagged official images (mongo, mariadb, postgres, ...) can
    // carry several thousand historical tags with no guaranteed ordering,
    // so a small page cap silently truncates to old tags and misses the
    // actual latest major -- request large pages and allow enough of them
    // to cover realistic repo sizes (confirmed against real mongo/mariadb
    // tag counts, ~3600 and ~2000+ tags respectively).
    let url = `https://${registry}/v2/${repoPath}/tags/list?n=1000`;
    let token = null;
    let pages = 0;

    while (url && pages < 50) {
      pages++;
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      let response = await fetch(url, { headers });

      if (response.status === 401 && !token) {
        const challenge = parseAuthChallenge(
          response.headers.get("www-authenticate"),
        );
        if (!challenge) return null;
        token = await getBearerToken(challenge);
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      if (!response.ok) {
        console.error(`[registryTags] ${cacheKey} returned ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (Array.isArray(data.tags)) tags.push(...data.tags);

      const link = response.headers.get("link");
      const nextMatch = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch
        ? new URL(nextMatch[1], `https://${registry}`).toString()
        : null;
    }

    tagListCache.set(cacheKey, { tags, fetchedAt: Date.now() });
    return tags;
  } catch (error) {
    console.error(`[registryTags] Failed to fetch ${cacheKey}:`, error.message);
    return null;
  }
}

// Best-effort human-viewable "here are the tags" page for a repo, so the
// frontend badge can link somewhere useful for manual investigation. Not
// guaranteed accurate for every possible repoPath shape -- it's a
// convenience link, not a data source.
export function registryTagsUrl({ registry, repoPath }) {
  if (!registry || !repoPath) return null;

  if (DOCKERHUB_HOSTS.has(registry) || registry === "registry-1.docker.io") {
    if (repoPath.startsWith("library/")) {
      return `https://hub.docker.com/_/${repoPath.slice("library/".length)}/tags`;
    }
    return `https://hub.docker.com/r/${repoPath}/tags`;
  }

  if (registry === "ghcr.io" || registry === "lscr.io") {
    const parts = repoPath.split("/");
    const owner = parts[0];
    const pkg = parts[parts.length - 1];
    return `https://github.com/${owner}/packages/container/package/${pkg}`;
  }

  if (registry === "codeberg.org") {
    return `https://codeberg.org/${repoPath}/releases`;
  }

  return `https://${registry}/${repoPath}`;
}
