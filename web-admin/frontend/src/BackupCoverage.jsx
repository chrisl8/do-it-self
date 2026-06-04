import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
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

// Effective status for chips/sort: an acknowledged uncovered/partial entry
// is "acked" (the user has decided it's fine) rather than the underlying
// problem class.
const effectiveStatus = (entry) => (entry.ack != null ? "acked" : entry.status);

const statusChipColor = (status) => {
  switch (status) {
    case "uncovered":
      return "warning";
    case "partial":
      return "warning";
    case "unreadable":
      return "error";
    case "covered":
      return "success";
    case "acked":
      return "default";
    default:
      return "default";
  }
};

// Compact, single-line row. Wraps on narrow widths (Stack flexWrap).
// Path is rendered relative to the group key so the eye scans by name,
// not by repeated mount prefix. When `excludesUnder` is non-empty (an
// array of {pattern, samplesUnder, totalCount}), shows an inline chip
// + click-to-expand list so the user can see "this directory is covered
// in principle, but here's what's silently excluded inside it" — which
// is the only way to spot a regression like the original jellyfin one.
const CompactRow = ({ entry, groupKey, excludesUnder, onAck, onUnack }) => {
  const [excludesOpen, setExcludesOpen] = useState(false);
  const eff = effectiveStatus(entry);
  const acked = entry.ack != null;
  // Covered rows are already in the backup — there's nothing to ack.
  const ackable = !acked && entry.status !== "covered";
  const hasExcludes = (excludesUnder?.length || 0) > 0;
  // Strip the group prefix from the path for readability.
  let displayPath = entry.path;
  if (
    groupKey &&
    groupKey !== "Other" &&
    entry.path.startsWith(groupKey + "/")
  ) {
    displayPath = entry.path.slice(groupKey.length + 1);
  } else if (groupKey === entry.path) {
    displayPath = "(this mount)";
  }
  return (
    <Box
      sx={{
        py: 0.5,
        px: 1,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
      >
        <Chip
          label={eff}
          color={statusChipColor(eff)}
          size="small"
          variant={eff === "acked" ? "outlined" : "filled"}
          sx={{ minWidth: 78 }}
        />
        <Typography
          variant="body2"
          component="code"
          sx={{ flexGrow: 1, wordBreak: "break-word", minWidth: 0 }}
        >
          {displayPath}
        </Typography>
        {hasExcludes && (
          <Chip
            size="small"
            color="info"
            variant="outlined"
            label={`↘ ${excludesUnder.length} excluded`}
            onClick={() => setExcludesOpen((v) => !v)}
            sx={{ cursor: "pointer" }}
          />
        )}
        <Typography
          variant="caption"
          component="code"
          color="text.secondary"
          sx={{ minWidth: 50, textAlign: "right" }}
        >
          {entry.size_human || "?"}
        </Typography>
        <Tooltip title={entry.mtime_iso || ""}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ minWidth: 50, textAlign: "right" }}
          >
            {formatRelativeAge(entry.mtime_iso)}
          </Typography>
        </Tooltip>
        {entry.ack?.reason && (
          <Typography
            variant="caption"
            color="text.secondary"
            fontStyle="italic"
            sx={{ flexBasis: "100%", pl: "94px", mt: -0.25 }}
          >
            {entry.ack.reason}
          </Typography>
        )}
        {ackable && (
          <Button size="small" onClick={() => onAck(entry.path)}>
            Ack
          </Button>
        )}
        {acked && (
          <Button size="small" onClick={() => onUnack(entry.path)}>
            Un-ack
          </Button>
        )}
      </Stack>
      {hasExcludes && (
        <Collapse in={excludesOpen}>
          <Box
            sx={{
              mt: 0.5,
              ml: "94px",
              pl: 1,
              borderLeft: 2,
              borderColor: "info.light",
              fontSize: "0.85em",
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              component="div"
              sx={{ mb: 0.25 }}
            >
              These excludes match content inside this entry — they are
              <strong> intentionally not in the archive.</strong>
            </Typography>
            {excludesUnder.map((x) => (
              <Box key={x.pattern} sx={{ mt: 0.5 }}>
                <Typography
                  variant="caption"
                  component="code"
                  sx={{ fontWeight: "bold" }}
                >
                  {x.pattern}
                </Typography>
                <Box component="ul" sx={{ my: 0, pl: 3 }}>
                  {x.samplesUnder.slice(0, 5).map((s) => (
                    <Box
                      key={s}
                      component="li"
                      sx={{ wordBreak: "break-word" }}
                    >
                      <Typography variant="caption" component="code">
                        {s}
                      </Typography>
                    </Box>
                  ))}
                  {x.samplesUnder.length > 5 && (
                    <Box component="li">
                      <Typography variant="caption" fontStyle="italic">
                        …and {x.samplesUnder.length - 5} more sample(s)
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        </Collapse>
      )}
    </Box>
  );
};

// Map an entry path to a group key (the mount/disk it belongs to).
// /mnt/2000/... → /mnt/2000   |   /home/... → /home   |   anything else → Other
const groupKeyFor = (path) => {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "Other";
  if (parts[0] === "mnt" && parts.length >= 2) return `/mnt/${parts[1]}`;
  const known = new Set(["home", "etc", "opt", "srv", "root"]);
  if (known.has(parts[0])) return `/${parts[0]}`;
  return "Other";
};

// Stable display order: mounts (alpha), then standard FHS roots, then Other.
const GROUP_ORDER = (a, b) => {
  const score = (k) => {
    if (k === "Other") return 99;
    if (k.startsWith("/mnt/")) return 1;
    return 2;
  };
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa - sb;
  return a.localeCompare(b);
};

const MountGroup = ({
  groupKey,
  entries,
  excludesByPath,
  defaultExpanded,
  onAck,
  onUnack,
}) => {
  const [open, setOpen] = useState(defaultExpanded);
  const counts = useMemo(() => {
    const c = { covered: 0, acked: 0, needsReview: 0 };
    for (const e of entries) {
      const s = effectiveStatus(e);
      if (s === "acked") c.acked += 1;
      else if (s === "covered") c.covered += 1;
      else c.needsReview += 1;
    }
    return c;
  }, [entries]);
  // Within group: needs-review first, then partials/acked, then covered;
  // alpha within each tier so the eye can find a known path quickly.
  const sorted = useMemo(() => {
    const tier = (e) => {
      const s = effectiveStatus(e);
      if (s === "uncovered" || s === "unreadable" || s === "partial") return 0;
      if (s === "acked") return 1;
      return 2;
    };
    return [...entries].sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      return a.path.localeCompare(b.path);
    });
  }, [entries]);

  return (
    <Box sx={{ mt: 1 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        onClick={() => setOpen((v) => !v)}
        sx={{
          py: 0.75,
          px: 1,
          cursor: "pointer",
          bgcolor: "action.hover",
          borderRadius: 1,
          userSelect: "none",
        }}
      >
        <Typography variant="subtitle2" sx={{ fontFamily: "monospace" }}>
          {open ? "▼" : "▶"} {groupKey}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {counts.needsReview > 0 && (
          <Chip
            size="small"
            color="warning"
            label={`${counts.needsReview} needs review`}
          />
        )}
        {counts.acked > 0 && (
          <Chip
            size="small"
            variant="outlined"
            label={`${counts.acked} acked`}
          />
        )}
        {counts.covered > 0 && (
          <Chip
            size="small"
            color="success"
            variant="outlined"
            label={`${counts.covered} covered`}
          />
        )}
      </Stack>
      <Collapse in={open}>
        <Box>
          {sorted.map((e) => (
            <CompactRow
              key={e.path}
              entry={e}
              groupKey={groupKey}
              excludesUnder={excludesByPath?.get(e.path)}
              onAck={onAck}
              onUnack={onUnack}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};

const BackupCoverage = () => {
  const { status, acknowledge, unacknowledge, lastAckResult, clearAckResult } =
    useBackupCoverage();
  // URL-driven host selection: /backup-coverage/<host>. Lets refresh +
  // back/forward + bookmarking keep you on the host you were looking at,
  // instead of always snapping back to the local host's tab.
  const { host: urlHost } = useParams();
  const navigate = useNavigate();

  const [ackDialog, setAckDialog] = useState({
    open: false,
    path: "",
    reason: "",
  });
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [expandedSamples, setExpandedSamples] = useState({});

  const toggleSamples = (pattern) =>
    setExpandedSamples((prev) => ({ ...prev, [pattern]: !prev[pattern] }));

  // The backend now sends {localHost, hosts: [...], byHost: {host -> report}}.
  // Pick which host's report to render: URL param wins, else local host
  // (neuromancer), else first available.
  const hosts = status?.hosts || [];
  const byHost = status?.byHost || {};
  const localHost = status?.localHost || null;
  const activeHost =
    (urlHost && byHost[urlHost] && urlHost) ||
    (localHost && byHost[localHost] && localHost) ||
    hosts[0] ||
    null;

  // If the URL referenced a host we don't actually have (stale bookmark
  // for a host whose report was removed, typo, etc.), rewrite the URL to
  // the one we fell back to so the address bar stays truthful.
  useEffect(() => {
    if (!activeHost) return;
    if (urlHost && urlHost !== activeHost) {
      navigate(`/backup-coverage/${activeHost}`, { replace: true });
    }
  }, [urlHost, activeHost, navigate]);

  const setSelectedHost = (h) => {
    if (h) navigate(`/backup-coverage/${h}`);
  };
  const report = activeHost ? byHost[activeHost] : null;

  const groups = useMemo(() => {
    const entries = Array.isArray(report?.entries) ? report.entries : [];
    const byGroup = new Map();
    for (const e of entries) {
      const k = groupKeyFor(e.path);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(e);
    }
    return [...byGroup.entries()]
      .map(([groupKey, entries]) => ({ groupKey, entries }))
      .sort((a, b) => GROUP_ORDER(a.groupKey, b.groupKey));
  }, [report]);

  // For each coverage entry, find which exclude-pattern *samples* land
  // strictly inside it. This is the bridge between the two halves of the
  // audit: an entry shows as "covered" but a pattern may be silently
  // dropping content under it. Surfacing this inline is the whole point
  // of this feature — without it the user would have to read the entire
  // patterns list to verify nothing important is excluded.
  //
  // We use samples (not pattern text) so the answer is semantic: "this
  // pattern actually hit something inside this entry," not "this pattern
  // mentions a similar string". Note: samples cap at 20 per pattern, so
  // for very broad patterns (__pycache__ at 360 matches) this may
  // undercount inside any particular subtree — acceptable for the
  // "does anything important live under this exclude?" question.
  const excludesByPath = useMemo(() => {
    const result = new Map();
    const entries = Array.isArray(report?.entries) ? report.entries : [];
    const patterns = Array.isArray(report?.exclude_patterns)
      ? report.exclude_patterns
      : [];
    // Only object-shape patterns carry samples.
    if (patterns.length === 0 || typeof patterns[0] !== "object") return result;
    for (const entry of entries) {
      const matched = [];
      const prefix = entry.path === "/" ? "/" : entry.path + "/";
      for (const p of patterns) {
        if (!Array.isArray(p.samples) || p.samples.length === 0) continue;
        const under = p.samples.filter(
          (s) => s === entry.path || s.startsWith(prefix),
        );
        if (under.length > 0) {
          matched.push({
            pattern: p.pattern,
            samplesUnder: under,
            totalCount: p.match_count,
          });
        }
      }
      if (matched.length > 0) result.set(entry.path, matched);
    }
    return result;
  }, [report]);

  const openAckDialog = (path) =>
    setAckDialog({ open: true, path, reason: "" });
  const closeAckDialog = () =>
    setAckDialog({ open: false, path: "", reason: "" });

  const confirmAck = () => {
    acknowledge(activeHost, ackDialog.path, ackDialog.reason);
    closeAckDialog();
  };
  const handleUnack = (path) => unacknowledge(activeHost, path);

  if (!status) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>Loading…</Typography>
      </Box>
    );
  }

  if (hosts.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="h5" gutterBottom>
          Backup Coverage
        </Typography>
        <Alert severity="info">
          No coverage reports yet. Run{" "}
          <code>scripts/backup-coverage-audit.sh</code> on a host to populate{" "}
          <code>~/logs/coverage-reports/&lt;hostname&gt;.json</code>.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="h5">Backup Coverage</Typography>

      {hosts.length > 1 && (
        <Tabs
          value={activeHost}
          onChange={(_e, v) => setSelectedHost(v)}
          sx={{ minHeight: 36 }}
        >
          {hosts.map((h) => {
            const r = byHost[h];
            const needs = r?.summary?.needs_review ?? 0;
            return (
              <Tab
                key={h}
                value={h}
                sx={{ minHeight: 36 }}
                label={
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    useFlexGap
                  >
                    <span>{h}</span>
                    {h === localHost && (
                      <Chip label="local" size="small" variant="outlined" />
                    )}
                    {needs > 0 && (
                      <Chip label={needs} size="small" color="warning" />
                    )}
                  </Stack>
                }
              />
            );
          })}
        </Tabs>
      )}

      {report?.error ? (
        <Alert severity="info">
          {activeHost}: {report.error}
        </Alert>
      ) : (
        <>
          <Card>
            <CardContent>
              <Stack
                direction="row"
                spacing={2}
                alignItems="center"
                flexWrap="wrap"
              >
                <Typography variant="h6">
                  {report?.host || activeHost || "(unknown host)"}
                </Typography>
                <Chip
                  label={`Needs review: ${report?.summary?.needs_review ?? 0}`}
                  color={
                    (report?.summary?.needs_review ?? 0) > 0
                      ? "warning"
                      : "success"
                  }
                  size="small"
                />
                <Chip
                  label={`Acknowledged: ${report?.summary?.acknowledged ?? 0}`}
                  size="small"
                />
                <Chip
                  label={`Covered: ${report?.summary?.covered ?? 0}`}
                  color="success"
                  variant="outlined"
                  size="small"
                />
                <Typography variant="caption" color="text.secondary">
                  Audited: {formatRelativeAge(report?.audited_at)}
                  {report?.audited_at ? ` (${report.audited_at})` : ""}
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

              <Box mt={2}>
                {groups.map((g) => {
                  const hasNeedsReview = g.entries.some(
                    (e) => e.ack == null && e.status !== "covered",
                  );
                  return (
                    <MountGroup
                      key={g.groupKey}
                      groupKey={g.groupKey}
                      entries={g.entries}
                      excludesByPath={excludesByPath}
                      defaultExpanded={hasNeedsReview}
                      onAck={openAckDialog}
                      onUnack={handleUnack}
                    />
                  );
                })}
                {groups.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No entries yet — audit hasn't produced a report.
                  </Typography>
                )}
              </Box>
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
                  Exclude patterns ({(report.exclude_patterns || []).length})
                </Typography>
                <Button onClick={() => setExcludeOpen((v) => !v)}>
                  {excludeOpen ? "Hide" : "Show"}
                </Button>
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                component="div"
              >
                Patterns from <code>borgbackup/exclude-patterns.txt</code>.
                <strong> Active</strong> = pattern currently matches something
                under your backup paths.
                <strong> Idle</strong> = matches nothing today (pattern may be
                obsolete, or guarding against something not yet present). Click
                a pattern to see what it matches.
              </Typography>
              {report.exclude_matches_audited_at && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  component="div"
                  sx={{ mt: 0.5 }}
                >
                  Per-pattern matches re-scanned{" "}
                  {formatRelativeAge(report.exclude_matches_audited_at)}{" "}
                  (refreshed ~daily; ~4 min walk).
                </Typography>
              )}
              <Collapse in={excludeOpen}>
                <Box sx={{ mt: 1 }}>
                  {(() => {
                    const patterns = report.exclude_patterns || [];
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
                      .sort(
                        (a, b) => (b.match_count || 0) - (a.match_count || 0),
                      );
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
                              canExpand
                                ? () => toggleSamples(p.pattern)
                                : undefined
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
                              variant={
                                p.status === "idle" ? "outlined" : "filled"
                              }
                            />
                            <Typography
                              variant="body2"
                              component="code"
                              sx={{ flexGrow: 1, wordBreak: "break-word" }}
                            >
                              {p.pattern}
                            </Typography>
                            {p.match_count != null && (
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
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
                              Active ({active.length}) — these excludes are
                              doing work; click to verify they're catching only
                              what you intend.
                            </Typography>
                            {active.map(renderRow)}
                          </Box>
                        )}
                        {idle.length > 0 && (
                          <Box mb={1}>
                            <Typography variant="subtitle2" gutterBottom>
                              Idle ({idle.length}) — patterns that match nothing
                              today. Safe to keep as guards, or candidates for
                              removal if the original target is permanently
                              gone.
                            </Typography>
                            {idle.map(renderRow)}
                          </Box>
                        )}
                        {unknown.length > 0 && (
                          <Box mb={1}>
                            <Typography variant="subtitle2" gutterBottom>
                              Unknown ({unknown.length}) — per-pattern walk
                              hasn't run yet; will populate on next daily
                              refresh.
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
        </>
      )}

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
