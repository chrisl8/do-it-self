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
// /api/v1/request docs) — omit for all.
export async function listRequests(server, { filter, take = 50 } = {}) {
  const params = new URLSearchParams({ take: String(take), skip: "0" });
  if (filter) params.set("filter", filter);
  const data = await seerrFetch(server, `/api/v1/request?${params}`);
  return Array.isArray(data?.results) ? data.results : [];
}
