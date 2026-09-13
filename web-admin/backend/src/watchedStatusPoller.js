// Cross-references copy-history entries against each client's watched
// snapshot (see mediaStaging.js's buildWatchedSnapshot, read over SSH via
// mediaStagingPush.js's getWatchedSnapshot) so the review dashboard can show
// whether something that was copied has actually been watched.
//
// A movie/episode entry matches the snapshot's rel exactly. A season/series
// entry (a folder, not a single file) is "watched" only once every leaf item
// found under that folder has been played — unknown (null) until at least
// one leaf shows up in the snapshot at all, since that usually just means
// the client hasn't scanned it into Jellyfin yet.

import { listCopyHistory, updateWatchedStatus } from "./copyHistory.js";
import { getWatchedSnapshot, listClientNames } from "./mediaStagingPush.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

let tickTimer = null;
let tickInFlight = false;

function computeWatched(rels, rel) {
  if (!rels) return null;
  if (Object.prototype.hasOwnProperty.call(rels, rel)) return rels[rel];
  const prefix = `${rel}/`;
  const under = Object.entries(rels).filter(([k]) => k.startsWith(prefix));
  if (under.length === 0) return null;
  return under.every(([, played]) => played === true);
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    for (const clientName of await listClientNames()) {
      const snapshot = await getWatchedSnapshot(clientName).catch(() => null);
      if (!snapshot) continue;
      for (const entry of await listCopyHistory({ client: clientName })) {
        if (entry.watched === true) continue; // terminal — no need to re-check
        const watched = computeWatched(snapshot[entry.library], entry.rel);
        if (watched !== entry.watched) {
          await updateWatchedStatus(entry.id, watched);
        }
      }
    }
  } catch (err) {
    console.error("[watchedStatusPoller] tick failed:", err?.message || err);
  } finally {
    tickInFlight = false;
  }
}

async function init() {
  tick();
  tickTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

export default { init, stop };
