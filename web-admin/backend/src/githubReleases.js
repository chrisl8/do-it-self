const releaseCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Per-stack release-notes source overrides, keyed by compose project (stack) name.
// Many images either carry no org.opencontainers.image.source label, carry one
// that points at a docker-packaging repo with no GitHub Releases, or live in a
// multi-container stack where the label-scan could latch onto a sidecar (db,
// redis) instead of the app. An entry here pins the canonical upstream and
// bypasses the label scan entirely. Values are repo URLs; GitHub and Codeberg/
// Forgejo (Gitea API) hosts are supported — see parseRepo().
const SOURCE_OVERRIDES = {
  // No source label on the image at all
  "actual-budget": "https://github.com/actualbudget/actual",
  quicken: "https://github.com/actualbudget/actual",
  code: "https://github.com/coder/code-server",
  infisical: "https://github.com/Infisical/infisical",
  kopia: "https://github.com/kopia/kopia",
  nextcloud: "https://github.com/nextcloud/server",
  portainer: "https://github.com/portainer/portainer",
  uptime: "https://github.com/louislam/uptime-kuma",
  zipline: "https://github.com/diced/zipline",
  eurooffice: "https://github.com/euro-office/documentserver",
  // Label points at a docker-packaging repo that publishes no GitHub Releases
  caddy: "https://github.com/caddyserver/caddy",
  mariadb: "https://github.com/MariaDB/server",
  // Non-GitHub upstream (Forgejo on Codeberg)
  forgejo: "https://codeberg.org/forgejo/forgejo",
  // Multi-container stacks: pin the app so the label scan can't pick a sidecar
  paste: "https://github.com/interaapps/pastefy",
  dawarich: "https://github.com/Freika/dawarich",
};

// Parse a source URL into a fetchable repo descriptor. Supports GitHub and
// Gitea-compatible hosts (Codeberg/Forgejo). Returns null for anything else.
function parseRepo(sourceUrl) {
  if (!sourceUrl) return null;
  const gh = sourceUrl.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/,
  );
  if (gh) {
    return { kind: "github", owner: gh[1], repo: gh[2] };
  }
  const cb = sourceUrl.match(
    /codeberg\.org\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/,
  );
  if (cb) {
    return {
      kind: "gitea",
      apiBase: "https://codeberg.org/api/v1",
      htmlBase: "https://codeberg.org",
      owner: cb[1],
      repo: cb[2],
    };
  }
  return null;
}

async function fetchGitHubReleases(owner, repo) {
  const headers = {
    Accept: "application/vnd.github.full+json",
    "User-Agent": "web-admin-release-notes",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
    { headers },
  );

  if (response.status === 403) {
    const resetTime = response.headers.get("x-ratelimit-reset");
    const resetDate = resetTime
      ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString()
      : "unknown";
    throw new Error(
      `GitHub API rate limit exceeded. Resets at ${resetDate}. Set GITHUB_TOKEN in .env for higher limits.`,
    );
  }

  if (response.status === 404) {
    throw new Error("No releases found for this repository");
  }

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const data = await response.json();

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining) {
    console.log(`[GitHub API] Rate limit remaining: ${remaining}`);
  }

  return data
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || "",
      bodyHtml: r.body_html || "",
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
    }));
}

// Gitea/Forgejo releases API (Codeberg). No body_html is returned, so the
// frontend renders the markdown body as plain text.
async function fetchGiteaReleases(parsed) {
  const { apiBase, htmlBase, owner, repo } = parsed;
  const response = await fetch(
    `${apiBase}/repos/${owner}/${repo}/releases?limit=20`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "web-admin-release-notes",
      },
    },
  );

  if (response.status === 404) {
    throw new Error("No releases found for this repository");
  }
  if (!response.ok) {
    throw new Error(`Forgejo API returned ${response.status}`);
  }

  const data = await response.json();

  return data
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || "",
      bodyHtml: "",
      publishedAt: r.published_at,
      htmlUrl:
        r.html_url || `${htmlBase}/${owner}/${repo}/releases/tag/${r.tag_name}`,
    }));
}

async function fetchReleases(parsed) {
  const cacheKey = `${parsed.kind}:${parsed.owner}/${parsed.repo}`;
  const cached = releaseCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.releases;
  }

  const releases =
    parsed.kind === "gitea"
      ? await fetchGiteaReleases(parsed)
      : await fetchGitHubReleases(parsed.owner, parsed.repo);

  releaseCache.set(cacheKey, { releases, fetchedAt: Date.now() });
  return releases;
}

function normalizeVersion(version) {
  return version.replace(/^v/, "").toLowerCase();
}

export async function getReleaseNotesForStack(stackName, stackContainers) {
  if (!stackContainers || Object.keys(stackContainers).length === 0) {
    return { stackName, error: "Stack is not running" };
  }

  // A manual override pins the canonical upstream for this stack; otherwise
  // fall back to scanning container OCI labels.
  let sourceUrl = SOURCE_OVERRIDES[stackName] || null;
  const overrideRepo = sourceUrl ? parseRepo(sourceUrl) : null;
  let currentVersion = null;
  let labelSource = null;
  let labelVersion = null;
  let overrideVersion = null;
  for (const container of Object.values(stackContainers)) {
    const labels = container.labels || {};
    const cSource = labels["org.opencontainers.image.source"] || null;
    const cVersion = labels["org.opencontainers.image.version"] || null;
    if (!labelSource && cSource) {
      labelSource = cSource;
      labelVersion = cVersion;
    }
    // For an overridden stack, only adopt a version label from a container that
    // belongs to the same project (same repo owner, or no source label at all).
    // This skips sidecars like the db/redis whose own version (e.g. MariaDB's)
    // would otherwise be shown as the app's current version.
    if (overrideRepo && !overrideVersion && cVersion) {
      const cParsed = cSource ? parseRepo(cSource) : null;
      const sameProject =
        !cSource ||
        (cParsed &&
          cParsed.owner.toLowerCase() === overrideRepo.owner.toLowerCase());
      if (sameProject) {
        overrideVersion = cVersion;
      }
    }
  }
  if (sourceUrl) {
    currentVersion = overrideVersion;
  } else {
    // No override: preserve the original pairing of source + version from the
    // same container that carried the source label.
    sourceUrl = labelSource;
    currentVersion = labelVersion;
  }

  if (!sourceUrl) {
    return {
      stackName,
      error: "No source repository URL found in container labels",
    };
  }

  const parsed = parseRepo(sourceUrl);
  if (!parsed) {
    return {
      stackName,
      error:
        "Release notes are only available for GitHub- and Codeberg-hosted projects",
      repoUrl: sourceUrl,
    };
  }

  const { owner, repo } = parsed;
  const repoUrl =
    parsed.kind === "gitea"
      ? `${parsed.htmlBase}/${owner}/${repo}`
      : `https://github.com/${owner}/${repo}`;

  const releases = await fetchReleases(parsed);

  if (releases.length === 0) {
    return {
      stackName,
      currentVersion,
      repoUrl,
      releases: [],
      error: "No releases found for this repository",
    };
  }

  const latestVersion = releases[0]?.tag;

  // If we know the current version, filter to only show newer releases
  if (currentVersion) {
    const normalizedCurrent = normalizeVersion(currentVersion);
    const currentIndex = releases.findIndex(
      (r) => normalizeVersion(r.tag) === normalizedCurrent,
    );

    if (currentIndex > 0) {
      // Found current version, return everything newer
      return {
        stackName,
        currentVersion,
        latestVersion,
        repoUrl,
        releases: releases.slice(0, currentIndex),
      };
    }

    if (currentIndex === 0) {
      // Already on latest
      return {
        stackName,
        currentVersion,
        latestVersion,
        repoUrl,
        releases: [],
      };
    }

    // Current version not found in release list — show all with a note
    return {
      stackName,
      currentVersion,
      latestVersion,
      repoUrl,
      releases,
      versionNotFound: true,
    };
  }

  // No current version label — show recent releases
  return {
    stackName,
    currentVersion: null,
    latestVersion,
    repoUrl,
    releases: releases.slice(0, 5),
    versionNotFound: true,
  };
}
