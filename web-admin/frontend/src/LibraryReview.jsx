import React, { useState } from "react";
import Alert from "@mui/material/Alert";
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
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import useReviewDashboard from "./hooks/useReviewDashboard";
import useWatchStats from "./hooks/useWatchStats";

const formatBytes = (n) => {
  if (n == null || Number.isNaN(n)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDate = (epoch) => {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const WatchedChip = ({ watched }) => {
  if (watched === true)
    return <Chip size="small" color="success" label="Watched" />;
  if (watched === false) return <Chip size="small" label="Not watched" />;
  return <Chip size="small" variant="outlined" label="Unknown" />;
};

const CopyHistorySection = () => {
  const { items, loading, error, refresh, deleteFromDeepthought } =
    useReviewDashboard();
  const [confirm, setConfirm] = useState(null); // { id, label }
  const [busy, setBusy] = useState(false);

  const doDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await deleteFromDeepthought(confirm.id);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">Copied to Deep Thought</Typography>
          <Button size="small" onClick={() => refresh()} disabled={loading}>
            Refresh
          </Button>
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {items.length === 0 && !loading && (
          <Typography color="text.secondary">
            Nothing copied yet, or Media Staging isn&apos;t configured on this
            host.
          </Typography>
        )}
        {items.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>Copied</TableCell>
                <TableCell>Requested by</TableCell>
                <TableCell>Watched there?</TableCell>
                <TableCell align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.label}</TableCell>
                  <TableCell>{formatBytes(item.sizeBytes)}</TableCell>
                  <TableCell>{formatDate(item.completedEpoch)}</TableCell>
                  <TableCell>{item.requestedByUsername || "—"}</TableCell>
                  <TableCell>
                    <WatchedChip watched={item.watched} />
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      color="error"
                      onClick={() =>
                        setConfirm({ id: item.id, label: item.label })
                      }
                    >
                      Delete from deepthought
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!confirm} onClose={() => !busy && setConfirm(null)}>
        <DialogTitle>Delete this copy from deepthought?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Permanently delete <strong>{confirm?.label}</strong> from
            deepthought&apos;s disk. The original on neuromancer is untouched.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={doDelete}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
};

const WatchStatsSection = () => {
  const { enabled, users, items, loading, error, refresh } = useWatchStats();
  const [filter, setFilter] = useState("");

  // enabled === null means "haven't heard back yet" (see useWatchStats) —
  // show a loading state instead of the not-configured message. The first
  // query (and any after the 2-minute cache expires) queries every user
  // against the whole library, so it's genuinely slow, not stuck.
  if (enabled === null && loading) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Household Watch Stats
          </Typography>
          <Typography color="text.secondary">
            Loading… this queries every user against your whole library, so it
            can take a minute or two the first time (or after a few minutes
            idle).
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (enabled === null && error) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Household Watch Stats
          </Typography>
          <Alert severity="error">{error}</Alert>
        </CardContent>
      </Card>
    );
  }

  if (!enabled) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Household Watch Stats
          </Typography>
          <Typography color="text.secondary">
            Not configured yet — add a Jellyfin API key for this host&apos;s
            Jellyfin (see watchStats: in user-config.yaml).
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const filtered = filter
    ? items.filter((it) => it.name.toLowerCase().includes(filter.toLowerCase()))
    : items;

  return (
    <Card>
      <CardContent>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">Household Watch Stats</Typography>
          <Button size="small" onClick={() => refresh(true)} disabled={loading}>
            Refresh
          </Button>
        </Stack>
        <TextField
          size="small"
          placeholder="Filter by title…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          sx={{ mb: 1, width: 280 }}
        />
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ maxHeight: 500, overflow: "auto" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Library</TableCell>
                {users.map((u) => (
                  <TableCell key={u}>{u}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((it) => (
                <TableRow key={it.id}>
                  <TableCell>
                    {it.name}
                    {it.kind === "series" && (
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                      >
                        {" "}
                        ({it.episodeCount} ep)
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{it.library}</TableCell>
                  {users.map((u) => {
                    const stat = it.perUser[u];
                    if (!stat) return <TableCell key={u}>—</TableCell>;
                    if (it.kind === "series") {
                      return (
                        <TableCell key={u}>
                          {stat.watchedCount === 0
                            ? "—"
                            : `${stat.watchedCount}/${stat.episodeCount} (${stat.playCount}×)`}
                        </TableCell>
                      );
                    }
                    return (
                      <TableCell key={u}>
                        {stat.played ? `✓ (${stat.playCount}×)` : "—"}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </CardContent>
    </Card>
  );
};

const LibraryReview = () => (
  <Box sx={{ p: 2 }}>
    <Stack spacing={2}>
      <CopyHistorySection />
      <WatchStatsSection />
    </Stack>
  </Box>
);

export default LibraryReview;
