// Seerr (Jellyseerr) request ledger — runs on neuromancer, where Seerr is
// co-located and reachable over Tailscale.
//
// Two ways requests get into the ledger:
//   1. A webhook Jellyseerr POSTs to us on request/media state changes
//      (primary, event-driven, near-instant).
//   2. A periodic reconciliation poll of Seerr's own /api/v1/request
//      (safety net for missed/failed webhook deliveries).
//
// The ledger's job is to answer one question when a copy finishes: "was this
// requested, and if so, by whom, and have we told them it's ready?" See
// matchAndNotify(), called from copyHistory.recordCopy().
//
// IMPORTANT — webhook payload shape: Jellyseerr's webhook body is itself a
// user-editable JSON template (Settings → Notifications → Webhook), not a
// fixed API contract. parseWebhookPayload() below expects Jellyseerr's
// documented DEFAULT template shape (nested "media"/"request" objects, see
// docs/MEDIA_STAGING_SETUP.md for the exact template to paste into that
// settings screen). CONFIRM with the "Test" button in that settings screen
// before relying on this in production — this hasn't been verified against a
// live payload yet.

import os from "os";
import { join } from "path";
import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { getUserConfig } from "./configRegistry.js";
import { getSecret, setSecret, createFolder } from "./infisicalClient.js";
import {
  listRequests as listSeerrApiRequests,
  getMediaTitle,
} from "./seerrClient.js";
import { getRecipientEmail } from "./notifyRecipients.js";
import { sendReadyEmail } from "./emailNotifier.js";
import { linkSeerrRequest } from "./copyHistory.js";

const LEDGER_DIR = join(os.homedir(), "media-staging", "history");
const LEDGER_FILE = join(LEDGER_DIR, "seerr-requests.json");
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const secretCache = new Map();

let tickTimer = null;
let tickInFlight = false;

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

async function getSecretCached(path, key) {
  if (!path || !key) return null;
  const cacheKey = `${path}/${key}`;
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await getSecret(key, path);
    if (!value) return null;
    secretCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
    });
    return value;
  } catch {
    return null;
  }
}

// ── config ──────────────────────────────────────────────────────
async function readConfig() {
  const config = await getUserConfig();
  const sn = config?.seerrNotify;
  if (!sn || !sn.enabled || !sn.base_url) return null;
  return {
    baseUrl: sn.base_url,
    apiKeyPath: sn.api_key_infisical_path || "/seerrNotify",
    apiKeyName: sn.api_key_infisical_key || "SEERR_API_KEY",
    webhookSecretKey: sn.webhook_shared_secret_infisical_key || null,
    pollIntervalMs: (sn.poll_interval_seconds || 600) * 1000,
  };
}

async function seerrServer(cfg) {
  const apiKey = await getSecretCached(cfg.apiKeyPath, cfg.apiKeyName);
  if (!apiKey) throw new Error("Seerr API key unavailable (Infisical)");
  return { baseUrl: cfg.baseUrl, apiKey };
}

// In-app secret injection (no direct Infisical UI access needed) — same
// pattern as mediaStaging.js's setApiKeys(). Only requires the `seerrNotify`
// block to exist in user-config.yaml (not necessarily `enabled: true` yet),
// since you'll typically set the key before flipping enabled on.
export async function setApiKey({ apiKey, webhookSecret }) {
  const config = await getUserConfig();
  const sn = config?.seerrNotify;
  if (!sn) {
    return {
      ok: false,
      error: "add a seerrNotify: block to user-config.yaml first",
    };
  }
  const path = sn.api_key_infisical_path || "/seerrNotify";
  const apiKeyName = sn.api_key_infisical_key || "SEERR_API_KEY";
  const webhookSecretName =
    sn.webhook_shared_secret_infisical_key || "SEERR_WEBHOOK_SECRET";
  const folder = path.replace(/^\/+/, "");
  if (folder) await createFolder(folder, "/").catch(() => {});
  const written = [];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    await setSecret(apiKeyName, apiKey, path);
    secretCache.delete(`${path}/${apiKeyName}`);
    written.push(apiKeyName);
  }
  if (typeof webhookSecret === "string" && webhookSecret.length > 0) {
    await setSecret(webhookSecretName, webhookSecret, path);
    secretCache.delete(`${path}/${webhookSecretName}`);
    written.push(webhookSecretName);
  }
  if (written.length === 0) return { ok: false, error: "no values provided" };
  return { ok: true, keys: written, path };
}

// ── ledger I/O (same atomic-array-file pattern as copyHistory.js) ─
async function readLedger() {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_FILE, "utf8"));
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch {
    return [];
  }
}

async function writeLedger(requests) {
  await mkdir(LEDGER_DIR, { recursive: true });
  const tmp = `${LEDGER_FILE}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, requests }, null, 2),
    "utf8",
  );
  await rename(tmp, LEDGER_FILE);
}

async function upsert(partial) {
  if (!partial.seerrRequestId) return null;
  const requests = await readLedger();
  const idx = requests.findIndex(
    (r) => r.seerrRequestId === partial.seerrRequestId,
  );
  const merged =
    idx === -1
      ? {
          seerrRequestId: partial.seerrRequestId,
          tmdbId: null,
          tvdbId: null,
          mediaType: null,
          title: null,
          season: null,
          requestedByUsername: null,
          requestedByEmail: null,
          status: "pending",
          createdEpoch: nowEpoch(),
          approvedEpoch: null,
          availableEpoch: null,
          copiedEpoch: null,
          notifiedEpoch: null,
          ...partial,
        }
      : { ...requests[idx], ...partial };

  // Notify as soon as the file lands on neuromancer (Seerr's "available"),
  // not when the manual deepthought copy finishes -- deepthought is a
  // pure receiver with no view into neuromancer, so the person has to be
  // told to go trigger that copy themselves via deepthought's panel; a
  // "ready" email that fires only after they've already done that manually
  // tells them nothing they don't know.
  if (merged.availableEpoch && !merged.notifiedEpoch) {
    const toEmail = await getRecipientEmail(merged.requestedByUsername);
    if (toEmail) {
      const result = await sendReadyEmail({
        toEmail,
        title: merged.title,
        season: merged.season,
      }).catch((err) => ({ ok: false, error: err?.message }));
      if (result.ok) {
        merged.notifiedEpoch = nowEpoch();
      } else {
        console.error("[seerrLedger] sendReadyEmail failed:", result.error);
      }
    } else {
      console.warn(
        `[seerrLedger] no mapped email for Seerr user "${merged.requestedByUsername}" -- skipping notification for request ${merged.seerrRequestId}`,
      );
    }
  }

  if (idx === -1) requests.push(merged);
  else requests[idx] = merged;
  await writeLedger(requests);
  return merged;
}

// ── webhook payload parsing ─────────────────────────────────────
// Best-effort season extraction: Jellyseerr's default template doesn't carry
// a season number as its own field for season-only TV requests — it shows up
// (if at all) as a free-text "extra" entry. This is a heuristic, not a
// guarantee; unmatched-season copies still show up in the dashboard, just
// without a season-specific link.
function extractSeason(extra) {
  if (!Array.isArray(extra)) return null;
  for (const e of extra) {
    const name = String(e?.name || "").toLowerCase();
    if (name.includes("season")) {
      const m = String(e?.value || "").match(/\d+/);
      if (m) return Number(m[0]);
    }
  }
  return null;
}

function statusFieldsFor(notificationType) {
  switch (notificationType) {
    case "MEDIA_APPROVED":
    case "MEDIA_AUTO_APPROVED":
      return { status: "approved", approvedEpoch: nowEpoch() };
    case "MEDIA_AVAILABLE":
      return { status: "available", availableEpoch: nowEpoch() };
    case "MEDIA_DECLINED":
      return { status: "declined" };
    case "MEDIA_FAILED":
      return { status: "failed" };
    default:
      return { status: "pending" };
  }
}

export function parseWebhookPayload(body) {
  // Primary shape: Jellyseerr's documented default webhook template, with
  // nested "media"/"request" objects.
  const media = body?.media;
  const request = body?.request;
  const requestId = request?.request_id ?? body?.request_id;
  if (!requestId) return null;
  const tmdbId = Number(media?.tmdbId ?? body?.tmdbId) || null;
  const tvdbId = Number(media?.tvdbId ?? body?.tvdbId) || null;
  return {
    seerrRequestId: String(requestId),
    tmdbId,
    tvdbId,
    mediaType: media?.media_type ?? body?.media_type ?? null,
    title: body?.subject ?? null,
    season: extractSeason(body?.extra),
    requestedByUsername:
      request?.requestedBy_username ?? body?.requestedBy_username ?? null,
    requestedByEmail:
      request?.requestedBy_email ?? body?.requestedBy_email ?? null,
    ...statusFieldsFor(body?.notification_type),
  };
}

export async function upsertFromWebhook(body, headers = {}) {
  const cfg = await readConfig();
  if (!cfg) return { ok: false, error: "seerrNotify not configured" };
  if (cfg.webhookSecretKey) {
    const expected = await getSecretCached(
      cfg.apiKeyPath,
      cfg.webhookSecretKey,
    );
    const provided = headers["authorization"] || headers["Authorization"];
    if (expected && provided !== expected) {
      return { ok: false, error: "invalid webhook secret" };
    }
  }
  if (body?.notification_type === "TEST_NOTIFICATION") {
    console.log("[seerrLedger] webhook test notification received OK");
    return { ok: true, test: true };
  }
  const parsed = parseWebhookPayload(body);
  if (!parsed) {
    console.warn(
      "[seerrLedger] unrecognized webhook payload shape, ignoring:",
      JSON.stringify(body).slice(0, 2000),
    );
    return { ok: false, error: "unrecognized payload shape" };
  }
  await upsert(parsed);
  return { ok: true };
}

// ── reconciliation poll ─────────────────────────────────────────
function normalizeApiRequest(r) {
  // Shape verified live against this instance's /api/v1/request (2026-09-11):
  // this Seerr is Jellyfin-authed, so requestedBy has no `username`/
  // `plexUsername` — the real identity is `jellyfinUsername`. Its `email`
  // field is just a lowercase-username placeholder for every account except
  // the admin's real one, which is exactly why notifyRecipients.js exists
  // instead of trusting Seerr's own email field.
  const requestId = r?.id;
  if (!requestId) return null;
  const media = r?.media || {};
  const statusMap = { 1: "pending", 2: "approved", 3: "declined" };
  return {
    seerrRequestId: String(requestId),
    tmdbId: media.tmdbId ? Number(media.tmdbId) : null,
    tvdbId: media.tvdbId ? Number(media.tvdbId) : null,
    mediaType: media.mediaType || null,
    title: r?.media?.title || r?.title || null,
    season:
      Array.isArray(r?.seasons) && r.seasons.length === 1
        ? (r.seasons[0]?.seasonNumber ?? null)
        : null,
    requestedByUsername:
      r?.requestedBy?.jellyfinUsername ||
      r?.requestedBy?.username ||
      r?.requestedBy?.plexUsername ||
      null,
    requestedByEmail: r?.requestedBy?.email || null,
    status: statusMap[r?.status] || "pending",
    availableEpoch: media.status === 5 ? nowEpoch() : null,
  };
}

async function pollOnce() {
  const cfg = await readConfig();
  if (!cfg) return;
  const server = await seerrServer(cfg);
  const apiRequests = await listSeerrApiRequests(server, { take: 50 });
  const existing = await readLedger();
  for (const raw of apiRequests) {
    const normalized = normalizeApiRequest(raw);
    if (!normalized) continue;
    // /api/v1/request never carries a title (see seerrClient.js), and
    // `upsert`'s merge would otherwise overwrite an already-known title
    // (e.g. from a webhook) with this null on every poll — always resolve a
    // real one before upserting, reusing whatever's already in the ledger
    // rather than re-fetching every cycle.
    if (!normalized.title) {
      const prior = existing.find(
        (r) => r.seerrRequestId === normalized.seerrRequestId,
      );
      normalized.title =
        prior?.title ||
        (await getMediaTitle(server, {
          mediaType: normalized.mediaType,
          tmdbId: normalized.tmdbId,
        }).catch(() => null));
    }
    await upsert(normalized);
  }
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await pollOnce();
  } catch (err) {
    console.error("[seerrLedger] poll failed:", err?.message || err);
  } finally {
    tickInFlight = false;
  }
}

export async function init() {
  const cfg = await readConfig();
  if (!cfg) return; // feature not configured — no-op, matches mediaStaging's gating
  if (tickTimer) return;
  await tick();
  tickTimer = setInterval(tick, cfg.pollIntervalMs);
}

export function stop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

// ── matching ────────────────────────────────────────────────────
// Called by copyHistory.recordCopy() right after a copy lands. Matches
// primarily on tmdbId/tvdbId (falling back through whichever id the copy
// actually resolved), plus season number when both sides have one, against
// any ledger request not yet marked copied. On a match: marks the request
// copied and links the copy-history row back to the request. The "ready"
// email already went out when the item became available on neuromancer
// (see upsert()) -- by the time a copy lands, the person who ran it already
// knows, since they're the one who triggered it from deepthought's panel.
export async function matchAndNotify(copyHistoryEntry) {
  const mediaId = copyHistoryEntry?.seerrMediaId;
  if (!mediaId || (!mediaId.tmdbId && !mediaId.tvdbId)) return; // nothing to match on

  const requests = await readLedger();
  const candidate = requests.find((r) => {
    if (r.status === "copied") return false;
    const idMatch =
      (mediaId.tmdbId && r.tmdbId === mediaId.tmdbId) ||
      (mediaId.tvdbId && r.tvdbId === mediaId.tvdbId);
    if (!idMatch) return false;
    // A whole-series copy (no season on the copy side) matches any request
    // for that series; a season-specific copy only matches a request for
    // the same season (or a whole-series request, season == null).
    if (mediaId.season != null && r.season != null) {
      return r.season === mediaId.season;
    }
    return true;
  });
  if (!candidate) return;

  candidate.status = "copied";
  candidate.copiedEpoch = nowEpoch();

  const idx = requests.findIndex(
    (r) => r.seerrRequestId === candidate.seerrRequestId,
  );
  requests[idx] = candidate;
  await writeLedger(requests);

  await linkSeerrRequest(copyHistoryEntry.id, {
    seerrRequestId: candidate.seerrRequestId,
    notifiedEpoch: candidate.notifiedEpoch,
  });
}

export async function listLedgerRequests({ status } = {}) {
  const requests = await readLedger();
  return status ? requests.filter((r) => r.status === status) : requests;
}

export default { init, stop };
