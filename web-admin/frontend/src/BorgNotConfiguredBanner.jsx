import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";

const DISMISS_KEY = "borgBannerDismissedAt";
const REMIND_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const BorgNotConfiguredBanner = () => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < REMIND_AFTER_MS) return;

    let cancelled = false;
    fetch("/api/system/backup-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j && j.configured === false) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      <Alert
        severity="warning"
        onClose={() => {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
          setShow(false);
        }}
      >
        <AlertTitle>Borg backup is not configured</AlertTitle>
        Your container volumes and databases are not being backed up. Run{" "}
        <code>scripts/setup-borg-backup.sh</code> on the host to configure
        local backups. See <code>docs/MAINTENANCE.md</code> for details.
      </Alert>
    </Box>
  );
};

export default BorgNotConfiguredBanner;
