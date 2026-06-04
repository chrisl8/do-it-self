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
import TextField from "@mui/material/TextField";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Spinner from "@mui/material/CircularProgress";
import useBackupPi from "./hooks/useBackupPi";
import LogOutput from "./LogOutput";

// `perClient: true` means the renderer shows a "Client" dropdown next to
// the button. Default "all" sends the bare verb (runs across every client
// on the Pi); a specific client sends `<verb>-<clientName>`.
const ACTIONS = [
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
      "Run a borg integrity check. This can take a while on large repos.",
    danger: false,
    perClient: true,
  },
  {
    name: "borg-prune",
    label: "Borg prune",
    confirmText:
      "Run borg prune + compact. Old archives outside the retention policy (14d/4w on the Pi) will be deleted permanently.",
    danger: true,
    perClient: true,
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

// Permissive parser — handles both borg `{time}` ("Fri, 2026-05-15 03:25:40")
// and `{isoformat}` ("2026-05-15T03:25:40"). Returns ms epoch or NaN.
const parseBorgArchiveTimestamp = (s) => {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m =
    /^(?:[A-Za-z]{3},\s+)?(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) {
    t = Date.parse(`${m[1]}T${m[2]}`);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
};

const archiveAgeColor = (hours) => {
  if (hours === null) return "default";
  if (hours < 24) return "success";
  if (hours < 48) return "warning";
  return "error";
};

const StatusCard = ({ status, onSetPassphrase }) => {
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
        and <code>ssh_key_path</code>. See <code>docs/SETUP-BACKUP-PI.md</code>{" "}
        for the full setup.
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

  const tsConnected = status.tailscale?.backend_state === "Running";
  const clients = Array.isArray(status.clients) ? status.clients : [];

  return (
    <Card>
      <CardContent>
        <Stack
          direction="row"
          alignItems="center"
          spacing={2}
          mb={2}
          flexWrap="wrap"
        >
          <Typography variant="h6">{status.hostname || "backup-pi"}</Typography>
          <Chip
            label={
              tsConnected
                ? "Tailscale up"
                : `Tailscale: ${status.tailscale?.backend_state || "?"}`
            }
            color={tsConnected ? "success" : "error"}
            size="small"
          />
          {status.any_client_stale ? (
            <Chip label="A client is stale" color="error" size="small" />
          ) : clients.length > 0 ? (
            <Chip label="All clients fresh" color="success" size="small" />
          ) : null}
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

        {clients.length > 0 && (
          <Box mt={2}>
            <Divider sx={{ mb: 1 }} />
            <Typography variant="subtitle2" gutterBottom>
              Clients
            </Typography>
            <Stack spacing={1}>
              {clients.map((c) => {
                const lastEpochMs = c.last_archive_iso
                  ? parseBorgArchiveTimestamp(c.last_archive_iso)
                  : NaN;
                const lastEpoch = Number.isNaN(lastEpochMs)
                  ? null
                  : Math.floor(lastEpochMs / 1000);
                const hours =
                  lastEpoch && status.now_epoch
                    ? (status.now_epoch - lastEpoch) / 3600
                    : null;
                return (
                  <Stack key={c.name} spacing={0.5}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={2}
                      flexWrap="wrap"
                    >
                      <Typography
                        variant="body2"
                        sx={{ minWidth: 120, fontWeight: 500 }}
                      >
                        {c.name}
                      </Typography>
                      <Chip
                        label={
                          lastEpoch
                            ? `Last: ${formatRelativeAge(lastEpoch, status.now_epoch)}`
                            : c.error
                              ? "Error"
                              : "No archives yet"
                        }
                        color={
                          c.error
                            ? "error"
                            : c.stale
                              ? "error"
                              : hours !== null
                                ? archiveAgeColor(hours)
                                : "default"
                        }
                        size="small"
                      />
                      <Typography variant="caption" color="text.secondary">
                        {c.archive_count} archive
                        {c.archive_count === 1 ? "" : "s"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        threshold {c.freshness_threshold_hours}h
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.repo_path}
                      </Typography>
                      {c.has_passphrase === false && (
                        <Chip
                          label="No passphrase"
                          color="warning"
                          size="small"
                          variant="outlined"
                        />
                      )}
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => onSetPassphrase?.(c.name)}
                      >
                        Set passphrase
                      </Button>
                    </Stack>
                    {c.error && (
                      <Typography
                        variant="caption"
                        color="error"
                        sx={{ pl: 14 }}
                      >
                        {c.error}
                      </Typography>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
        )}

        <Stack direction="row" spacing={3} mt={2} flexWrap="wrap">
          <Typography variant="caption" color="text.secondary">
            Uptime: {formatDuration(status.uptime_seconds)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Tailscale IP: {status.tailscale?.ip || "—"}
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
    setClientPassphrase,
    lastSecretResult,
    clearSecretResult,
  } = useBackupPi();
  const [confirmAction, setConfirmAction] = useState(null);
  // Map of action name → selected client ("" = all). Only used for
  // actions with perClient: true (borg-check, borg-prune).
  const [actionClient, setActionClient] = useState({});
  // "Set passphrase" dialog state — opened from per-client row buttons.
  const [secretDialog, setSecretDialog] = useState({
    open: false,
    clientName: "",
    passphrase: "",
  });

  const piDisabled = !status || !status.enabled || !status.reachable;
  const buttonsDisabled = piDisabled || !!actionInFlight;
  const clientNames = useMemo(
    () =>
      Array.isArray(status?.clients) ? status.clients.map((c) => c.name) : [],
    [status],
  );

  const outputText = useMemo(
    () => output.map((c) => c.chunk).join(""),
    [output],
  );

  const handleConfirm = () => {
    if (!confirmAction) return;
    const clientName = confirmAction.perClient
      ? actionClient[confirmAction.name] || ""
      : "";
    runAction(confirmAction.name, clientName || undefined);
    setConfirmAction(null);
  };

  const isActionRunning = (a) => {
    if (!actionInFlight) return false;
    if (actionInFlight === a.name) return true;
    if (a.perClient && actionInFlight.startsWith(`${a.name}-`)) return true;
    return false;
  };

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="h5">Backup Pi</Typography>

      <StatusCard
        status={status}
        onSetPassphrase={(name) => {
          clearSecretResult();
          setSecretDialog({ open: true, clientName: name, passphrase: "" });
        }}
      />

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Actions
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            flexWrap="wrap"
            useFlexGap
            alignItems="center"
          >
            {ACTIONS.map((a) => {
              const selected = actionClient[a.name] || "";
              return (
                <Stack
                  key={a.name}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                >
                  <Button
                    variant={a.danger ? "outlined" : "contained"}
                    color={a.danger ? "error" : "primary"}
                    disabled={buttonsDisabled}
                    onClick={() => setConfirmAction(a)}
                  >
                    {isActionRunning(a) ? (
                      <Spinner size={18} sx={{ mr: 1 }} />
                    ) : null}
                    {a.label}
                  </Button>
                  {a.perClient && clientNames.length > 0 && (
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <InputLabel id={`client-${a.name}-label`}>
                        Client
                      </InputLabel>
                      <Select
                        labelId={`client-${a.name}-label`}
                        label="Client"
                        value={selected}
                        disabled={buttonsDisabled}
                        onChange={(e) =>
                          setActionClient((prev) => ({
                            ...prev,
                            [a.name]: e.target.value,
                          }))
                        }
                      >
                        <MenuItem value="">all clients</MenuItem>
                        {clientNames.map((name) => (
                          <MenuItem key={name} value={name}>
                            {name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                </Stack>
              );
            })}
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

      <Dialog open={!!confirmAction} onClose={() => setConfirmAction(null)}>
        <DialogTitle>
          {confirmAction?.label}
          {confirmAction?.perClient && (
            <Typography
              variant="caption"
              component="div"
              color="text.secondary"
            >
              Target: {actionClient[confirmAction.name] || "all clients"}
            </Typography>
          )}
        </DialogTitle>
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

      <Dialog
        open={secretDialog.open}
        onClose={() =>
          setSecretDialog({ open: false, clientName: "", passphrase: "" })
        }
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Set borg passphrase for {secretDialog.clientName}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Writes the passphrase to Infisical under the path / key configured
            for this client in <code>backuppi.clients</code>. The Pi never sees
            this value at rest — it's fetched on demand and forwarded over SSH
            only for each operation that needs it.
          </DialogContentText>
          <TextField
            label="Passphrase"
            type="password"
            fullWidth
            autoFocus
            value={secretDialog.passphrase}
            onChange={(e) =>
              setSecretDialog((prev) => ({
                ...prev,
                passphrase: e.target.value,
              }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && secretDialog.passphrase) {
                setClientPassphrase(
                  secretDialog.clientName,
                  secretDialog.passphrase,
                );
                setSecretDialog({
                  open: false,
                  clientName: "",
                  passphrase: "",
                });
              }
            }}
          />
          {lastSecretResult &&
            lastSecretResult.clientName === secretDialog.clientName && (
              <Alert
                severity={lastSecretResult.ok ? "success" : "error"}
                sx={{ mt: 2 }}
              >
                {lastSecretResult.ok
                  ? `Saved to Infisical (${lastSecretResult.path}/${lastSecretResult.key}).`
                  : `Failed: ${lastSecretResult.error}`}
              </Alert>
            )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() =>
              setSecretDialog({
                open: false,
                clientName: "",
                passphrase: "",
              })
            }
          >
            Close
          </Button>
          <Button
            disabled={!secretDialog.passphrase}
            variant="contained"
            onClick={() => {
              setClientPassphrase(
                secretDialog.clientName,
                secretDialog.passphrase,
              );
              // Don't close — let the user see the result alert. They can
              // close manually or change the input and retry.
              setSecretDialog((prev) => ({ ...prev, passphrase: "" }));
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default BackupPi;
