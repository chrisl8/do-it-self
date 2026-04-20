import React, { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Spinner from "@mui/material/CircularProgress";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import useBorgConfig, { usePathSize } from "./hooks/useBorgConfig";

const BACKUP_PI_PLACEHOLDER = "ssh://borg@backup-pi/mnt/backup/borg";

const PathSizeChip = ({ path, enabled }) => {
  const { size, loading } = usePathSize(path, { enabled });
  if (!enabled) return null;
  if (loading) return <Chip label="…" size="small" variant="outlined" />;
  if (!size) return null;
  return <Chip label={size} size="small" variant="outlined" />;
};

const BackupPathRow = ({ row, onChange, onDelete }) => {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.5,
      }}
    >
      <Switch
        size="small"
        checked={row.enabled}
        onChange={(e) => onChange({ ...row, enabled: e.target.checked })}
      />
      <TextField
        size="small"
        fullWidth
        value={row.path}
        onChange={(e) => onChange({ ...row, path: e.target.value })}
        slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: "0.85rem" } } }}
      />
      <PathSizeChip path={row.path} enabled={row.enabled && Boolean(row.path)} />
      <IconButton size="small" onClick={onDelete} aria-label="remove path">
        <DeleteIcon fontSize="small" />
      </IconButton>
    </Box>
  );
};

const GeneratePassphraseDialog = ({ open, onClose, passphraseKey, onGenerate, onConfirm }) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setValue("");
      setError(null);
      setConfirmArmed(false);
      setSaving(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const v = await onGenerate();
        if (!cancelled) setValue(v);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    // Arm the confirm button after 5 seconds so the user has time to
    // actually read the warning and save the passphrase off-box before
    // committing. Not a true security measure, just a speed bump.
    const timer = setTimeout(() => {
      if (!cancelled) setConfirmArmed(true);
    }, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, onGenerate]);

  const copy = () => {
    navigator.clipboard?.writeText(value).catch(() => {});
  };

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(value);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    setConfirmArmed(false);
    setValue("");
    setError(null);
    try {
      const v = await onGenerate();
      setValue(v);
      setTimeout(() => setConfirmArmed(true), 5000);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {passphraseKey === "remotePassphrase" ? "Remote" : "Local"} borg passphrase
      </DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>Save this passphrase off-box now</AlertTitle>
          This is the <b>only</b> time you can see this passphrase. If you lose it and also
          lose this host, your borg archives are <b>unrecoverable</b>. Save it in a password
          manager <b>and</b> somewhere else before continuing.
        </Alert>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            fontFamily: "monospace",
            fontSize: "1rem",
            p: 1.5,
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            backgroundColor: "grey.100",
            mb: 2,
            wordBreak: "break-all",
          }}
        >
          <Box sx={{ flex: 1 }}>{value || <Spinner size={16} />}</Box>
          <IconButton size="small" onClick={copy} disabled={!value} aria-label="copy">
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        <DialogContentText sx={{ fontSize: "0.85rem" }}>
          When you click <b>I've saved it — write to Infisical</b>, this passphrase
          is stored in Infisical at <code>/borgbackup</code> and becomes invisible in the
          web admin. You will not be able to re-reveal it.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={regenerate} disabled={!value || saving}>
          Regenerate
        </Button>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={confirm}
          disabled={!value || !confirmArmed || saving}
        >
          {saving ? <Spinner size={16} /> : confirmArmed ? "I've saved it — write to Infisical" : "Read the warning above…"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const PassphraseField = ({ label, passphraseKey, isSet, onGenerate, onSave }) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [manualError, setManualError] = useState(null);
  const [saving, setSaving] = useState(false);

  const saveManual = async () => {
    setSaving(true);
    setManualError(null);
    try {
      await onSave(manualValue);
      setManualValue("");
      setManualMode(false);
    } catch (err) {
      setManualError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {isSet && !manualMode && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 0.5 }}>
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", letterSpacing: "0.2em", flex: 1 }}
          >
            ●●●●●●●●●●●●●●●●
          </Typography>
          <Chip label="stored in Infisical" size="small" color="success" />
          <Button
            size="small"
            onClick={() => {
              setManualMode(true);
              setManualValue("");
            }}
          >
            Rotate
          </Button>
        </Box>
      )}
      {!isSet && !manualMode && (
        <Box sx={{ display: "flex", gap: 1, mt: 0.5 }}>
          <Button variant="contained" size="small" onClick={() => setDialogOpen(true)}>
            Generate strong passphrase
          </Button>
          <Button size="small" onClick={() => setManualMode(true)}>
            Enter my own
          </Button>
        </Box>
      )}
      {manualMode && (
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start", mt: 0.5 }}>
          <TextField
            size="small"
            type="password"
            fullWidth
            placeholder="Paste passphrase"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            disabled={saving}
            error={Boolean(manualError)}
            helperText={manualError || (isSet ? "Replaces the passphrase currently in Infisical" : " ")}
          />
          <Button
            variant="contained"
            size="small"
            onClick={saveManual}
            disabled={manualValue.length < 8 || saving}
          >
            {saving ? <Spinner size={16} /> : "Save"}
          </Button>
          <Button size="small" onClick={() => { setManualMode(false); setManualValue(""); setManualError(null); }}>
            Cancel
          </Button>
        </Box>
      )}
      {isSet && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          If you've lost this passphrase, existing archives cannot be recovered. You would
          need to init a new repository — see <code>borgbackup/SETUP.md</code>.
        </Typography>
      )}
      <GeneratePassphraseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        passphraseKey={passphraseKey}
        onGenerate={onGenerate}
        onConfirm={onSave}
      />
    </Box>
  );
};

const InitOutputDialog = ({ open, onClose, output, loading, exitCode }) => (
  <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
    <DialogTitle>
      Initialize repositories
      {exitCode !== null && exitCode !== undefined && (
        <Chip
          label={exitCode === 0 ? "Success" : `Exit ${exitCode}`}
          color={exitCode === 0 ? "success" : "error"}
          size="small"
          sx={{ ml: 1 }}
        />
      )}
    </DialogTitle>
    <DialogContent>
      {loading ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Spinner size={20} />
          <Typography>Running <code>scripts/setup-borg-backup.sh</code>…</Typography>
        </Box>
      ) : (
        <Box
          component="pre"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.8rem",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "60vh",
            overflow: "auto",
            backgroundColor: "grey.900",
            color: "grey.100",
            p: 2,
            borderRadius: 1,
          }}
        >
          {output || "(no output)"}
        </Box>
      )}
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose} disabled={loading}>
        Close
      </Button>
    </DialogActions>
  </Dialog>
);

const SshPublicKeyRow = () => {
  const [pubkey, setPubkey] = useState(null);

  useEffect(() => {
    // The backend doesn't expose ~/.ssh/id_ed25519.pub yet, so for v1
    // show a copy-paste instruction instead. Adding a dedicated endpoint
    // is a follow-up; keeping this scope-bound.
    setPubkey(null);
  }, []);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="caption" color="text.secondary">
        SSH public key for backup-pi authorized_keys
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        For a fresh Pi, run <code>setup-backup-pi.sh</code> on it. For an existing
        Pi, on this host run{" "}
        <Box component="code" sx={{ backgroundColor: "grey.100", px: 0.5 }}>
          cat ~/.ssh/id_ed25519.pub
        </Box>{" "}
        and add the output to the Pi's <code>borg</code> user's{" "}
        <code>~/.ssh/authorized_keys</code>. Then click Initialize repositories below.
      </Typography>
    </Box>
  );
};

const BorgConfigSection = () => {
  const {
    data,
    loading,
    error,
    refresh,
    save,
    generatePassphrase,
    savePassphrase,
    initRepo,
    runBackupNow,
  } = useBorgConfig();

  // Local editing state mirrors the server config until the user clicks Save.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [initDialogOpen, setInitDialogOpen] = useState(false);
  const [initLoading, setInitLoading] = useState(false);
  const [initOutput, setInitOutput] = useState("");
  const [initExitCode, setInitExitCode] = useState(null);
  const [runStarted, setRunStarted] = useState(false);

  useEffect(() => {
    if (data?.config) {
      setDraft(JSON.parse(JSON.stringify(data.config)));
      if (data.config.remote_repo) setRemoteOpen(true);
    }
  }, [data]);

  const dirty = useMemo(() => {
    if (!draft || !data?.config) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.config);
  }, [draft, data]);

  const doSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await save(draft);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const doInit = async () => {
    setInitDialogOpen(true);
    setInitLoading(true);
    setInitOutput("");
    setInitExitCode(null);
    try {
      const result = await initRepo();
      setInitOutput(result.output || "");
      setInitExitCode(result.exitCode);
      refresh();
    } catch (err) {
      setInitOutput(String(err.message));
      setInitExitCode(-1);
    } finally {
      setInitLoading(false);
    }
  };

  const doRunNow = async () => {
    try {
      await runBackupNow();
      setRunStarted(true);
      setTimeout(() => setRunStarted(false), 5000);
    } catch (err) {
      setSaveError(err.message);
    }
  };

  if (loading && !data) {
    return (
      <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
        <Spinner />
      </Box>
    );
  }
  if (error && !data) {
    return (
      <Alert severity="error" sx={{ mb: 3 }}>
        Failed to load borg config: {error}
      </Alert>
    );
  }

  if (data && !data.infisical_available) {
    return (
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
          Borg Backup Configuration
        </Typography>
        <Alert severity="warning">
          <AlertTitle>Infisical is required</AlertTitle>
          Borg backup stores its passphrases in Infisical. Enable and start the Infisical
          container on the Containers page, then refresh this page to continue.
        </Alert>
      </Box>
    );
  }

  if (!draft) return null;

  const updatePath = (idx, next) => {
    const paths = [...draft.backup_paths];
    paths[idx] = next;
    setDraft({ ...draft, backup_paths: paths });
  };
  const removePath = (idx) => {
    const paths = draft.backup_paths.filter((_, i) => i !== idx);
    setDraft({ ...draft, backup_paths: paths });
  };
  const addPath = () => {
    setDraft({
      ...draft,
      backup_paths: [...draft.backup_paths, { path: "", enabled: true }],
    });
  };

  const repoIsReady = Boolean(draft.repo_path) && data.passphrase_set.passphrase;
  const backupCanRun = data.passphrase_set.passphrase && draft.backup_paths.some((p) => p.enabled && p.path);

  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Typography variant="h6" component="h2">
          Borg Backup Configuration
        </Typography>
        {!data.persisted && (
          <Chip label="Not yet saved — showing live conf" size="small" color="warning" />
        )}
      </Box>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          {/* Repository location */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Repository location (BORG_REPO)
            </Typography>
            <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 0.5 }}>
              <Select
                size="small"
                value={data.mounts.find((m) => draft.repo_path.startsWith(m.path))?.path || ""}
                onChange={(e) => {
                  const mount = e.target.value;
                  const next = `${mount.replace(/\/+$/, "")}/borg-repo`;
                  setDraft({
                    ...draft,
                    repo_path: next,
                    dump_dir: `${mount.replace(/\/+$/, "")}/borg-db-dumps`,
                  });
                }}
                sx={{ minWidth: 240 }}
              >
                {data.mounts.map((m) => (
                  <MenuItem key={m.path} value={m.path}>
                    {m.path} ({m.label || "unlabeled"})
                  </MenuItem>
                ))}
              </Select>
              <TextField
                size="small"
                value={draft.repo_path}
                onChange={(e) => setDraft({ ...draft, repo_path: e.target.value })}
                fullWidth
                slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: "0.85rem" } } }}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              The encrypted on-disk repository. Choose a mount with headroom — archives
              grow deduplicated but still accumulate.
            </Typography>
          </Box>

          {/* Dump directory */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Database dump directory (BORG_DB_DUMP_DIR)
            </Typography>
            <TextField
              size="small"
              fullWidth
              sx={{ mt: 0.5 }}
              value={draft.dump_dir}
              onChange={(e) => setDraft({ ...draft, dump_dir: e.target.value })}
              slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: "0.85rem" } } }}
            />
            <Typography variant="caption" color="text.secondary">
              Where Postgres / MariaDB / SQLite dumps land before the backup reads them.
              Usually a sibling of the repo on the same mount.
            </Typography>
          </Box>

          {/* Backup paths */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Paths to back up (BORG_BACKUP_PATHS)
            </Typography>
            <Box sx={{ mt: 0.5 }}>
              {draft.backup_paths.map((row, i) => (
                <BackupPathRow
                  key={i}
                  row={row}
                  onChange={(next) => updatePath(i, next)}
                  onDelete={() => removePath(i)}
                />
              ))}
            </Box>
            <Button
              startIcon={<AddIcon />}
              size="small"
              onClick={addPath}
              sx={{ mt: 1 }}
            >
              Add path
            </Button>
            {data.mounts_not_in_backup.length > 0 && (
              <Alert severity="info" sx={{ mt: 1 }}>
                <AlertTitle>Mounts not currently in backup</AlertTitle>
                <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1 }}>
                  {data.mounts_not_in_backup.map((m) => (
                    <Chip key={m} label={m} size="small" color="warning" />
                  ))}
                </Box>
                <Typography variant="caption" sx={{ display: "block", mt: 1 }}>
                  Nothing under these mounts is included in the backup. If these mounts
                  hold data you need to recover after host loss, add an enabled path.
                </Typography>
              </Alert>
            )}
          </Box>

          {/* Local passphrase */}
          <PassphraseField
            label="Local passphrase (BORG_PASSPHRASE in Infisical)"
            passphraseKey="passphrase"
            isSet={data.passphrase_set.passphrase}
            onGenerate={generatePassphrase}
            onSave={(v) => savePassphrase("passphrase", v)}
          />

          {/* Remote subsection */}
          <Box sx={{ mt: 2, pt: 2, borderTop: "1px solid", borderColor: "divider" }}>
            <Box
              sx={{ display: "flex", alignItems: "center", cursor: "pointer" }}
              onClick={() => setRemoteOpen((s) => !s)}
            >
              {remoteOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Offsite (remote) backup
              </Typography>
              {draft.remote_repo && (
                <Chip
                  label="configured"
                  color="success"
                  size="small"
                  sx={{ ml: 1 }}
                  variant="outlined"
                />
              )}
            </Box>
            <Collapse in={remoteOpen}>
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  A separate server (typically a backup-pi on your tailnet) that holds a
                  second copy of your archives in append-only mode, resilient to ransomware
                  and local drive failure. Leave the URL empty to disable.
                </Typography>
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    Remote repo URL (BORG_REMOTE_REPO)
                  </Typography>
                  <TextField
                    size="small"
                    fullWidth
                    sx={{ mt: 0.5 }}
                    placeholder={BACKUP_PI_PLACEHOLDER}
                    value={draft.remote_repo}
                    onChange={(e) => setDraft({ ...draft, remote_repo: e.target.value })}
                    slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: "0.85rem" } } }}
                  />
                </Box>
                <SshPublicKeyRow />
                <PassphraseField
                  label="Remote passphrase (BORG_REMOTE_PASSPHRASE in Infisical)"
                  passphraseKey="remotePassphrase"
                  isSet={data.passphrase_set.remotePassphrase}
                  onGenerate={generatePassphrase}
                  onSave={(v) => savePassphrase("remotePassphrase", v)}
                />
                <Box sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Rate limit for remote transfers, kB/s (0 = unlimited)
                  </Typography>
                  <TextField
                    size="small"
                    type="number"
                    sx={{ mt: 0.5, width: 160 }}
                    value={draft.remote_ratelimit_kbps}
                    onChange={(e) =>
                      setDraft({ ...draft, remote_ratelimit_kbps: Number(e.target.value) || 0 })
                    }
                  />
                </Box>
              </Box>
            </Collapse>
          </Box>

          {saveError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {saveError}
            </Alert>
          )}

          {/* Actions */}
          <Box
            sx={{
              display: "flex",
              gap: 1,
              alignItems: "center",
              mt: 2,
              pt: 2,
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            <Button
              variant="contained"
              onClick={doSave}
              disabled={!dirty || saving}
            >
              {saving ? <Spinner size={16} /> : "Save configuration"}
            </Button>
            <Tooltip
              title={
                repoIsReady
                  ? "Runs scripts/setup-borg-backup.sh. Idempotent — safe to re-run."
                  : "Set a repo path and passphrase first."
              }
              arrow
            >
              <span>
                <Button
                  variant="outlined"
                  onClick={doInit}
                  disabled={!repoIsReady || dirty}
                >
                  Initialize repositories
                </Button>
              </span>
            </Tooltip>
            <Tooltip
              title={
                backupCanRun
                  ? "Starts a full borg backup run in the background."
                  : "Finish setup before running a backup."
              }
              arrow
            >
              <span>
                <Button
                  variant="outlined"
                  onClick={doRunNow}
                  disabled={!backupCanRun || dirty}
                >
                  Run backup now
                </Button>
              </span>
            </Tooltip>
            {runStarted && (
              <Chip label="Backup started in background" color="success" size="small" />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            See <code>borgbackup/SETUP.md</code> for the walkthrough.
          </Typography>
        </CardContent>
      </Card>

      <InitOutputDialog
        open={initDialogOpen}
        onClose={() => setInitDialogOpen(false)}
        output={initOutput}
        loading={initLoading}
        exitCode={initExitCode}
      />
    </Box>
  );
};

export default BorgConfigSection;
