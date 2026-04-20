import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";

const MESSAGES = {
  none: {
    title: "Borg backup is not configured",
    body: (
      <>
        Your container volumes and databases are not being backed up. Run{" "}
        <code>scripts/setup-borg-backup.sh</code> on the host to configure
        local backups. See <code>docs/MAINTENANCE.md</code> for details.
      </>
    ),
  },
  local_only: {
    title: "Remote borg backup is not running",
    body: (
      <>
        Local backups are current, but remote offsite backups are failing or
        not configured. See the Backups page for details.
      </>
    ),
  },
  remote_only: {
    title: "Local borg backup is not running",
    body: (
      <>
        Remote backups are current, but the local backup is failing. See the
        Backups page for details.
      </>
    ),
  },
};

const BorgNotConfiguredBanner = () => {
  const [state, setState] = useState(null);
  const [sessionHidden, setSessionHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/system/backup-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (j.dismissed) return;
        setState(j.state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (sessionHidden) return null;
  const message = state && MESSAGES[state];
  if (!message) return null;

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      <Alert severity="warning" onClose={() => setSessionHidden(true)}>
        <AlertTitle>{message.title}</AlertTitle>
        {message.body}
      </Alert>
    </Box>
  );
};

export default BorgNotConfiguredBanner;
