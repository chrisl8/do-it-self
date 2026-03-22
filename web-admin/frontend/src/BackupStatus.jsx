import React, { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import IconButton from "@mui/material/IconButton";
import Spinner from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import TextField from "@mui/material/TextField";
import RefreshIcon from "@mui/icons-material/Refresh";
import useBackupStatus from "./hooks/useBackupStatus";

const getStatusColor = (status) => {
  switch (status) {
    case "fresh":
    case "success":
      return "success";
    case "stale":
    case "partial":
      return "warning";
    case "error":
    case "failed":
      return "error";
    case "ignored":
    case "skipped":
      return "default";
    default:
      return "default";
  }
};

const getKopiaStatusLabel = (status) => {
  switch (status) {
    case "success":
      return "All Fresh";
    case "stale":
      return "Stale Sources";
    case "error":
      return "Error";
    default:
      return status;
  }
};

const getBorgStatusLabel = (status) => {
  switch (status) {
    case "success":
      return "Success";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    default:
      return status;
  }
};

const formatTimestamp = (ts) => {
  if (!ts) return "Unknown";
  const d = new Date(ts);
  return d.toLocaleString();
};

const getHostStatus = (sources) => {
  if (sources.some((s) => s.status === "stale")) return "stale";
  if (sources.every((s) => s.status === "ignored")) return "ignored";
  return "fresh";
};

const groupByHost = (sources) => {
  if (!sources) return {};
  const grouped = {};
  for (const source of sources) {
    if (!grouped[source.host]) grouped[source.host] = [];
    grouped[source.host].push(source);
  }
  const entries = Object.entries(grouped);
  entries.sort(([aHost, aSources], [bHost, bSources]) => {
    const aStale = aSources.some((s) => s.status === "stale");
    const bStale = bSources.some((s) => s.status === "stale");
    if (aStale && !bStale) return -1;
    if (!aStale && bStale) return 1;
    return aHost.localeCompare(bHost);
  });
  return Object.fromEntries(entries);
};

const LogDialog = ({ open, onClose, title, log }) => (
  <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent>
      {log ? (
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
          {log.join("\n")}
        </Box>
      ) : (
        <Spinner />
      )}
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Close</Button>
    </DialogActions>
  </Dialog>
);

const BackupStatus = () => {
  const {
    kopiaStatus,
    kopiaLog,
    borgStatus,
    borgLog,
    kopiaCheckRunning,
    loading,
    error,
    refresh,
    fetchKopiaLog,
    fetchBorgLog,
    ignoreHosts,
    runKopiaCheck,
    saveKopiaThreshold,
    saveIgnoreHosts,
  } = useBackupStatus();
  const [expandedHosts, setExpandedHosts] = useState({});
  const [kopiaLogOpen, setKopiaLogOpen] = useState(false);
  const [borgLogOpen, setBorgLogOpen] = useState(false);
  const [thresholdInput, setThresholdInput] = useState(null);
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const [newIgnoreHost, setNewIgnoreHost] = useState("");
  const [ignoreSaving, setIgnoreSaving] = useState(false);

  const toggleHost = (host) => {
    setExpandedHosts((prev) => ({ ...prev, [host]: !prev[host] }));
  };

  const handleViewKopiaLog = async () => {
    if (!kopiaLog) await fetchKopiaLog();
    setKopiaLogOpen(true);
  };

  const handleViewBorgLog = async () => {
    if (!borgLog) await fetchBorgLog();
    setBorgLogOpen(true);
  };

  if (loading && !kopiaStatus && !borgStatus) {
    return (
      <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
        <Spinner />
      </Box>
    );
  }

  if (error && !kopiaStatus && !borgStatus) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">Failed to load backup status: {error}</Alert>
      </Box>
    );
  }

  const grouped = groupByHost(kopiaStatus?.sources);

  return (
    <Box sx={{ p: 3 }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "flex-start", sm: "center" },
          gap: { xs: 1, sm: 2 },
          mb: 3,
        }}
      >
        <Typography
          variant="h4"
          component="h1"
          sx={{ fontSize: { xs: "1.5rem", sm: "2.125rem" }, mb: 0 }}
        >
          Backup Status
        </Typography>
        {loading ? (
          <Spinner size={24} />
        ) : (
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={refresh}
          >
            Refresh
          </Button>
        )}
      </Box>

      {/* Borg Backup Section */}
      {borgStatus && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              mb: 1,
            }}
          >
            <Typography variant="h6" component="h2">
              Borg Backup
            </Typography>
            <Chip
              label={getBorgStatusLabel(borgStatus.status)}
              color={getStatusColor(borgStatus.status)}
              size="small"
            />
          </Box>

          {borgStatus.error && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {borgStatus.error}
            </Alert>
          )}

          <Card sx={{ mb: 3 }}>
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: { xs: "column", sm: "row" },
                  gap: { xs: 1, sm: 3 },
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Last Backup
                  </Typography>
                  <Typography variant="body2">
                    {formatTimestamp(borgStatus.last_backup)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Duration
                  </Typography>
                  <Typography variant="body2">
                    {borgStatus.duration}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Repo Size
                  </Typography>
                  <Typography variant="body2">
                    {borgStatus.repo_size}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Archives
                  </Typography>
                  <Typography variant="body2">
                    {borgStatus.archive_count}
                  </Typography>
                </Box>
                {borgStatus.dump_errors > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      DB Dump Errors
                    </Typography>
                    <Typography variant="body2" color="error">
                      {borgStatus.dump_errors}
                    </Typography>
                  </Box>
                )}
              </Box>

              {borgStatus.remote && borgStatus.remote.status !== "skipped" && (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mt: 1.5,
                    pt: 1.5,
                    borderTop: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    Remote:
                  </Typography>
                  <Chip
                    label={borgStatus.remote.status}
                    color={getStatusColor(borgStatus.remote.status)}
                    size="small"
                  />
                  {borgStatus.remote.duration && (
                    <Typography variant="body2" color="text.secondary">
                      {borgStatus.remote.duration}
                    </Typography>
                  )}
                  {borgStatus.remote.error && (
                    <Typography variant="body2" color="error">
                      {borgStatus.remote.error}
                    </Typography>
                  )}
                </Box>
              )}

              <Box sx={{ mt: 1.5, pt: 1, borderTop: "1px solid", borderColor: "divider" }}>
                <Button size="small" onClick={handleViewBorgLog}>
                  View Log
                </Button>
              </Box>
            </CardContent>
          </Card>
        </>
      )}

      {/* Kopia Backup Section */}
      {kopiaStatus && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              mb: 1,
            }}
          >
            <Typography variant="h6" component="h2">
              Kopia Snapshots
            </Typography>
            <Chip
              label={getKopiaStatusLabel(kopiaStatus.status)}
              color={getStatusColor(kopiaStatus.status)}
              size="small"
            />
          </Box>

          <Card sx={{ mb: 1 }}>
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: { xs: "column", sm: "row" },
                  gap: { xs: 1, sm: 3 },
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Last Checked
                  </Typography>
                  <Typography variant="body2">
                    {formatTimestamp(kopiaStatus.last_check)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Sources
                  </Typography>
                  <Typography variant="body2">
                    {kopiaStatus.total_sources}
                  </Typography>
                </Box>
                {kopiaStatus.stale_sources > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Stale
                    </Typography>
                    <Typography variant="body2" color="warning.main">
                      {kopiaStatus.stale_sources}
                    </Typography>
                  </Box>
                )}
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Threshold
                  </Typography>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <TextField
                      type="number"
                      size="small"
                      value={thresholdInput ?? kopiaStatus.threshold_hours}
                      onChange={(e) => setThresholdInput(parseInt(e.target.value, 10) || "")}
                      slotProps={{ htmlInput: { min: 1, style: { width: "4ch", padding: "2px 6px" } } }}
                      variant="outlined"
                      sx={{ "& .MuiOutlinedInput-root": { height: 24 } }}
                    />
                    <Typography variant="body2">h</Typography>
                    {thresholdInput != null && thresholdInput !== kopiaStatus.threshold_hours && (
                      <Button
                        size="small"
                        variant="contained"
                        disabled={thresholdSaving || !thresholdInput || thresholdInput < 1}
                        onClick={async () => {
                          setThresholdSaving(true);
                          try {
                            await saveKopiaThreshold(thresholdInput);
                            setThresholdInput(null);
                            await refresh();
                          } catch {
                            // threshold stays edited so user can retry
                          } finally {
                            setThresholdSaving(false);
                          }
                        }}
                      >
                        {thresholdSaving ? "Saving..." : "Save"}
                      </Button>
                    )}
                  </Box>
                </Box>
              </Box>

              {ignoreHosts != null && (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mt: 1.5,
                    pt: 1.5,
                    borderTop: "1px solid",
                    borderColor: "divider",
                    flexWrap: "wrap",
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    Ignored hosts:
                  </Typography>
                  {ignoreHosts.map((host) => (
                    <Chip
                      key={host}
                      label={host}
                      size="small"
                      onDelete={async () => {
                        setIgnoreSaving(true);
                        try {
                          await saveIgnoreHosts(ignoreHosts.filter((h) => h !== host));
                        } catch {
                          // ignore
                        } finally {
                          setIgnoreSaving(false);
                        }
                      }}
                      disabled={ignoreSaving}
                    />
                  ))}
                  {ignoreHosts.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
                      none
                    </Typography>
                  )}
                  <TextField
                    size="small"
                    placeholder="Add host"
                    value={newIgnoreHost}
                    onChange={(e) => setNewIgnoreHost(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && newIgnoreHost.trim()) {
                        setIgnoreSaving(true);
                        try {
                          await saveIgnoreHosts([...ignoreHosts, newIgnoreHost.trim()]);
                          setNewIgnoreHost("");
                        } catch {
                          // ignore
                        } finally {
                          setIgnoreSaving(false);
                        }
                      }
                    }}
                    disabled={ignoreSaving}
                    slotProps={{ htmlInput: { style: { padding: "2px 6px", width: "10ch" } } }}
                    sx={{ "& .MuiOutlinedInput-root": { height: 24 } }}
                  />
                </Box>
              )}
            </CardContent>
          </Card>

          {kopiaStatus.error && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {kopiaStatus.error}
            </Alert>
          )}

          {Object.entries(grouped).map(([host, sources]) => {
            const hostStatus = getHostStatus(sources);
            const isExpanded = expandedHosts[host] || false;

            return (
              <Card key={host} sx={{ mb: 1 }}>
                <CardContent sx={{ py: 1, "&:last-child": { pb: 1 } }}>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      cursor: "pointer",
                      flexWrap: "wrap",
                    }}
                    onClick={() => toggleHost(host)}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                      <IconButton size="small">
                        {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                      <Typography
                        variant="subtitle1"
                        sx={{ fontWeight: "bold" }}
                      >
                        {host}
                      </Typography>
                    </Box>
                    <Chip
                      label={`${sources.length} source${sources.length !== 1 ? "s" : ""}`}
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      label={hostStatus}
                      color={getStatusColor(hostStatus)}
                      size="small"
                    />
                  </Box>
                  <Collapse in={isExpanded}>
                    <Box sx={{ mt: 1, ml: { xs: 1, sm: 5 } }}>
                      {sources.map((source) => (
                        <Box
                          key={`${source.userName}:${source.path}`}
                          sx={{
                            display: "flex",
                            flexDirection: { xs: "column", sm: "row" },
                            alignItems: { xs: "flex-start", sm: "center" },
                            gap: 1,
                            py: 0.5,
                            borderBottom: "1px solid",
                            borderColor: "divider",
                            "&:last-child": { borderBottom: "none" },
                          }}
                        >
                          <Chip
                            label={source.status}
                            color={getStatusColor(source.status)}
                            size="small"
                            sx={{ minWidth: 70 }}
                          />
                          <Typography
                            variant="body2"
                            sx={{
                              fontFamily: "monospace",
                              flexGrow: 1,
                              wordBreak: "break-all",
                              minWidth: 0,
                            }}
                          >
                            {source.userName}:{source.path}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {source.ageHours}h ago
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: { xs: "block", sm: "none" } }}
                          >
                            {formatTimestamp(source.lastSnapshot)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </Collapse>
                </CardContent>
              </Card>
            );
          })}

          <Box sx={{ mt: 1, display: "flex", gap: 1 }}>
            <Button
              size="small"
              variant="contained"
              onClick={runKopiaCheck}
              disabled={kopiaCheckRunning}
            >
              {kopiaCheckRunning ? "Running Check..." : "Run Check Now"}
            </Button>
            {kopiaCheckRunning && <Spinner size={20} />}
            <Button size="small" onClick={handleViewKopiaLog}>
              View Log
            </Button>
          </Box>
        </>
      )}

      <LogDialog
        open={borgLogOpen}
        onClose={() => setBorgLogOpen(false)}
        title="Borg Backup Log"
        log={borgLog}
      />
      <LogDialog
        open={kopiaLogOpen}
        onClose={() => setKopiaLogOpen(false)}
        title="Kopia Backup Check Log"
        log={kopiaLog}
      />
    </Box>
  );
};

export default BackupStatus;
