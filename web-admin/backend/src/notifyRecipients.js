// Seerr username → notification email mapping.
//
// Jellyseerr has its own per-user email field, but it's the family member's
// own Seerr profile setting — nothing here makes them fill it in. So the
// admin maintains this mapping directly instead of depending on it: a small
// hand-edited (or UI-edited, once a settings dialog exists) block in
// user-config.yaml, read the same way other per-feature config is.

import { getUserConfig } from "./configRegistry.js";

export async function getRecipientEmail(username) {
  if (!username) return null;
  const config = await getUserConfig();
  const recipients = config?.seerrNotify?.recipients;
  if (!recipients || typeof recipients !== "object") return null;
  return recipients[username] || null;
}

export async function listRecipients() {
  const config = await getUserConfig();
  return { ...(config?.seerrNotify?.recipients || {}) };
}
