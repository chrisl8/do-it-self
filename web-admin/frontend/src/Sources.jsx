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
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import useModules from "./hooks/useModules";
import useGitStatus from "./hooks/useGitStatus";
import ModuleOperationDialog from "./ModuleOperationDialog";
import SystemUpdatesPanel from "./SystemUpdatesPanel";

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function InstalledSourceRow({ name, entry, onRemove, busy }) {
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

function DirtyRepoEntry({ repo, onDevSync, busy }) {
  const [expanded, setExpanded] = useState(false);
  const changes = repo.changes || [];
  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <IconButton size="small" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {repo.label || repo.name}
        </Typography>
        <Chip
          size="small"
          label={`${changes.length}${repo.truncated ? "+" : ""} file${changes.length === 1 ? "" : "s"}`}
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
          {changes.map((c) => `${(c.status || "?").padEnd(3)}${c.file}`).join("\n")}
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
    regenerateRegistry,
  } = useModules();

  const {
    gitStatus,
    dirtyRepos,
    refresh: refreshGit,
    refreshWithFetch,
    devSync,
    updatePlatform,
    updateEverything,
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

  const handleUpdateModule = async (repo) => {
    await run(`Updating ${repo.name}...`, () => updateSource(repo.name));
    await refreshGit();
  };

  const handleUpdateEverything = async () => {
    const title = preBackup
      ? "Updating everything (with pre-backup)..."
      : "Updating everything...";
    await run(title, () => updateEverything({ preBackup }));
    await refreshGit();
  };

  // Derive role (platform / required / optional / user-added) for a repo name.
  // `optional` is technically never shown here because an optional catalog
  // entry that isn't installed has no .modules/ clone and therefore no row,
  // but we keep it in the mapping for completeness.
  const roleFor = (name) => {
    if (name === "platform") return "platform";
    const catalogEntry = catalog?.catalogs?.[name];
    if (catalogEntry?.required === true) return "required";
    if (catalogEntry) return "optional";
    return "user-added";
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

      <SystemUpdatesPanel
        repos={gitStatus?.repos || []}
        roleFor={roleFor}
        onRefresh={handleCheckPlatformUpdates}
        fetchingUpstream={fetchingUpstream}
        preBackup={preBackup}
        onPreBackupChange={setPreBackup}
        onUpdatePlatform={handlePlatformUpdate}
        onUpdateModule={handleUpdateModule}
        onUpdateEverything={handleUpdateEverything}
        busy={dialog.running}
        lastTickAt={gitStatus?.lastTickAt}
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
        <Typography variant="h6" sx={{ mb: 1 }}>Installed Sources</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
          Update status is shown in the System Updates panel above. Removing a source here deletes its clone under .modules/; installed containers from it must be uninstalled first.
        </Typography>
        <Divider sx={{ mb: 1.5 }} />
        {installedEntries.length === 0 ? (
          <Alert severity="warning">No module sources added yet.</Alert>
        ) : (
          installedEntries.map(([name, entry]) => (
            <InstalledSourceRow
              key={name}
              name={name}
              entry={entry}
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
