import React, { useMemo, useState } from "react";
import { useTheme } from "@mui/material/styles";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import useBackupHistory from "./hooks/useBackupHistory";

const formatBytes = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDuration = (startIso, endIso) => {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const sec = Math.max(0, (end - start) / 1000);
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
};

const formatDate = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

// Thin single-hue line chart of deduplicated size over time, with a
// crosshair tooltip on hover. No axis chrome beyond a recessive baseline —
// the table below carries exact values, this is for trend-at-a-glance.
const SizeTrendChart = ({ records, hue }) => {
  const [hoverIdx, setHoverIdx] = useState(null);
  const width = 640;
  const height = 140;
  const padX = 8;
  const padY = 12;

  // Log scale: an initial full backup can be 1000x any later incremental
  // one, and a linear scale crushes every later point flat against the
  // baseline under that outlier. Log keeps relative swings between
  // incrementals visible even sharing an axis with the first full archive.
  const points = useMemo(() => {
    const logSizes = records.map((r) =>
      Math.log(Math.max(1, r.deduplicated_size ?? 0)),
    );
    const max = Math.max(...logSizes);
    const min = Math.min(...logSizes);
    const range = max - min || 1;
    const n = records.length;
    return records.map((r, i) => {
      const x = n === 1 ? width / 2 : padX + (i / (n - 1)) * (width - padX * 2);
      const y =
        height -
        padY -
        ((logSizes[i] - min) / range) * (height - padY * 2 - 4) -
        2;
      return { x, y, record: r };
    });
  }, [records]);

  if (points.length === 0) return null;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`;

  const hovered = hoverIdx != null ? points[hoverIdx] : null;

  return (
    <Box sx={{ position: "relative", width: "100%", maxWidth: width }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Deduplicated backup size trend"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <line
          x1={0}
          y1={height - 0.5}
          x2={width}
          y2={height - 0.5}
          stroke={hue.divider}
          strokeWidth={1}
        />
        <path d={areaPath} fill={hue.fill} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke={hue.line}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={4}
          fill={hue.line}
        />
        {hovered && (
          <line
            x1={hovered.x}
            y1={0}
            x2={hovered.x}
            y2={height}
            stroke={hue.divider}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {points.map((p, i) => (
          <circle
            key={p.record.name || i}
            cx={p.x}
            cy={p.y}
            r={8}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
          />
        ))}
      </svg>
      {hovered && (
        <Box
          sx={{
            position: "absolute",
            top: 0,
            left: `${Math.min(85, Math.max(0, (hovered.x / width) * 100))}%`,
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            px: 1,
            py: 0.5,
            pointerEvents: "none",
            boxShadow: 2,
            whiteSpace: "nowrap",
          }}
        >
          <Typography variant="caption" display="block">
            {formatDate(hovered.record.start)}
          </Typography>
          <Typography variant="caption" fontWeight="bold" display="block">
            {formatBytes(hovered.record.deduplicated_size)}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

const HostHistoryCard = ({ host, records, isLocal }) => {
  const theme = useTheme();
  const [showAll, setShowAll] = useState(false);

  const hue = useMemo(
    () => ({
      line: theme.palette.primary.main,
      fill:
        theme.palette.mode === "dark"
          ? `${theme.palette.primary.main}26`
          : `${theme.palette.primary.main}1a`,
      divider: theme.palette.divider,
    }),
    [theme],
  );

  if (records?.error) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6">{host}</Typography>
          <Alert severity="warning" sx={{ mt: 1 }}>
            {records.error}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const list = records || [];
  const latest = list[list.length - 1];
  // A full re-archive or a near-empty incremental (nothing changed that
  // day) can sit 100-1000x away from typical days, and even one such
  // outlier anchors the log-scale floor/ceiling and flattens everything
  // else. A short window (last week) is far less likely to catch one of
  // these than the last 10 archives was. Chart and table share the same
  // window; "Show all" widens both together so full history is still one
  // click away.
  const recentList = list.slice(-7);
  const displayed = showAll ? [...list].reverse() : [...recentList].reverse();

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mb: 1 }}
        >
          <Typography variant="h6">{host}</Typography>
          {isLocal && <Chip label="local" size="small" variant="outlined" />}
          <Chip label={`${list.length} archives`} size="small" />
          {latest && (
            <Chip
              label={`latest: ${formatBytes(latest.deduplicated_size)}`}
              size="small"
              color="primary"
              variant="outlined"
            />
          )}
        </Stack>

        {list.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No archive records yet.
          </Typography>
        ) : (
          <>
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mb: 0.5 }}
            >
              Deduplicated size trend (log scale
              {!showAll && list.length > 7 ? ", last 7 archives" : ""})
            </Typography>
            <SizeTrendChart records={showAll ? list : recentList} hue={hue} />

            <Table size="small" sx={{ mt: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell align="right">Duration</TableCell>
                  <TableCell align="right">Original</TableCell>
                  <TableCell align="right">Compressed</TableCell>
                  <TableCell align="right">Deduplicated</TableCell>
                  <TableCell align="right">Files</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {displayed.map((r) => (
                  <TableRow key={r.name || r.start}>
                    <TableCell>{formatDate(r.start)}</TableCell>
                    <TableCell align="right">
                      {formatDuration(r.start, r.end)}
                    </TableCell>
                    <TableCell align="right">
                      {formatBytes(r.original_size)}
                    </TableCell>
                    <TableCell align="right">
                      {formatBytes(r.compressed_size)}
                    </TableCell>
                    <TableCell align="right">
                      {formatBytes(r.deduplicated_size)}
                    </TableCell>
                    <TableCell align="right">
                      {r.nfiles?.toLocaleString() ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {list.length > 7 && (
              <Button
                size="small"
                onClick={() => setShowAll((v) => !v)}
                sx={{ mt: 1 }}
              >
                {showAll ? "Show fewer" : `Show all ${list.length}`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const BackupHistory = () => {
  const { status, connectionState } = useBackupHistory();

  if (!status) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity={connectionState === "disconnected" ? "error" : "info"}>
          {connectionState === "disconnected"
            ? "Disconnected from server."
            : "Loading backup history…"}
        </Alert>
      </Box>
    );
  }

  const { hosts = [], byHost = {}, localHost } = status;

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Backup History
      </Typography>
      {hosts.length === 0 ? (
        <Alert severity="info">No backup history logs found yet.</Alert>
      ) : (
        <Stack spacing={2}>
          {hosts.map((host) => (
            <HostHistoryCard
              key={host}
              host={host}
              records={byHost[host]}
              isLocal={host === localHost}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default BackupHistory;
