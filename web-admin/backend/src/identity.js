import { getUserConfig } from "./configRegistry.js";

// `tailscale serve` (not Funnel) injects this header on every proxied
// request -- including the WebSocket upgrade handshake -- identifying the
// connecting Tailscale account, even across a shared/cross-tailnet node.
// Nothing else sits in front of the backend's Unix socket to strip it.
export function getViewerLogin(headers) {
  return headers?.["tailscale-user-login"] || null;
}

// Admin logins are a per-host allowlist in user-config.yaml's web_admin
// block (gitignored, like borg_banner_dismissed already there), since
// "admin" here means "the person who maintains this box," not a role that
// needs to be portable across hosts.
export async function isAdminLogin(login) {
  if (!login) return false;
  const config = await getUserConfig();
  const adminLogins = config.web_admin?.admin_logins || [];
  return adminLogins.includes(login);
}
