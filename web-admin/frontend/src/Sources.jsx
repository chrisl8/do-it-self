import React, { useState, useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardActions from "@mui/material/CardActions";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Link from "@mui/material/Link";
import IconButton from "@mui/material/IconButton";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import useModules from "./hooks/useModules";
import useGitStatus from "./hooks/useGitStatus";
import ModuleOperationDialog from "./ModuleOperationDialog";

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function InstalledSourceRow({ name, entry, onUpdate, onRemove, busy }) {
  const installedCount = (entry.installed_containers || []).length;
  const canRemove = installedCount === 0;
  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ pb: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="h6">{name}</Typography>
          <Chip size="small" label={entry.commit_short || "?"} variant="outlined" />
        </Box>
        {entry.url && (
          <Typography variant="body2" color="text.secondary">
            <Link href={entry.url} target="_blank" rel="noopener noreferrer">
              {entry.url}
            </Link>
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          Last updated: {formatDate(entry.updated)} • {installedCount} installed container
          {installedCount === 1 ? "" : "s"}
        </Typography>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5, gap: 1 }}>
        <Button size="small" variant="outlined" disabled={busy} onClick={() => onUpdate(name)}>
          Update
        </Button>
        <Tooltip
          title={canRemove ? "" : "Uninstall all containers from this source first"}
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              color="error"
              disabled={busy || !canRemove}
              onClick={() => onRemove(name)}
            >
              Remove
            </Button>
          </span>
        </Tooltip>
      </CardActions>
    </Card>
  );
}

function CatalogRow({ name, entry, added, onAdd, busy }) {
  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ pb: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="h6">{name}</Typography>
          {added && <Chip size="small" label="Added" color="success" />}
        </Box>
        {entry.description && (
          <Typography variant="body2" color="text.secondary">
            {entry.description}
          </Typography>
        )}
        {entry.url && (
          <Typography variant="caption" color="text.secondary">
            <Link href={entry.url} target="_blank" rel="noopener noreferrer">
              {entry.url}
            </Link>
          </Typography>
        )}
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5 }}>
        <Button
          size="small"
          variant="contained"
          disabled={busy || added}
          onClick={() => onAdd(entry.url, name)}
        >
          {added ? "Already added" : "Add"}
        </Button>
      </CardActions>
    </Card>
  );
}

function PlatformUpdateBanner({
  repo,
  preBackup,
  onPreBackupChange,
  onUpdate,
  onRefresh,
  busy,
  fetchingUpstream,
}) {
  if (!repo) return null;

  const refreshAction = (
    <Tooltip title="Check upstream for new commits">
      <span>
        <IconButton
          size="small"
          onClick={onRefresh}
          disabled={busy || fetchingUpstream}
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );

  // Unclean: dirty-repos banner already names the files.
  if (!repo.clean) {
    return (
      <Alert severity="warning" sx={{ mb: 2 }} action={refreshAction}>
        <AlertTitle>Platform has uncommitted changes</AlertTitle>
        Platform update is disabled until the working tree is clean. Commit or
        stash the changes listed below.
      </Alert>
    );
  }

  if (repo.ahead > 0) {
    return (
      <Alert severity="error" sx={{ mb: 2 }} action={refreshAction}>
        <AlertTitle>Platform has local commits not upstream</AlertTitle>
        This updater only fast-forwards; it will not push or merge. Push your
        commits upstream, or on the CLI run{" "}
        <code>git reset --hard {repo.upstream || "origin/main"}</code> (discards
        local commits).
      </Alert>
    );
  }

  if (!repo.upstream) {
    return (
      <Alert severity="warning" sx={{ mb: 2 }} action={refreshAction}>
        <AlertTitle>Platform branch has no upstream</AlertTitle>
        Set one on the CLI with{" "}
        <code>
          git branch --set-upstream-to=origin/{repo.branch || "main"}{" "}
          {repo.branch || "main"}
        </code>
        .
      </Alert>
    );
  }

  if (repo.behind === 0) {
    // Up to date — tiny affordance to re-check.
    return (
      <Alert severity="success" sx={{ mb: 2 }} action={refreshAction}>
        Platform is up to date
        {repo.fetchedAt
          ? ` (checked ${new Date(repo.fetchedAt).toLocaleTimeString()})`
          : " (using cached state — click refresh to check upstream)"}
        .
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: 2 }} action={refreshAction}>
      <AlertTitle>
        Platform is {repo.behind} commit{repo.behind === 1 ? "" : "s"} behind
        upstream
      </AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Fast-forward pull + validation pass. Restart stacks after to pick up
        compose changes.
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        <Button
          size="small"
          variant="contained"
          onClick={onUpdate}
          disabled={busy}
        >
          Update platform
        </Button>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={preBackup}
              onChange={(e) => onPreBackupChange(e.target.checked)}
              disabled={busy}
            />
          }
          label={
            <Typography variant="body2">
              Run borg backup first (remote-only, skips DB dumps)
            </Typography>
          }
        />
      </Box>
    </Alert>
  );
}

function DirtyRepoEntry({ repo, onDevSync, busy }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <IconButton size="small" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {repo.label}
        </Typography>
        <Chip
          size="small"
          label={`${repo.changes.length}${repo.truncated ? "+" : ""} file${repo.changes.length === 1 ? "" : "s"}`}
          variant="outlined"
        />
        {repo.isModule && (
          <Button size="small" variant="outlined" disabled={busy} onClick={() => onDevSync(repo.name)}>
            Dev-sync
          </Button>
        )}
      </Box>
      <Collapse in={expanded}>
        <Box
          component="pre"
          sx={{
            ml: 5,
            mt: 0.5,
            mb: 0,
            fontSize: "0.8rem",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            color: "text.secondary",
          }}
        >
          {repo.changes.map((c, i) => `${c.status.padEnd(3)}${c.file}`).join("\n")}
          {repo.truncated ? `\n... and ${repo.truncated} more` : ""}
        </Box>
      </Collapse>
    </Box>
  );
}

function Sources() {
  const {
    catalog,
    installed,
    loading,
    error,
    addSource,
    removeSource,
    updateSource,
    updateAllSources,
    regenerateRegistry,
  } = useModules();

  const {
    dirtyRepos,
    platformRepo,
    refresh: refreshGit,
    refreshWithFetch,
    devSync,
    updatePlatform,
  } = useGitStatus();

  const [dialog, setDialog] = useState({ open: false, title: "", running: false, result: null });
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [preBackup, setPreBackup] = useState(false);
  const [fetchingUpstream, setFetchingUpstream] = useState(false);

  const run = async (title, op) => {
    setDialog({ open: true, title, running: true, result: null });
    const result = await op();
    setDialog({
      open: true,
      title: result.success ? title.replace(/\.\.\.$/, " — done") : title.replace(/\.\.\.$/, " — failed"),
      running: false,
      result,
    });
  };

  const closeDialog = () => setDialog({ open: false, title: "", running: false, result: null });

  const handleAddCatalog = (url, name) =>
    run(`Adding source ${name}...`, () => addSource(url, name));

  const handleAddCustom = () => {
    if (!customUrl.trim()) return;
    const name = customName.trim() || undefined;
    run(`Adding source ${name || customUrl}...`, () => addSource(customUrl.trim(), name)).then(() => {
      setCustomUrl("");
      setCustomName("");
    });
  };

  const handleUpdate = (name) => run(`Updating ${name}...`, () => updateSource(name));
  const handleUpdateAll = () => run(`Updating all sources...`, () => updateAllSources());
  const handleRemove = (name) => {
    if (!window.confirm(`Remove module source "${name}"? The clone at .modules/${name}/ will be deleted.`)) return;
    run(`Removing ${name}...`, () => removeSource(name));
  };
  const handleRegenerate = () => {
    if (!window.confirm("Regenerate container-registry.yaml from installed modules? Non-module entries are preserved.")) return;
    run("Regenerating registry...", () => regenerateRegistry());
  };
  const handleDevSync = (moduleName) =>
    run(`Dev-syncing ${moduleName}...`, () => devSync(moduleName)).then(() => refreshGit());

  const handleCheckPlatformUpdates = async () => {
    setFetchingUpstream(true);
    try {
      await refreshWithFetch();
    } finally {
      setFetchingUpstream(false);
    }
  };

  const handlePlatformUpdate = async () => {
    const title = preBackup
      ? "Updating platform (with pre-backup)..."
      : "Updating platform...";
    await run(title, () => updatePlatform({ preBackup }));
    await refreshGit();
  };

  const installedEntries = useMemo(
    () => Object.entries(installed?.modules || {}).sort(([a], [b]) => a.localeCompare(b)),
    [installed],
  );

  const catalogEntries = useMemo(
    () => Object.entries(catalog?.catalogs || {}).sort(([a], [b]) => a.localeCompare(b)),
    [catalog],
  );

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, maxWidth: 1200, margin: "0 auto" }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Module Sources
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Module sources are git repositories containing container stacks. Adding
        a source clones it into <code>.modules/</code>; its containers then
        appear on the Browse page where you can install them individually.
      </Alert>

      <PlatformUpdateBanner
        repo={platformRepo}
        preBackup={preBackup}
        onPreBackupChange={setPreBackup}
        onUpdate={handlePlatformUpdate}
        onRefresh={handleCheckPlatformUpdates}
        busy={dialog.running}
        fetchingUpstream={fetchingUpstream}
      />

      {dirtyRepos.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <IconButton size="small" onClick={refreshGit} title="Refresh">
              <RefreshIcon fontSize="small" />
            </IconButton>
          }
        >
          <AlertTitle>Uncommitted Git Changes</AlertTitle>
          {dirtyRepos.map((repo) => (
            <DirtyRepoEntry
              key={repo.name}
              repo={repo}
              onDevSync={handleDevSync}
              busy={dialog.running}
            />
          ))}
        </Alert>
      )}

      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="h6">Installed Sources</Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={dialog.running || installedEntries.length === 0}
            onClick={handleUpdateAll}
          >
            Update All
          </Button>
        </Box>
        <Divider sx={{ mb: 1.5 }} />
        {installedEntries.length === 0 ? (
          <Alert severity="warning">No module sources added yet.</Alert>
        ) : (
          installedEntries.map(([name, entry]) => (
            <InstalledSourceRow
              key={name}
              name={name}
              entry={entry}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              busy={dialog.running}
            />
          ))
        )}
      </Box>

      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Available from Catalog
        </Typography>
        <Divider sx={{ mb: 1.5 }} />
        {catalogEntries.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No catalog entries defined.
          </Typography>
        ) : (
          catalogEntries.map(([name, entry]) => (
            <CatalogRow
              key={name}
              name={name}
              entry={entry}
              added={Boolean(installed?.modules?.[name])}
              onAdd={handleAddCatalog}
              busy={dialog.running}
            />
          ))
        )}
      </Box>

      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Add Custom URL
        </Typography>
        <Divider sx={{ mb: 1.5 }} />
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, maxWidth: 600 }}>
          <TextField
            size="small"
            label="Git URL"
            placeholder="https://github.com/user/my-module.git"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            disabled={dialog.running}
          />
          <TextField
            size="small"
            label="Name (optional)"
            placeholder="Defaults to the repository name"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            disabled={dialog.running}
          />
          <Box>
            <Button
              variant="contained"
              disabled={dialog.running || !customUrl.trim()}
              onClick={handleAddCustom}
            >
              Add Source
            </Button>
          </Box>
        </Box>
      </Box>

      <Box sx={{ mt: 4, pt: 2, borderTop: 1, borderColor: "divider" }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
          Advanced: rebuild container-registry.yaml from installed modules if
          state has become inconsistent.
        </Typography>
        <Button
          size="small"
          variant="text"
          disabled={dialog.running}
          onClick={handleRegenerate}
        >
          Regenerate Registry
        </Button>
      </Box>

      <ModuleOperationDialog
        open={dialog.open}
        title={dialog.title}
        running={dialog.running}
        result={dialog.result}
        onClose={closeDialog}
      />
    </Box>
  );
}

export default Sources;
