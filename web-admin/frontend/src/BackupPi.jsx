import React, { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Spinner from "@mui/material/CircularProgress";
import useBackupPi from "./hooks/useBackupPi";
import LogOutput from "./LogOutput";

const ACTIONS = [
  {
    name: "restart-kopia",
    label: "Restart Kopia server",
    confirmText: "Restart the Kopia server on the Pi?",
    danger: false,
  },
  {
    name: "apt-upgrade",
    label: "apt update + upgrade",
    confirmText:
      "Run apt update and apt-get upgrade -y on the Pi? This may take a few minutes.",
    danger: false,
  },
  {
    name: "borg-check",
    label: "Borg check",
    confirmText:
      "Run a full borg integrity check? This can take a while on large repos.",
    danger: false,
  },
  {
    name: "borg-prune",
    label: "Borg prune",
    confirmText:
      "Run borg prune + compact now? Old archives outside the retention policy will be deleted permanently.",
    danger: true,
  },
  {
    name: "reboot",
    label: "Reboot Pi",
    confirmText:
      "Reboot the Pi? The SSH connection will drop and the Pi will be unreachable for ~30 seconds.",
    danger: true,
  },
];

const formatBytes = (kb) => {
  if (!kb || kb < 0) return "—";
  const gb = kb / (1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TiB`;
  if (gb >= 1) return `${gb.toFixed(1)} GiB`;
  const mb = kb / 1024;
  return `${mb.toFixed(0)} MiB`;
};

const formatDuration = (seconds) => {
  if (!seconds || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const formatRelativeAge = (epochSeconds, nowEpoch) => {
  if (!epochSeconds) return "—";
  const ageSec = (nowEpoch || Math.floor(Date.now() / 1000)) - epochSeconds;
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
};

const ageHours = (iso) => {
  if (!iso) return null;
  // Borg --format {time} typically emits a human-readable form; try parsing.
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / 3600000;
};

const archiveAgeColor = (hours) => {
  if (hours === null) return "default";
  if (hours < 24) return "success";
  if (hours < 48) return "warning";
  return "error";
};

const StatusCard = ({ status }) => {
  if (!status) {
    return (
      <Card>
        <CardContent>
          <Typography>Loading…</Typography>
        </CardContent>
      </Card>
    );
  }
  if (!status.enabled) {
    return (
      <Alert severity="info">
        Backup Pi is not configured. Add a <code>backuppi:</code> section to{" "}
        <code>~/containers/user-config.yaml</code> with{" "}
        <code>enabled: true</code>, <code>host</code>, <code>ssh_user</code>,
        and <code>ssh_key_path</code>. See{" "}
        <code>docs/SETUP-BACKUP-PI.md</code> for the full setup.
      </Alert>
    );
  }
  if (!status.reachable) {
    return (
      <Alert severity="error">
        <Typography variant="body2">
          Pi unreachable: {status.error || "unknown error"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Last attempt:{" "}
          {status.fetched_epoch
            ? new Date(status.fetched_epoch * 1000).toLocaleString()
            : "never"}
        </Typography>
      </Alert>
    );
  }

  const archiveAge = ageHours(status.borg?.last_archive_iso);
  const tsConnected = status.tailscale?.backend_state === "Running";
  const kopiaActive = status.kopia?.service_active === "active";

  return (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={2} mb={2}>
          <Typography variant="h6">{status.hostname || "backup-pi"}</Typography>
          <Chip
            label={tsConnected ? "Tailscale up" : `Tailscale: ${status.tailscale?.backend_state || "?"}`}
            color={tsConnected ? "success" : "error"}
            size="small"
          />
          <Chip
            label={kopiaActive ? "Kopia: active" : `Kopia: ${status.kopia?.service_active || "?"}`}
            color={kopiaActive ? "success" : "warning"}
            size="small"
          />
          <Chip
            label={
              archiveAge === null
                ? "No borg archives yet"
                : `Last borg: ${formatRelativeAge(
                    Math.floor(Date.parse(status.borg.last_archive_iso) / 1000),
                    status.now_epoch,
                  )}`
            }
            color={archiveAgeColor(archiveAge)}
            size="small"
          />
        </Stack>

        {status.drive?.mounted ? (
          <Box>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">
                Disk: {formatBytes(status.drive.used_kb)} of{" "}
                {formatBytes(status.drive.size_kb)} used (
                {formatBytes(status.drive.avail_kb)} free)
              </Typography>
              <Typography variant="body2">{status.drive.percent}%</Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, status.drive.percent || 0)}
              color={
                status.drive.percent >= 90
                  ? "error"
                  : status.drive.percent >= 75
                    ? "warning"
                    : "primary"
              }
              sx={{ mt: 0.5, height: 8, borderRadius: 1 }}
            />
            <Typography variant="caption" color="text.secondary">
              Mounted at {status.drive.mount_point}
            </Typography>
          </Box>
        ) : (
          <Alert severity="error" sx={{ mt: 1 }}>
            Backup drive is NOT mounted.
          </Alert>
        )}

        <Stack direction="row" spacing={3} mt={2} flexWrap="wrap">
          <Typography variant="caption" color="text.secondary">
            Uptime: {formatDuration(status.uptime_seconds)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Tailscale IP: {status.tailscale?.ip || "—"}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Health check:{" "}
            {status.health?.last_check_epoch
              ? formatRelativeAge(
                  status.health.last_check_epoch,
                  status.now_epoch,
                )
              : "never"}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Status fetched:{" "}
            {status.fetched_epoch
              ? formatRelativeAge(status.fetched_epoch)
              : "—"}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
};

const BackupPi = () => {
  const {
    status,
    actionInFlight,
    output,
    lastResult,
    runAction,
    clearOutput,
  } = useBackupPi();
  const [confirmAction, setConfirmAction] = useState(null);

  const piDisabled = !status || !status.enabled || !status.reachable;
  const buttonsDisabled = piDisabled || !!actionInFlight;

  const outputText = useMemo(
    () => output.map((c) => c.chunk).join(""),
    [output],
  );

  const handleConfirm = () => {
    if (!confirmAction) return;
    runAction(confirmAction.name);
    setConfirmAction(null);
  };

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="h5">Backup Pi</Typography>

      <StatusCard status={status} />

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Actions
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {ACTIONS.map((a) => (
              <Button
                key={a.name}
                variant={a.danger ? "outlined" : "contained"}
                color={a.danger ? "error" : "primary"}
                disabled={buttonsDisabled}
                onClick={() => setConfirmAction(a)}
              >
                {actionInFlight === a.name ? (
                  <Spinner size={18} sx={{ mr: 1 }} />
                ) : null}
                {a.label}
              </Button>
            ))}
            <Button
              variant="text"
              disabled={!output.length && !lastResult}
              onClick={clearOutput}
            >
              Clear output
            </Button>
          </Stack>
          {lastResult && (
            <Alert
              severity={lastResult.success ? "success" : "error"}
              sx={{ mt: 2 }}
            >
              <strong>{lastResult.action}</strong>:{" "}
              {lastResult.success ? "completed" : "failed"}
              {lastResult.exitCode !== undefined &&
                ` (exit ${lastResult.exitCode})`}
              {lastResult.error && ` — ${lastResult.error}`}
            </Alert>
          )}
        </CardContent>
      </Card>

      {(actionInFlight || output.length > 0) && (
        <Card>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Output{actionInFlight ? ` (${actionInFlight}, running…)` : ""}
            </Typography>
            <LogOutput
              value={outputText}
              placeholder="(no output yet)"
              maxHeight="50vh"
            />
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
      >
        <DialogTitle>{confirmAction?.label}</DialogTitle>
        <DialogContent>
          <DialogContentText>{confirmAction?.confirmText}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAction(null)}>Cancel</Button>
          <Button
            onClick={handleConfirm}
            color={confirmAction?.danger ? "error" : "primary"}
            variant="contained"
            autoFocus
          >
            Run
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default BackupPi;
