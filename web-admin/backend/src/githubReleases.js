const releaseCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function parseGitHubRepo(sourceUrl) {
  if (!sourceUrl) return null;
  const match = sourceUrl.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function fetchReleases(owner, repo) {
  const cacheKey = `${owner}/${repo}`;
  const cached = releaseCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.releases;
  }

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

  const releases = data
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || "",
      bodyHtml: r.body_html || "",
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
    }));

  releaseCache.set(cacheKey, { releases, fetchedAt: Date.now() });

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining) {
    console.log(`[GitHub API] Rate limit remaining: ${remaining}`);
  }

  return releases;
}

function normalizeVersion(version) {
  return version.replace(/^v/, "").toLowerCase();
}

export async function getReleaseNotesForStack(stackName, stackContainers) {
  if (!stackContainers || Object.keys(stackContainers).length === 0) {
    return { stackName, error: "Stack is not running" };
  }

  // Find the first container with an OCI source label
  let sourceUrl = null;
  let currentVersion = null;
  for (const container of Object.values(stackContainers)) {
    const labels = container.labels || {};
    if (labels["org.opencontainers.image.source"]) {
      sourceUrl = labels["org.opencontainers.image.source"];
      currentVersion = labels["org.opencontainers.image.version"] || null;
      break;
    }
  }

  if (!sourceUrl) {
    return {
      stackName,
      error: "No source repository URL found in container labels",
    };
  }

  const parsed = parseGitHubRepo(sourceUrl);
  if (!parsed) {
    return {
      stackName,
      error: "Release notes are only available for GitHub-hosted projects",
      repoUrl: sourceUrl,
    };
  }

  const { owner, repo } = parsed;
  const repoUrl = `https://github.com/${owner}/${repo}`;

  const releases = await fetchReleases(owner, repo);

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
