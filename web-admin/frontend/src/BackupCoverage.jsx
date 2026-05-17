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
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
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

const Section = ({ title, entries, onAck, onUnack, ackable }) => {
  if (!entries || entries.length === 0) return null;

  // Sort: largest by stated size where it can be parsed, else by mtime desc.
  // Keep simple — sort by mtime desc, fall through to path.
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
      <TableContainer component={Box} sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ minWidth: 80 }}>Status</TableCell>
              <TableCell sx={{ minWidth: 60 }}>Size</TableCell>
              <TableCell sx={{ minWidth: 120 }}>Modified</TableCell>
              <TableCell>Path</TableCell>
              <TableCell sx={{ minWidth: 100 }}>Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((e) => (
              <TableRow key={e.path}>
                <TableCell>
                  <Chip
                    label={e.status}
                    color={statusChipColor(e.status)}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  <code>{e.size_human || "?"}</code>
                </TableCell>
                <TableCell>
                  <Tooltip title={e.mtime_iso || ""}>
                    <span>{formatRelativeAge(e.mtime_iso)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <code style={{ wordBreak: "break-all" }}>{e.path}</code>
                  {e.ack && e.ack.reason && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                    >
                      {e.ack.reason}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  {ackable ? (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => onAck(e.path)}
                    >
                      Acknowledge
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => onUnack(e.path)}
                    >
                      Un-ack
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

const BackupCoverage = () => {
  const {
    status,
    acknowledge,
    unacknowledge,
    lastAckResult,
    clearAckResult,
  } = useBackupCoverage();

  const [ackDialog, setAckDialog] = useState({ open: false, path: "", reason: "" });
  const [excludeOpen, setExcludeOpen] = useState(false);

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
          <Typography variant="caption" color="text.secondary">
            Patterns from <code>borgbackup/exclude-patterns.txt</code>. Review
            these periodically: a pattern that was correct years ago may now
            be silently excluding something you'd want to back up.
          </Typography>
          <Collapse in={excludeOpen}>
            <Box
              component="pre"
              sx={{
                mt: 1,
                p: 1,
                bgcolor: "background.default",
                fontSize: "0.85em",
                overflow: "auto",
                maxHeight: "40vh",
              }}
            >
              {(status.exclude_patterns || []).join("\n")}
            </Box>
          </Collapse>
        </CardContent>
      </Card>

      <Dialog open={ackDialog.open} onClose={closeAckDialog} maxWidth="sm" fullWidth>
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
