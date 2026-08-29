const releaseCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Per-stack release-notes source overrides, keyed by compose project (stack) name.
// Many images either carry no org.opencontainers.image.source label, carry one
// that points at a docker-packaging repo with no GitHub Releases, or live in a
// multi-container stack where the label-scan could latch onto a sidecar (db,
// redis) instead of the app. An entry here pins the canonical upstream and
// bypasses the label scan entirely. Values are repo URLs; GitHub and Codeberg/
// Forgejo (Gitea API) hosts are supported — see parseRepo().

// Stacks whose currently-running-version label will never line up with their
// upstream's release tags, no matter how it's normalized -- so a release-notes
// comparison can only ever be misleading or an unhelpful "couldn't find your
// version" dump. Each entry's value is shown to the user as the reason the
// check is unavailable, instead of silently hiding the button.
const DISABLED_STACKS = {
  "minecraft-java":
    'itzg/minecraft-server\'s version label is a Java runtime marker ("java25"), not a Minecraft server version.',
  kopia:
    'The kopia container has no source label; its version label leaks the Ubuntu base image tag (e.g. "22.04"), not Kopia\'s own version.',
};

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

// Pull out the semver-looking core of a version string (e.g. "12.3.3" out of
// "mariadb-12.3.3", or "10.11.11" out of "v10.11.11-202606061137") so current
// vs. release-tag comparisons survive distro prefixes and build suffixes.
// Falls back to normalizeVersion() when no such substring is present.
function versionCore(version) {
  const match = version.match(/\d+(?:\.\d+){1,3}/);
  return match ? match[0] : normalizeVersion(version);
}

// Strip registry/namespace path and any @digest down to "repo:tag", matching
// the LAST_PART derivation in diun/notif/diunUpdate.sh -- that's the format
// pendingUpdateImages entries are stored in, so the two can be compared.
// Docker's own Config.Image omits an implicit ":latest" when the compose
// file pins no tag at all (e.g. "qmcgaw/gluetun"), but DIUN's reported
// reference always includes one -- append it here so a bare-tag image
// doesn't falsely mismatch against its own DIUN entry.
function imageLastPart(image) {
  if (!image) return null;
  const last = image.split("@")[0].split("/").pop();
  return last.includes(":") ? last : `${last}:latest`;
}

export async function getReleaseNotesForStack(
  stackName,
  stackContainers,
  pendingUpdateImages,
) {
  // If the pending-update badge was triggered by an image that isn't the one
  // this function ends up checking against GitHub/Gitea releases (e.g. a VPN
  // sidecar like gluetun bumping its :latest digest in a stack whose "app"
  // container is ungoogled-chromium), checking the app's version alone can
  // truthfully say "already on latest" while an update is still pending --
  // which reads as a flat contradiction. Surface which image actually
  // triggered the badge so the dialog can explain the mismatch instead.
  function withMismatchNote(result, checkedImage) {
    if (!pendingUpdateImages?.length || !checkedImage) return result;
    if (pendingUpdateImages.includes(checkedImage)) return result;
    return {
      ...result,
      pendingUpdateMismatch: {
        checkedImage,
        updatedImages: pendingUpdateImages,
      },
    };
  }

  if (!stackContainers || Object.keys(stackContainers).length === 0) {
    return { stackName, error: "Stack is not running" };
  }

  if (Object.hasOwn(DISABLED_STACKS, stackName)) {
    return { stackName, disabled: true, reason: DISABLED_STACKS[stackName] };
  }

  // A manual override pins the canonical upstream for this stack; otherwise
  // fall back to scanning container OCI labels.
  let sourceUrl = SOURCE_OVERRIDES[stackName] || null;
  const overrideRepo = sourceUrl ? parseRepo(sourceUrl) : null;
  let currentVersion = null;
  let labelSource = null;
  let labelVersion = null;
  let labelImage = null;
  let overrideVersion = null;
  let overrideImage = null;
  for (const container of Object.values(stackContainers)) {
    const labels = container.labels || {};
    const cSource = labels["org.opencontainers.image.source"] || null;
    const cVersion = labels["org.opencontainers.image.version"] || null;
    if (!labelSource && cSource) {
      labelSource = cSource;
      labelVersion = cVersion;
      labelImage = imageLastPart(container.image);
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
        overrideImage = imageLastPart(container.image);
      }
    }
  }
  let checkedImage;
  if (sourceUrl) {
    currentVersion = overrideVersion;
    checkedImage = overrideImage;
  } else {
    // No override: preserve the original pairing of source + version from the
    // same container that carried the source label.
    sourceUrl = labelSource;
    currentVersion = labelVersion;
    checkedImage = labelImage;
  }

  if (!sourceUrl) {
    return withMismatchNote(
      {
        stackName,
        error: "No source repository URL found in container labels",
      },
      checkedImage,
    );
  }

  const parsed = parseRepo(sourceUrl);
  if (!parsed) {
    return withMismatchNote(
      {
        stackName,
        error:
          "Release notes are only available for GitHub- and Codeberg-hosted projects",
        repoUrl: sourceUrl,
      },
      checkedImage,
    );
  }

  const { owner, repo } = parsed;
  const repoUrl =
    parsed.kind === "gitea"
      ? `${parsed.htmlBase}/${owner}/${repo}`
      : `https://github.com/${owner}/${repo}`;

  const releases = await fetchReleases(parsed);

  if (releases.length === 0) {
    return withMismatchNote(
      {
        stackName,
        currentVersion,
        repoUrl,
        releases: [],
        error: "No releases found for this repository",
      },
      checkedImage,
    );
  }

  const latestVersion = releases[0]?.tag;

  // If we know the current version, filter to only show newer releases
  if (currentVersion) {
    const normalizedCurrent = versionCore(currentVersion);
    const currentIndex = releases.findIndex(
      (r) => versionCore(r.tag) === normalizedCurrent,
    );

    if (currentIndex > 0) {
      // Found current version, return everything newer
      return withMismatchNote(
        {
          stackName,
          currentVersion,
          latestVersion,
          repoUrl,
          releases: releases.slice(0, currentIndex),
        },
        checkedImage,
      );
    }

    if (currentIndex === 0) {
      // Already on latest
      return withMismatchNote(
        {
          stackName,
          currentVersion,
          latestVersion,
          repoUrl,
          releases: [],
        },
        checkedImage,
      );
    }

    // Current version not found in release list — show all with a note
    return withMismatchNote(
      {
        stackName,
        currentVersion,
        latestVersion,
        repoUrl,
        releases,
        versionNotFound: true,
      },
      checkedImage,
    );
  }

  // No current version label — show recent releases
  return withMismatchNote(
    {
      stackName,
      currentVersion: null,
      latestVersion,
      repoUrl,
      releases: releases.slice(0, 5),
      versionNotFound: true,
    },
    checkedImage,
  );
}
