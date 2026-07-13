import React, { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";

const KEYS_ADMIN_URL = "https://login.tailscale.com/admin/settings/keys";

// App-wide banner that surfaces Tailscale credentials that are expiring soon or
// already expired/rejected. It reads the same `tailscalePreflightStatus` the
// dashboard's preflight panel uses; the backend refreshes that status on
// startup and on an interval, so this appears without the user clicking
// "Re-check". Two calls to action: renew the key in Tailscale, then paste it
// into this web admin (deep-linked to the shared-secrets fields).
const CredentialWarningBanner = ({ tailscalePreflightStatus }) => {
  const [sessionHidden, setSessionHidden] = useState(false);

  const status = tailscalePreflightStatus;
  const checks = Array.isArray(status?.checks) ? status.checks : [];

  // Hard credential failures (expired or 401-rejected) — actively breaking.
  const expired = checks.filter(
    (c) => c && c.ok === false && !c.advisory && c.credential,
  );
  // Advisory warnings for credentials still valid but nearing expiry.
  const expiring = checks.filter(
    (c) =>
      c &&
      c.advisory &&
      !c.ok &&
      c.credential &&
      typeof c.expiresInDays === "number",
  );

  if (expired.length === 0 && expiring.length === 0) return null;

  const severity = expired.length > 0 ? "error" : "warning";
  // An actively-broken (expired) credential is not dismissable — it stays put
  // until fixed. A soon-to-expire advisory can be hidden for the session, but a
  // later escalation to "expired" ignores that and shows again.
  if (sessionHidden && severity !== "error") return null;

  const title =
    severity === "error"
      ? "Tailscale credential expired — container starts and updates are failing"
      : "Tailscale credential expiring soon";

  // All Tailscale keys renew at the same admin page; prefer a check's fixUrl.
  const renewUrl =
    expired.find((c) => c.fixUrl)?.fixUrl ||
    expiring.find((c) => c.fixUrl)?.fixUrl ||
    KEYS_ADMIN_URL;

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      <Alert
        severity={severity}
        onClose={
          severity === "error" ? undefined : () => setSessionHidden(true)
        }
      >
        <AlertTitle>{title}</AlertTitle>
        <Box component="ul" sx={{ m: 0, mb: 1, pl: 3 }}>
          {expired.map((c, i) => (
            <li key={`expired-${c.credential}-${i}`}>
              <strong>{c.credential}:</strong> {c.message}
            </li>
          ))}
          {expiring.map((c, i) => (
            <li key={`expiring-${c.credential}-${i}`}>{c.message}</li>
          ))}
        </Box>
        <Stack direction="row" spacing={2} flexWrap="wrap">
          <Link href={renewUrl} target="_blank" rel="noopener noreferrer">
            Renew in Tailscale ↗
          </Link>
          <Link component={RouterLink} to="/container-config#shared-secrets">
            Update in Web Admin →
          </Link>
        </Stack>
      </Alert>
    </Box>
  );
};

export default CredentialWarningBanner;
