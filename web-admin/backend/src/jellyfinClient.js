// Jellyfin REST client for the Media Staging feature.
//
// Pure, stateless helpers against a remote Jellyfin server (neuromancer's, in
// the deepthought use case). Each call takes a `{ baseUrl, apiKey }` server
// object so the same module can talk to the source Jellyfin (listing) and the
// local Jellyfin (post-copy refresh). Auth is the `X-Emby-Token` header.
//
// The crux is path mapping. Jellyfin returns each item's `Path` /
// `MediaSources[].Path` as the path *inside the Jellyfin container*
// (e.g. /media/movies/...), NOT a host path. computeRel() strips the
// configured `jellyfin_path_prefix` to a library-relative path; the sender
// then rebuilds the rsync source from its own `source_root` and the receiver's
// `dest_root`, so the layout mirrors exactly and the local Jellyfin recognizes
// the same structure.

import path from "path";

const REQUEST_TIMEOUT_MS = 20 * 1000;

// ── Low-level fetch ─────────────────────────────────────────────
async function jfFetch(server, urlPath, { raw = false } = {}) {
  if (!server?.baseUrl || !server?.apiKey) {
    throw new Error("jellyfin server baseUrl/apiKey not configured");
  }
  const base = server.baseUrl.replace(/\/+$/, "");
  const url = `${base}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-Emby-Token": server.apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Jellyfin ${res.status} for ${urlPath}`);
    }
    return raw ? res : res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Identity ────────────────────────────────────────────────────
// Resolve a user id so item queries return UserData (watched status). Prefers
// an administrator. Returns null if none can be resolved (the UI then omits
// the watched badge rather than failing).
export async function getAdminUserId(server) {
  const users = await jfFetch(server, "/Users");
  if (!Array.isArray(users) || users.length === 0) return null;
  const admin = users.find((u) => u?.Policy?.IsAdministrator);
  return (admin || users[0])?.Id || null;
}

// ── Libraries ───────────────────────────────────────────────────
// /Library/VirtualFolders gives CollectionType, the real on-disk Locations,
// and ItemId (usable as ParentId for item queries).
export async function getVirtualFolders(server) {
  const folders = await jfFetch(server, "/Library/VirtualFolders");
  return (Array.isArray(folders) ? folders : []).map((f) => ({
    name: f.Name,
    collectionType: f.CollectionType || null,
    locations: Array.isArray(f.Locations) ? f.Locations : [],
    itemId: f.ItemId || null,
  }));
}

// ── Items ───────────────────────────────────────────────────────
function imageTag(item) {
  return item?.ImageTags?.Primary || null;
}

// List the top-level items of a library (Movies or Series). For movies we get
// the file Path/Size; series have no single file (size is summed lazily when a
// series is expanded or staged).
export async function listLibraryItems(server, { parentId, userId, itemType }) {
  const params = new URLSearchParams({
    ParentId: parentId,
    IncludeItemTypes: itemType, // "Movie" | "Series"
    Recursive: "true",
    Fields: "Path,MediaSources,ProductionYear",
    SortBy: "SortName",
    SortOrder: "Ascending",
    EnableUserData: "true",
    EnableImageTypes: "Primary",
  });
  if (userId) params.set("userId", userId);
  const data = await jfFetch(server, `/Items?${params}`);
  return (data?.Items || []).map((it) => {
    const source = it.MediaSources?.[0];
    return {
      id: it.Id,
      name: it.Name,
      year: it.ProductionYear || null,
      type: it.Type,
      path: source?.Path || it.Path || null,
      sizeBytes: typeof source?.Size === "number" ? source.Size : null,
      posterTag: imageTag(it),
      played: it.UserData?.Played ?? null,
      unplayedItemCount: it.UserData?.UnplayedItemCount ?? null,
    };
  });
}

// Fetch a single item by id (authoritative server-side path resolution for
// the copy engine — never trust a client-supplied path).
export async function getItemById(
  server,
  { id, userId, fields = "Path,MediaSources,ProductionYear" },
) {
  const params = new URLSearchParams({ Ids: id, Fields: fields });
  if (userId) params.set("userId", userId);
  const data = await jfFetch(server, `/Items?${params}`);
  return data?.Items?.[0] || null;
}

export async function listSeasons(server, { seriesId, userId }) {
  const params = new URLSearchParams({ Fields: "Path" });
  if (userId) params.set("userId", userId);
  const data = await jfFetch(
    server,
    `/Shows/${encodeURIComponent(seriesId)}/Seasons?${params}`,
  );
  return (data?.Items || []).map((s) => ({
    id: s.Id,
    name: s.Name,
    indexNumber: s.IndexNumber ?? null,
    path: s.Path || null,
    played: s.UserData?.Played ?? null,
    unplayedItemCount: s.UserData?.UnplayedItemCount ?? null,
  }));
}

export async function listEpisodes(server, { seriesId, seasonId, userId }) {
  const params = new URLSearchParams({
    Fields: "Path,MediaSources",
    EnableUserData: "true",
  });
  if (seasonId) params.set("seasonId", seasonId);
  if (userId) params.set("userId", userId);
  const data = await jfFetch(
    server,
    `/Shows/${encodeURIComponent(seriesId)}/Episodes?${params}`,
  );
  return (data?.Items || []).map((e) => {
    const source = e.MediaSources?.[0];
    return {
      id: e.Id,
      name: e.Name,
      indexNumber: e.IndexNumber ?? null,
      seasonId: e.SeasonId || null,
      parentIndexNumber: e.ParentIndexNumber ?? null,
      path: source?.Path || e.Path || null,
      sizeBytes: typeof source?.Size === "number" ? source.Size : null,
      played: e.UserData?.Played ?? null,
    };
  });
}

// Sum the byte sizes of every episode of a series (optionally one season).
// Used to size a whole-series or whole-season stage request.
export async function sumSeriesBytes(server, { seriesId, seasonId, userId }) {
  const episodes = await listEpisodes(server, { seriesId, seasonId, userId });
  return episodes.reduce(
    (acc, e) => acc + (typeof e.sizeBytes === "number" ? e.sizeBytes : 0),
    0,
  );
}

// ── Poster proxy ────────────────────────────────────────────────
// Returns the raw fetch Response so the backend can stream the image bytes to
// the browser without ever exposing the API key.
export async function getPrimaryImageResponse(
  server,
  itemId,
  { maxWidth } = {},
) {
  const params = new URLSearchParams();
  if (maxWidth) params.set("maxWidth", String(maxWidth));
  const qs = params.toString();
  return jfFetch(
    server,
    `/Items/${encodeURIComponent(itemId)}/Images/Primary${qs ? `?${qs}` : ""}`,
    { raw: true },
  );
}

// ── Library refresh (local Jellyfin, after a copy) ──────────────
export async function refreshLibrary(server) {
  // POST /Library/Refresh kicks a full scan. Fire-and-forget; Jellyfin queues
  // it. We use fetch directly because jfFetch is GET-oriented.
  const base = server.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/Library/Refresh`, {
      method: "POST",
      headers: { "X-Emby-Token": server.apiKey },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Jellyfin refresh ${res.status}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// ── Path mapping ────────────────────────────────────────────────
function stripTrailingSlash(p) {
  return p.replace(/\/+$/, "");
}

// Given a Jellyfin (container) path and a library config, compute the relative
// path under the library root. Throws if the path doesn't sit under the
// configured prefix (the #1 correctness guard — surfaces a clear per-item error
// instead of copying from the wrong place).
export function relUnderPrefix(jellyfinPath, libraryCfg) {
  if (!jellyfinPath) throw new Error("item has no on-disk path");
  const prefix = stripTrailingSlash(libraryCfg.jellyfin_path_prefix || "");
  if (!prefix) throw new Error("library jellyfin_path_prefix not configured");
  if (jellyfinPath !== prefix && !jellyfinPath.startsWith(prefix + "/")) {
    throw new Error(
      `path "${jellyfinPath}" is not under jellyfin_path_prefix "${prefix}"`,
    );
  }
  return jellyfinPath.slice(prefix.length).replace(/^\/+/, "");
}

// Compute the path of an item RELATIVE to its library root — the unit of
// transfer that both hosts agree on. The receiver (deepthought) computes it
// from the Jellyfin path; it ships in the job; the sender (neuromancer) maps
// it to its own source_root and to the receiver's dest_root. Keeping only the
// relative path means neither side needs the other's absolute filesystem
// layout.
//
//   jellyfinPath — the item's container Path (file for movie/episode; folder
//                  for series/season)
//   useParentDir — for a movie the Path is the video FILE; we copy its
//                  containing folder so sidecars (.nfo, subs, posters) come
//                  along. Episodes copy the single file; series/season the
//                  Path is already the folder.
//
// rsync recreates this full <rel> under the dest root via a "<root>/./<rel>"
// --relative pivot, so the layout mirrors and the receiver's Jellyfin
// recognizes it.
export function computeRel({ jellyfinPath, libraryCfg, useParentDir = false }) {
  let rel = relUnderPrefix(jellyfinPath, libraryCfg);
  if (useParentDir) {
    const dir = path.posix.dirname(rel);
    // dir === "." means the file sits directly in the library root (no movie
    // folder); fall back to copying just the file.
    if (dir && dir !== ".") rel = dir;
  }
  if (!rel) throw new Error("computed empty relative path");
  return rel;
}

export { stripTrailingSlash };
