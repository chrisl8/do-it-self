// Thin REST client for Jellyseerr's API, following jellyfinClient.js's
// jfFetch() template (native fetch, timeout, header auth, throw on non-2xx).
//
// Jellyseerr is reachable directly over Tailscale (its tailscale-config
// proxies the whole app, including /api/v1/*, at the container's Tailscale
// hostname) — no docker exec/cp workaround needed since web-admin runs on
// the host via PM2, not inside a container.

const REQUEST_TIMEOUT_MS = 20 * 1000;

async function seerrFetch(server, urlPath) {
  if (!server?.baseUrl || !server?.apiKey) {
    throw new Error("seerr server baseUrl/apiKey not configured");
  }
  const base = server.baseUrl.replace(/\/+$/, "");
  const url = `${base}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-Api-Key": server.apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Seerr ${res.status} for ${urlPath}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// filter: "pending" | "approved" | "available" | "declined" | ... (see Seerr's
// /api/v1/request docs) — omit for all. Pages through the full result set:
// a single take:50 page used to silently skip anything older than the 50
// most recent requests, so an item that became available and then sat
// un-copied while newer requests piled up in front of it would never be
// seen again by the reconciliation poll -- it fell off the page forever.
export async function listRequests(server, { filter, pageSize = 50 } = {}) {
  const results = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      take: String(pageSize),
      skip: String(skip),
    });
    if (filter) params.set("filter", filter);
    const data = await seerrFetch(server, `/api/v1/request?${params}`);
    const page = Array.isArray(data?.results) ? data.results : [];
    results.push(...page);
    const total = data?.pageInfo?.results ?? results.length;
    skip += pageSize;
    if (page.length === 0 || skip >= total) break;
  }
  return results;
}

// The /api/v1/request list doesn't carry a title (verified live 2026-09-13) —
// only the webhook payload's `subject` does. Movies use `title`, TV shows use
// `name` (standard TMDB convention).
export async function getMediaTitle(server, { mediaType, tmdbId }) {
  if (!tmdbId || (mediaType !== "movie" && mediaType !== "tv")) return null;
  const data = await seerrFetch(server, `/api/v1/${mediaType}/${tmdbId}`);
  return (mediaType === "movie" ? data?.title : data?.name) || null;
}
