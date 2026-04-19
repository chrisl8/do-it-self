import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";

function formatRelative(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return iso;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

// Derive a status chip from a repo's upstream state. Returns { label, color,
// behindAction } — behindAction is true when the "Update" button should be
// enabled for this row.
function statusOf(repo) {
  if (!repo.clean) return { label: "uncommitted changes", color: "warning", canUpdate: false };
  if (!repo.upstream) return { label: "no upstream", color: "warning", canUpdate: false };
  if (repo.ahead > 0 && repo.behind === 0) return { label: `${repo.ahead} ahead`, color: "error", canUpdate: false };
  if (repo.ahead > 0 && repo.behind > 0) return { label: "diverged", color: "error", canUpdate: false };
  if (repo.behind > 0) return { label: `${repo.behind} behind`, color: "info", canUpdate: true };
  return { label: "up to date", color: "success", canUpdate: false };
}

// One row per repo (platform or module). Consistent layout regardless of role.
function RepoRow({
  role,             // "platform" | "required" | "optional" | "user-added"
  repo,             // { name, branch, upstream, ahead, behind, clean, fetchedAt }
  onUpdate,
  extraControls,    // JSX slotted to the right of Update (pre-backup checkbox, etc.)
  busy,
}) {
  const status = statusOf(repo);
  const roleLabel = {
    platform: "platform",
    required: "required module",
    optional: "optional module",
    "user-added": "user-added",
  }[role] || role;
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: "minmax(180px, 1.3fr) minmax(120px, 0.8fr) minmax(150px, 1fr) auto" },
        alignItems: "center",
        gap: 1.5,
        py: 1.25,
        px: 1.5,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
      }}
    >
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{repo.name}</Typography>
        <Typography variant="caption" color="text.secondary">{roleLabel}</Typography>
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {repo.branch || "?"} → {repo.upstream || "(no upstream)"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          checked {formatRelative(repo.fetchedAt)}
        </Typography>
      </Box>
      <Box>
        <Chip size="small" label={status.label} color={status.color} variant={status.color === "success" ? "outlined" : "filled"} />
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {extraControls}
        <Button
          size="small"
          variant="contained"
          onClick={() => onUpdate(repo)}
          disabled={busy || !status.canUpdate}
        >
          Update
        </Button>
      </Box>
    </Box>
  );
}

// The unified "System Updates" panel. Shows the platform repo and every
// installed module as a uniform set of rows with behind-counts and per-row
// update buttons. Header has Refresh, and "Update everything" when anything
// is actually behind.
function SystemUpdatesPanel({
  repos,                      // array of platform + module repo status objects
  roleFor,                    // (name) => "platform" | "required" | "optional" | "user-added"
  onRefresh,                  // manual refresh (runs git fetch server-side)
  fetchingUpstream,           // boolean
  preBackup,
  onPreBackupChange,
  onUpdatePlatform,           // (repo) => void
  onUpdateModule,             // (repo) => void
  onUpdateEverything,         // () => void  (null if nothing to update)
  busy,
  lastTickAt,
}) {
  const anyBehind = (repos || []).some((r) => r.clean && r.behind > 0 && r.ahead === 0);
  const anyBlocked = (repos || []).some((r) => !r.clean || r.ahead > 0);

  return (
    <Box sx={{ mb: 3, border: 1, borderColor: "divider", borderRadius: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>System Updates</Typography>
        <Typography variant="caption" color="text.secondary">
          last checked {formatRelative(lastTickAt)}
        </Typography>
        <Tooltip title="Check upstream for new commits">
          <span>
            <IconButton size="small" onClick={onRefresh} disabled={busy || fetchingUpstream}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={
          anyBehind
            ? "Update platform, then every module that is behind upstream"
            : "Nothing is behind upstream"
        }>
          <span>
            <Button
              size="small"
              variant="contained"
              disabled={busy || !anyBehind}
              onClick={onUpdateEverything}
            >
              Update everything
            </Button>
          </span>
        </Tooltip>
      </Box>

      {anyBlocked && (
        <Alert severity="warning" sx={{ borderRadius: 0 }}>
          One or more repos have uncommitted changes or local commits ahead of upstream. Those rows are blocked from updating — resolve on the CLI.
        </Alert>
      )}

      {(repos || []).length === 0 && (
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary">
            No repos to show yet — the background poller runs every 15 minutes; click refresh above to check now.
          </Typography>
        </Box>
      )}

      {(repos || []).map((repo) => {
        const role = roleFor(repo.name);
        const isPlatform = role === "platform";
        return (
          <RepoRow
            key={repo.name}
            role={role}
            repo={repo}
            busy={busy}
            onUpdate={isPlatform ? onUpdatePlatform : onUpdateModule}
            extraControls={isPlatform ? (
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={!!preBackup}
                    onChange={(e) => onPreBackupChange(e.target.checked)}
                    disabled={busy}
                  />
                }
                label={<Typography variant="caption">borg backup first</Typography>}
                sx={{ mr: 1 }}
              />
            ) : null}
          />
        );
      })}
    </Box>
  );
}

export default SystemUpdatesPanel;
