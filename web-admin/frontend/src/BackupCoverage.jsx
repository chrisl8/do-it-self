import React, { useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useBackupCoverage from "./hooks/useBackupCoverage";

const formatRelativeAge = (iso) => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ageSec = (Date.now() - t) / 1000;
  if (ageSec < 60) return `${Math.floor(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
};

const statusChipColor = (status) => {
  switch (status) {
    case "uncovered":
      return "warning";
    case "partial":
      return "info";
    case "unreadable":
      return "error";
    case "covered":
      return "success";
    default:
      return "default";
  }
};

// Entry layout: chip + size + mtime on the top row (allowed to wrap on
// very narrow widths), action button right-aligned, path always on its
// own line below so long paths never crush other columns. Same shape on
// desktop and mobile — mobile-friendly without `useMediaQuery` branching.
const EntryRow = ({ entry, onAck, onUnack, ackable }) => (
  <Box
    sx={{
      py: 1.25,
      borderBottom: 1,
      borderColor: "divider",
      "&:last-of-type": { borderBottom: 0 },
    }}
  >
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
    >
      <Chip
        label={entry.status}
        color={statusChipColor(entry.status)}
        size="small"
      />
      <Typography variant="body2" component="code">
        {entry.size_human || "?"}
      </Typography>
      <Tooltip title={entry.mtime_iso || ""}>
        <Typography variant="body2" color="text.secondary">
          {formatRelativeAge(entry.mtime_iso)}
        </Typography>
      </Tooltip>
      <Box sx={{ flexGrow: 1 }} />
      {ackable ? (
        <Button size="small" variant="text" onClick={() => onAck(entry.path)}>
          Acknowledge
        </Button>
      ) : (
        <Button size="small" variant="text" onClick={() => onUnack(entry.path)}>
          Un-ack
        </Button>
      )}
    </Stack>
    <Typography
      variant="body2"
      component="code"
      sx={{
        display: "block",
        mt: 0.5,
        wordBreak: "break-word",
        overflowWrap: "anywhere",
      }}
    >
      {entry.path}
    </Typography>
    {entry.ack && entry.ack.reason && (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 0.25 }}
      >
        {entry.ack.reason}
      </Typography>
    )}
  </Box>
);

const Section = ({ title, entries, onAck, onUnack, ackable }) => {
  if (!entries || entries.length === 0) return null;

  // Sort by mtime desc, then path. Newer entries (likely the user's recent
  // activity) bubble up.
  const sorted = [...entries].sort((a, b) => {
    const at = a.mtime_iso ? Date.parse(a.mtime_iso) : 0;
    const bt = b.mtime_iso ? Date.parse(b.mtime_iso) : 0;
    if (bt !== at) return bt - at;
    return a.path.localeCompare(b.path);
  });

  return (
    <Box mt={2}>
      <Typography variant="subtitle1" gutterBottom>
        {title} ({entries.length})
      </Typography>
      <Box>
        {sorted.map((e) => (
          <EntryRow
            key={e.path}
            entry={e}
            onAck={onAck}
            onUnack={onUnack}
            ackable={ackable}
          />
        ))}
      </Box>
    </Box>
  );
};

const BackupCoverage = () => {
  const { status, acknowledge, unacknowledge, lastAckResult, clearAckResult } =
    useBackupCoverage();

  const [ackDialog, setAckDialog] = useState({
    open: false,
    path: "",
    reason: "",
  });
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [expandedSamples, setExpandedSamples] = useState({});

  const toggleSamples = (pattern) =>
    setExpandedSamples((prev) => ({ ...prev, [pattern]: !prev[pattern] }));

  const partitioned = useMemo(() => {
    const entries = Array.isArray(status?.entries) ? status.entries : [];
    const needsReview = entries.filter(
      (e) =>
        (e.status === "uncovered" ||
          e.status === "partial" ||
          e.status === "unreadable") &&
        e.ack == null,
    );
    const acknowledged = entries.filter((e) => e.ack != null);
    const covered = entries.filter((e) => e.status === "covered");
    return { needsReview, acknowledged, covered };
  }, [status]);

  const openAckDialog = (path) =>
    setAckDialog({ open: true, path, reason: "" });
  const closeAckDialog = () =>
    setAckDialog({ open: false, path: "", reason: "" });

  const confirmAck = () => {
    acknowledge(ackDialog.path, ackDialog.reason);
    closeAckDialog();
  };

  if (!status) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>Loading…</Typography>
      </Box>
    );
  }

  if (status.error) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="h5" gutterBottom>
          Backup Coverage
        </Typography>
        <Alert severity="info">{status.error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="h5">Backup Coverage</Typography>

      <Card>
        <CardContent>
          <Stack
            direction="row"
            spacing={2}
            alignItems="center"
            flexWrap="wrap"
          >
            <Typography variant="h6">
              {status.host || "(unknown host)"}
            </Typography>
            <Chip
              label={`Needs review: ${status.summary?.needs_review ?? 0}`}
              color={
                (status.summary?.needs_review ?? 0) > 0 ? "warning" : "success"
              }
              size="small"
            />
            <Chip
              label={`Acknowledged: ${status.summary?.acknowledged ?? 0}`}
              size="small"
            />
            <Chip
              label={`Covered: ${status.summary?.covered ?? 0}`}
              color="success"
              variant="outlined"
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              Audited: {formatRelativeAge(status.audited_at)}
              {status.audited_at ? ` (${status.audited_at})` : ""}
            </Typography>
          </Stack>

          {lastAckResult && (
            <Alert
              severity={lastAckResult.ok ? "success" : "error"}
              sx={{ mt: 2 }}
              onClose={clearAckResult}
            >
              {lastAckResult.ok
                ? `Acknowledgement updated for ${lastAckResult.path}.`
                : `Failed: ${lastAckResult.error}`}
            </Alert>
          )}

          <Section
            title="Needs review"
            entries={partitioned.needsReview}
            onAck={openAckDialog}
            ackable={true}
          />

          <Divider sx={{ mt: 3 }} />

          <Section
            title="Acknowledged"
            entries={partitioned.acknowledged}
            onUnack={unacknowledge}
            ackable={false}
          />

          <Divider sx={{ mt: 3 }} />

          <Section
            title="Covered (FYI)"
            entries={partitioned.covered}
            ackable={false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
          >
            <Typography variant="h6">
              Exclude patterns ({(status.exclude_patterns || []).length})
            </Typography>
            <Button onClick={() => setExcludeOpen((v) => !v)}>
              {excludeOpen ? "Hide" : "Show"}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div">
            Patterns from <code>borgbackup/exclude-patterns.txt</code>.
            <strong> Active</strong> = pattern currently matches something under
            your backup paths.
            <strong> Idle</strong> = matches nothing today (pattern may be
            obsolete, or guarding against something not yet present). Click a
            pattern to see what it matches.
          </Typography>
          {status.exclude_matches_audited_at && (
            <Typography
              variant="caption"
              color="text.secondary"
              component="div"
              sx={{ mt: 0.5 }}
            >
              Per-pattern matches re-scanned{" "}
              {formatRelativeAge(status.exclude_matches_audited_at)} (refreshed
              ~daily; ~4 min walk).
            </Typography>
          )}
          <Collapse in={excludeOpen}>
            <Box sx={{ mt: 1 }}>
              {(() => {
                const patterns = status.exclude_patterns || [];
                // Detect new rich object shape vs. legacy bare-string shape.
                const isRich =
                  patterns.length > 0 && typeof patterns[0] === "object";

                if (!isRich) {
                  return (
                    <Box
                      component="pre"
                      sx={{
                        p: 1,
                        bgcolor: "background.default",
                        fontSize: "0.85em",
                        overflow: "auto",
                        maxHeight: "40vh",
                      }}
                    >
                      {patterns.join("\n")}
                    </Box>
                  );
                }

                const active = patterns
                  .filter((p) => p.status === "active")
                  .sort((a, b) => (b.match_count || 0) - (a.match_count || 0));
                const idle = patterns.filter((p) => p.status === "idle");
                const unknown = patterns.filter(
                  (p) => p.status !== "active" && p.status !== "idle",
                );

                const renderRow = (p) => {
                  const isOpen = !!expandedSamples[p.pattern];
                  const canExpand =
                    p.status === "active" && (p.samples || []).length > 0;
                  return (
                    <Box
                      key={p.pattern}
                      sx={{
                        py: 0.75,
                        borderBottom: 1,
                        borderColor: "divider",
                        "&:last-of-type": { borderBottom: 0 },
                      }}
                    >
                      <Stack
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                        onClick={
                          canExpand ? () => toggleSamples(p.pattern) : undefined
                        }
                        sx={{ cursor: canExpand ? "pointer" : "default" }}
                      >
                        <Chip
                          label={p.status}
                          size="small"
                          color={
                            p.status === "active"
                              ? "info"
                              : p.status === "idle"
                                ? "default"
                                : "default"
                          }
                          variant={p.status === "idle" ? "outlined" : "filled"}
                        />
                        <Typography
                          variant="body2"
                          component="code"
                          sx={{ flexGrow: 1, wordBreak: "break-word" }}
                        >
                          {p.pattern}
                        </Typography>
                        {p.match_count != null && (
                          <Typography variant="body2" color="text.secondary">
                            {p.match_count} match
                            {p.match_count === 1 ? "" : "es"}
                          </Typography>
                        )}
                      </Stack>
                      {canExpand && isOpen && (
                        <Box
                          component="ul"
                          sx={{
                            mt: 0.5,
                            mb: 0,
                            pl: 4,
                            fontSize: "0.85em",
                            color: "text.secondary",
                          }}
                        >
                          {p.samples.map((s) => (
                            <Box
                              key={s}
                              component="li"
                              sx={{ wordBreak: "break-word" }}
                            >
                              <code>{s}</code>
                            </Box>
                          ))}
                          {p.match_count > p.samples.length && (
                            <Box component="li">
                              <em>
                                …and {p.match_count - p.samples.length} more
                              </em>
                            </Box>
                          )}
                        </Box>
                      )}
                    </Box>
                  );
                };

                return (
                  <>
                    {active.length > 0 && (
                      <Box mb={2}>
                        <Typography variant="subtitle2" gutterBottom>
                          Active ({active.length}) — these excludes are doing
                          work; click to verify they're catching only what you
                          intend.
                        </Typography>
                        {active.map(renderRow)}
                      </Box>
                    )}
                    {idle.length > 0 && (
                      <Box mb={1}>
                        <Typography variant="subtitle2" gutterBottom>
                          Idle ({idle.length}) — patterns that match nothing
                          today. Safe to keep as guards, or candidates for
                          removal if the original target is permanently gone.
                        </Typography>
                        {idle.map(renderRow)}
                      </Box>
                    )}
                    {unknown.length > 0 && (
                      <Box mb={1}>
                        <Typography variant="subtitle2" gutterBottom>
                          Unknown ({unknown.length}) — per-pattern walk hasn't
                          run yet; will populate on next daily refresh.
                        </Typography>
                        {unknown.map(renderRow)}
                      </Box>
                    )}
                  </>
                );
              })()}
            </Box>
          </Collapse>
        </CardContent>
      </Card>

      <Dialog
        open={ackDialog.open}
        onClose={closeAckDialog}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Acknowledge path</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Mark <code>{ackDialog.path}</code> as known-and-intentional so the
            audit stops flagging it. The path stays in the Acknowledged list
            (visible but collapsed) so you can revisit later.
          </DialogContentText>
          <TextField
            label="Reason (optional)"
            placeholder="e.g. ephemeral scratch space; downloads I don't care about"
            fullWidth
            value={ackDialog.reason}
            onChange={(e) =>
              setAckDialog((prev) => ({ ...prev, reason: e.target.value }))
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAckDialog}>Cancel</Button>
          <Button onClick={confirmAck} variant="contained">
            Acknowledge
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default BackupCoverage;
