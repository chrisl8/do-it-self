import React, { useState, useEffect, useCallback, useMemo } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Spinner from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import DeleteIcon from "@mui/icons-material/Delete";
import useMediaStaging from "./hooks/useMediaStaging";

const formatBytes = (bytes) => {
  if (bytes == null || bytes < 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GiB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
};

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const WatchedBadge = ({ played, unplayed }) => {
  if (played === true || unplayed === 0) {
    return (
      <Chip label="Watched" size="small" color="default" variant="outlined" />
    );
  }
  if (typeof unplayed === "number" && unplayed > 0) {
    return (
      <Chip
        label={`${unplayed} unwatched`}
        size="small"
        color="primary"
        variant="outlined"
      />
    );
  }
  return null;
};

const Poster = ({ itemId, hasPoster }) => {
  if (!hasPoster) {
    return (
      <Box
        sx={{
          width: 40,
          height: 60,
          borderRadius: 0.5,
          bgcolor: "action.hover",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <Box
      component="img"
      src={`/api/media-staging/poster/${itemId}`}
      alt=""
      loading="lazy"
      sx={{
        width: 40,
        height: 60,
        objectFit: "cover",
        borderRadius: 0.5,
        flexShrink: 0,
        bgcolor: "action.hover",
      }}
    />
  );
};

// ── Movie row ───────────────────────────────────────────────────
const MovieRow = ({ item, libraryName, isSelected, toggle }) => {
  const key = `movie:${item.id}`;
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      sx={{ py: 0.75, borderBottom: 1, borderColor: "divider" }}
    >
      <Checkbox
        size="small"
        checked={isSelected(key)}
        disabled={item.staged || !!item.mapError}
        onChange={() =>
          toggle(key, {
            libraryName,
            kind: "movie",
            payload: { libraryName, kind: "movie", id: item.id },
            label: item.name,
            sizeBytes: item.sizeBytes,
          })
        }
      />
      <Poster itemId={item.id} hasPoster={!!item.posterTag} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {item.name}
          {item.year ? ` (${item.year})` : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatBytes(item.sizeBytes)}
          {item.mapError ? ` · unmappable: ${item.mapError}` : ""}
        </Typography>
      </Box>
      <WatchedBadge played={item.played} />
      {item.staged && <Chip label="Staged" size="small" color="success" />}
    </Stack>
  );
};

// ── Episode row ─────────────────────────────────────────────────
const EpisodeRow = ({ episode, seriesId, libraryName, isSelected, toggle }) => {
  const key = `episode:${episode.id}`;
  const label =
    (episode.indexNumber != null ? `E${episode.indexNumber} · ` : "") +
    (episode.name || "Episode");
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ py: 0.25, pl: 4 }}
    >
      <Checkbox
        size="small"
        checked={isSelected(key)}
        disabled={episode.staged}
        onChange={() =>
          toggle(key, {
            libraryName,
            kind: "episode",
            payload: {
              libraryName,
              kind: "episode",
              seriesId,
              episodeId: episode.id,
            },
            label,
            sizeBytes: episode.sizeBytes,
          })
        }
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" noWrap component="div">
          {label}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {formatBytes(episode.sizeBytes)}
      </Typography>
      {episode.played && <Chip label="✓" size="small" variant="outlined" />}
      {episode.staged && <Chip label="Staged" size="small" color="success" />}
    </Stack>
  );
};

// ── Season row ──────────────────────────────────────────────────
const SeasonRow = ({ season, seriesId, libraryName, isSelected, toggle }) => {
  const [open, setOpen] = useState(false);
  const [episodes, setEpisodes] = useState(null);
  const [error, setError] = useState(null);
  const key = `season:${season.id}`;

  const expand = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && episodes === null) {
      try {
        const data = await fetchJson(
          `/api/media-staging/episodes?library=${encodeURIComponent(
            libraryName,
          )}&seriesId=${encodeURIComponent(seriesId)}&seasonId=${encodeURIComponent(
            season.id,
          )}`,
        );
        setEpisodes(data.episodes || []);
      } catch (e) {
        setError(e.message);
        setEpisodes([]);
      }
    }
  }, [open, episodes, libraryName, seriesId, season.id]);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ pl: 2 }}>
        <Checkbox
          size="small"
          checked={isSelected(key)}
          disabled={season.staged}
          onChange={() =>
            toggle(key, {
              libraryName,
              kind: "season",
              payload: {
                libraryName,
                kind: "season",
                seriesId,
                seasonId: season.id,
              },
              label: season.name,
              sizeBytes: null,
            })
          }
        />
        <Typography variant="body2" sx={{ flex: 1 }}>
          {season.name}
        </Typography>
        {season.staged && <Chip label="Staged" size="small" color="success" />}
        <IconButton size="small" onClick={expand}>
          {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Stack>
      <Collapse in={open}>
        {episodes === null ? (
          <Box sx={{ pl: 4, py: 1 }}>
            <Spinner size={16} />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ ml: 4, my: 0.5 }}>
            {error}
          </Alert>
        ) : (
          episodes.map((ep) => (
            <EpisodeRow
              key={ep.id}
              episode={ep}
              seriesId={seriesId}
              libraryName={libraryName}
              isSelected={isSelected}
              toggle={toggle}
            />
          ))
        )}
      </Collapse>
    </Box>
  );
};

// ── Series row ──────────────────────────────────────────────────
const SeriesRow = ({ item, libraryName, isSelected, toggle }) => {
  const [open, setOpen] = useState(false);
  const [seasons, setSeasons] = useState(null);
  const [error, setError] = useState(null);
  const key = `series:${item.id}`;

  const expand = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && seasons === null) {
      try {
        const data = await fetchJson(
          `/api/media-staging/seasons?library=${encodeURIComponent(
            libraryName,
          )}&seriesId=${encodeURIComponent(item.id)}`,
        );
        setSeasons(data.seasons || []);
      } catch (e) {
        setError(e.message);
        setSeasons([]);
      }
    }
  }, [open, seasons, libraryName, item.id]);

  return (
    <Box sx={{ borderBottom: 1, borderColor: "divider", py: 0.5 }}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Checkbox
          size="small"
          checked={isSelected(key)}
          disabled={item.staged}
          onChange={() =>
            toggle(key, {
              libraryName,
              kind: "series",
              payload: { libraryName, kind: "series", seriesId: item.id },
              label: item.name,
              sizeBytes: null,
            })
          }
        />
        <Poster itemId={item.id} hasPoster={!!item.posterTag} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {item.name}
            {item.year ? ` (${item.year})` : ""}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            whole series
          </Typography>
        </Box>
        <WatchedBadge unplayed={item.unplayedItemCount} />
        {item.staged && <Chip label="Staged" size="small" color="success" />}
        <IconButton size="small" onClick={expand}>
          {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Stack>
      <Collapse in={open}>
        <Box sx={{ mt: 0.5 }}>
          {seasons === null ? (
            <Box sx={{ pl: 4, py: 1 }}>
              <Spinner size={16} />
            </Box>
          ) : error ? (
            <Alert severity="error" sx={{ ml: 4, my: 0.5 }}>
              {error}
            </Alert>
          ) : (
            seasons.map((s) => (
              <SeasonRow
                key={s.id}
                season={s}
                seriesId={item.id}
                libraryName={libraryName}
                isSelected={isSelected}
                toggle={toggle}
              />
            ))
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

// ── Library browser ─────────────────────────────────────────────
const LibraryBrowser = ({ library, isSelected, toggle }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    fetchJson(
      `/api/media-staging/items?library=${encodeURIComponent(library.name)}`,
    )
      .then((data) => {
        if (!cancelled) setItems(data.items || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [library.name]);

  if (items === null) {
    return (
      <Box sx={{ py: 3, textAlign: "center" }}>
        <Spinner size={24} />
      </Box>
    );
  }
  if (error) return <Alert severity="error">{error}</Alert>;
  if (items.length === 0) return <Typography>No titles found.</Typography>;

  const isTv = library.collectionType === "tvshows";
  return (
    <Box>
      {items.map((it) =>
        isTv ? (
          <SeriesRow
            key={it.id}
            item={it}
            libraryName={library.name}
            isSelected={isSelected}
            toggle={toggle}
          />
        ) : (
          <MovieRow
            key={it.id}
            item={it}
            libraryName={library.name}
            isSelected={isSelected}
            toggle={toggle}
          />
        ),
      )}
    </Box>
  );
};

// ── Copy queue ──────────────────────────────────────────────────
const ACTIVE_STATES = new Set(["pending", "claimed", "copying"]);
const STATUS_LABEL = {
  pending: "waiting",
  claimed: "starting",
  copying: "copying",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const QueuePanel = ({ queue, onCancel }) => {
  if (!queue || queue.length === 0) return null;
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Copy queue
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Transfers run on the source server and push here; progress updates
          every few seconds.
        </Typography>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {queue.map((job) => {
            const pct = job.percent ?? 0;
            const active = ACTIVE_STATES.has(job.status);
            const failed = job.status === "failed";
            return (
              <Box key={job.id}>
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  flexWrap="wrap"
                >
                  <Typography
                    variant="body2"
                    sx={{ flex: 1, minWidth: 0 }}
                    noWrap
                  >
                    {job.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatBytes(job.sizeBytes)}
                  </Typography>
                  <Chip
                    label={STATUS_LABEL[job.status] || job.status}
                    size="small"
                    color={
                      job.status === "done"
                        ? "success"
                        : failed
                          ? "error"
                          : "default"
                    }
                  />
                  {active && (
                    <Button size="small" onClick={() => onCancel(job.id)}>
                      Cancel
                    </Button>
                  )}
                </Stack>
                <LinearProgress
                  variant={
                    job.status === "copying" && pct === 0
                      ? "indeterminate"
                      : "determinate"
                  }
                  value={Math.min(100, pct)}
                  color={failed ? "error" : "primary"}
                  sx={{ mt: 0.5, height: 6, borderRadius: 1 }}
                />
                <Typography variant="caption" color="text.secondary">
                  {pct}%{job.rate ? ` · ${job.rate}` : ""}
                  {job.eta ? ` · ETA ${job.eta}` : ""}
                  {failed && job.error ? ` · ${job.error}` : ""}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
};

// ── Staged-items management ─────────────────────────────────────
const StagedPanel = ({ refreshSignal }) => {
  const [staged, setStaged] = useState(null);
  const [confirm, setConfirm] = useState(null); // { path, label }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetchJson("/api/media-staging/staged")
      .then(setStaged)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  const doDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await fetchJson("/api/media-staging/staged", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: confirm.path }),
      });
      setConfirm(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const renderItem = (item, depth = 0) => (
    <Box key={item.path}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ py: 0.5, pl: depth * 3 }}
      >
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {item.label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatBytes(item.sizeBytes)}
        </Typography>
        <IconButton
          size="small"
          color="error"
          onClick={() => setConfirm({ path: item.path, label: item.label })}
          aria-label={`Delete ${item.label}`}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Stack>
      {Array.isArray(item.children) &&
        item.children.map((c) => renderItem(c, depth + 1))}
    </Box>
  );

  const libs = staged?.libraries || [];
  const anyStaged = libs.some((l) => l.items.length > 0);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Staged on this server
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {staged === null ? (
          <Spinner size={20} />
        ) : !anyStaged ? (
          <Typography variant="body2" color="text.secondary">
            Nothing staged yet.
          </Typography>
        ) : (
          libs.map((lib) =>
            lib.items.length === 0 ? null : (
              <Box key={lib.name} sx={{ mb: 1 }}>
                <Typography variant="subtitle2">{lib.name}</Typography>
                <Divider sx={{ mb: 0.5 }} />
                {lib.items.map((it) => renderItem(it))}
              </Box>
            ),
          )
        )}
      </CardContent>

      <Dialog open={!!confirm} onClose={() => !busy && setConfirm(null)}>
        <DialogTitle>Delete staged title?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Permanently delete <strong>{confirm?.label}</strong> from this
            server&apos;s Jellyfin library to free space? The original on the
            source server is untouched.
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

// ── Disk bar ────────────────────────────────────────────────────
const DiskBar = ({ disk }) => {
  if (!disk) return null;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="body2">
          Local disk: {formatBytes(disk.usedBytes)} of{" "}
          {formatBytes(disk.totalBytes)} used ({formatBytes(disk.freeBytes)}{" "}
          free)
        </Typography>
        <Typography variant="body2">{disk.pct}%</Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, disk.pct || 0)}
        color={
          disk.pct >= 90 ? "error" : disk.pct >= 75 ? "warning" : "primary"
        }
        sx={{ mt: 0.5, height: 8, borderRadius: 1 }}
      />
    </Box>
  );
};

// ── Page ────────────────────────────────────────────────────────
const MediaStaging = () => {
  const { snapshot, startCopy, cancelCopy, enqueueError, clearEnqueueError } =
    useMediaStaging();
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(() => new Map());
  const [keyDialog, setKeyDialog] = useState({
    open: false,
    sourceKey: "",
    localKey: "",
  });
  const [keySaving, setKeySaving] = useState(false);
  const [keyResult, setKeyResult] = useState(null);

  useEffect(() => {
    fetchJson("/api/media-staging/config")
      .then(setConfig)
      .catch((e) => setConfigError(e.message));
  }, []);

  const saveApiKeys = async () => {
    setKeySaving(true);
    setKeyResult(null);
    try {
      const result = await fetchJson("/api/media-staging/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceKey: keyDialog.sourceKey || undefined,
          localKey: keyDialog.localKey || undefined,
        }),
      });
      setKeyResult({ ok: true, keys: result.keys || [] });
      setKeyDialog((p) => ({ ...p, sourceKey: "", localKey: "" }));
    } catch (e) {
      setKeyResult({ ok: false, error: e.message });
    } finally {
      setKeySaving(false);
    }
  };

  const isSelected = useCallback((key) => selected.has(key), [selected]);
  const toggle = useCallback((key, obj) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, obj);
      return next;
    });
  }, []);

  const selectedTotal = useMemo(
    () =>
      Array.from(selected.values()).reduce(
        (acc, s) => acc + (typeof s.sizeBytes === "number" ? s.sizeBytes : 0),
        0,
      ),
    [selected],
  );

  const doCopy = () => {
    const selections = Array.from(selected.values()).map((s) => s.payload);
    if (selections.length === 0) return;
    startCopy(selections);
    setSelected(new Map());
  };

  // Refetch the staged list whenever another job finishes (snapshot-driven).
  const doneCount = useMemo(
    () => (snapshot?.queue || []).filter((j) => j.status === "done").length,
    [snapshot],
  );

  if (configError || (config && !config.enabled)) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">
          Media Staging is not configured on this host. Add a{" "}
          <code>mediaStaging:</code> section to{" "}
          <code>~/containers/user-config.yaml</code> (see{" "}
          <code>docs/MEDIA_STAGING_SETUP.md</code>).
          {configError ? ` (${configError})` : ""}
        </Alert>
      </Box>
    );
  }
  if (!config) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Spinner size={24} />
      </Box>
    );
  }

  const libraries = config.libraries || [];
  const currentLib = libraries[tab];
  const disk = snapshot?.disk;
  const overBudget =
    disk && selectedTotal > 0 && selectedTotal > disk.freeBytes;

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="h5">Media Staging</Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={() => {
            setKeyResult(null);
            setKeyDialog({ open: true, sourceKey: "", localKey: "" });
          }}
        >
          Jellyfin API keys
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Copy movies and shows from the main library server to this server so
        they play locally. Storage is limited — stage what you&apos;ll watch,
        then delete it when you&apos;re done.
      </Typography>

      <Card>
        <CardContent>
          <DiskBar disk={disk} />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {libraries.length > 1 && (
            <Tabs
              value={tab}
              onChange={(e, v) => setTab(v)}
              sx={{ mb: 1 }}
              variant="scrollable"
              scrollButtons="auto"
            >
              {libraries.map((l) => (
                <Tab key={l.name} label={l.name} />
              ))}
            </Tabs>
          )}
          {currentLib && (
            <LibraryBrowser
              library={currentLib}
              isSelected={isSelected}
              toggle={toggle}
            />
          )}
        </CardContent>
      </Card>

      {/* Action bar */}
      <Box
        sx={{
          position: "sticky",
          bottom: 0,
          zIndex: 2,
          bgcolor: "background.paper",
          borderTop: 1,
          borderColor: "divider",
          p: 1.5,
          display: "flex",
          alignItems: "center",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Button
          variant="contained"
          disabled={selected.size === 0}
          onClick={doCopy}
        >
          Copy {selected.size} selected ({formatBytes(selectedTotal)})
        </Button>
        {selected.size > 0 && (
          <Button onClick={() => setSelected(new Map())}>Clear</Button>
        )}
        {overBudget && (
          <Alert severity="warning" sx={{ py: 0 }}>
            Selection ({formatBytes(selectedTotal)}) exceeds free space —
            transfers will be refused once the disk is full.
          </Alert>
        )}
        {enqueueError && (
          <Alert severity="error" sx={{ py: 0 }} onClose={clearEnqueueError}>
            {enqueueError}
          </Alert>
        )}
      </Box>

      <QueuePanel queue={snapshot?.queue} onCancel={cancelCopy} />

      <StagedPanel refreshSignal={doneCount} />

      <Dialog
        open={keyDialog.open}
        onClose={() =>
          !keySaving && setKeyDialog((p) => ({ ...p, open: false }))
        }
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Jellyfin API keys</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Stored securely in Infisical via the web admin — they are never
            shown to the browser afterward. Leave a field blank to keep its
            current value. Create keys in each Jellyfin&apos;s Dashboard → API
            Keys.
          </DialogContentText>
          <TextField
            label="Source Jellyfin API key (for browsing the library)"
            type="password"
            fullWidth
            autoFocus
            sx={{ mb: 2 }}
            value={keyDialog.sourceKey}
            onChange={(e) =>
              setKeyDialog((p) => ({ ...p, sourceKey: e.target.value }))
            }
          />
          <TextField
            label="Local Jellyfin API key (optional — auto-rescan after copy)"
            type="password"
            fullWidth
            value={keyDialog.localKey}
            onChange={(e) =>
              setKeyDialog((p) => ({ ...p, localKey: e.target.value }))
            }
          />
          {keyResult && (
            <Alert severity={keyResult.ok ? "success" : "error"} sx={{ mt: 2 }}>
              {keyResult.ok
                ? `Saved: ${keyResult.keys.join(", ") || "(nothing)"}`
                : `Failed: ${keyResult.error}`}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={keySaving}
            onClick={() => setKeyDialog((p) => ({ ...p, open: false }))}
          >
            Close
          </Button>
          <Button
            variant="contained"
            disabled={
              keySaving || (!keyDialog.sourceKey && !keyDialog.localKey)
            }
            onClick={saveApiKeys}
          >
            {keySaving ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default MediaStaging;
