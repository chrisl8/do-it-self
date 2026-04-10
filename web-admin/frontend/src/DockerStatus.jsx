import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import Spinner from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UpgradeIcon from "@mui/icons-material/Upgrade";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningIcon from "@mui/icons-material/Warning";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import NewReleasesIcon from "@mui/icons-material/NewReleases";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Snackbar from "@mui/material/Snackbar";

const getRunningContainersStatus = (containers) => {
  if (!containers || Object.keys(containers).length === 0) return null;
  const states = Object.values(containers).map((c) => c.state);
  if (states.every((s) => s === "running")) return "success";
  if (states.some((s) => s === "running")) return "warning";
  return "error";
};

const getIconUrl = (icon) => {
  if (!icon) return null;
  if (icon.startsWith("fallback/")) {
    return `/dashboard-icons/${icon}`;
  }
  const ext = icon.split(".").pop();
  return `/dashboard-icons/${ext}/${icon}`;
};

const getRunningStatusLabel = (status) => {
  switch (status) {
    case "success":
      return "All Running";
    case "warning":
      return "Partial";
    case "error":
      return "Stopped";
    default:
      return "Unknown";
  }
};

const getStackState = (stackName, runningStacks, filesystemStacks) => {
  const isRunning = runningStacks && runningStacks[stackName];
  const filesystemInfo = filesystemStacks?.[stackName];

  if (isRunning) {
    return "running";
  }
  if (filesystemInfo?.isDisabled) {
    return "disabled";
  }
  if (filesystemInfo) {
    return "should_be_running";
  }
  return "unknown";
};

const getStackStateDisplay = (state, containers, restartStatus) => {
  const isRestarting =
    restartStatus?.status === "requested" ||
    restartStatus?.status === "in_progress";
  switch (state) {
    case "running": {
      const runningStatus = getRunningContainersStatus(containers);
      return {
        color: isRestarting ? "info" : runningStatus || "success",
        label: isRestarting
          ? "Running (Restarting)"
          : getRunningStatusLabel(runningStatus),
      };
    }
    case "disabled":
      return { color: "default", label: "Disabled" };
    case "should_be_running":
      return {
        color: isRestarting ? "info" : "error",
        label: isRestarting
          ? "Should Be Running (Restarting)"
          : "Should Be Running",
      };
    default:
      return { color: "warning", label: "Unknown" };
  }
};

const buildUnifiedStackList = (running, stacks) => {
  const unified = new Map();

  if (stacks) {
    for (const [name, info] of Object.entries(stacks)) {
      unified.set(name, {
        name,
        sortOrder: info.sortOrder,
        isDisabled: info.isDisabled,
        folderPath: info.folderPath,
        icon: info.icon,
        containers: {},
        isRunning: false,
        hasPendingUpdates: info.hasPendingUpdates || false,
        configReady: info.configReady ?? null,
        configMissing: info.configMissing || [],
      });
    }
  }

  if (running) {
    for (const [name, containers] of Object.entries(running)) {
      if (unified.has(name)) {
        const stack = unified.get(name);
        stack.containers = containers;
        stack.isRunning = true;
      } else {
        unified.set(name, {
          name,
          sortOrder: "z999",
          isDisabled: false,
          folderPath: null,
          icon: null,
          containers,
          isRunning: true,
          hasPendingUpdates: false,
        });
      }
    }
  }

  return Array.from(unified.values()).sort((a, b) => {
    const getPriority = (stack) => {
      if (!stack.isRunning && !stack.isDisabled) return 0;
      if (stack.isRunning) return 1;
      return 2;
    };

    const priorityA = getPriority(a);
    const priorityB = getPriority(b);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    return a.sortOrder.localeCompare(b.sortOrder, undefined, { numeric: true });
  });
};

const formatPorts = (ports) => {
  if (!ports || ports.length === 0) return null;
  const publicPorts = ports.filter((p) => p.public);
  if (publicPorts.length === 0) return null;
  return publicPorts
    .map((p) => `${p.public}:${p.private}/${p.type}`)
    .join(", ");
};

const getContainerStateColor = (state) => {
  if (state === "running") return "success";
  if (state === "exited" || state === "dead") return "error";
  return "warning";
};

const DockerStatus = ({
  dockerStatus,
  getDockerStatus,
  restartDockerStack,
  restartDockerStackWithUpgrade,
  restartStatus,
  clearRestartStatus,
  updateAllStatus,
  startUpdateAll,
  updateAllAction,
  cancelUpdateAll,
  dismissUpdateAll,
  startAllStatus,
  startAllEnabled,
  cancelStartAll,
  dismissStartAll,
  tailscalePreflightStatus,
  runTailscalePreflight,
  connectionState,
  isLoading,
  releaseNotes,
  releaseNotesLoading,
  fetchReleaseNotes,
  clearReleaseNotes,
}) => {
  const [expandedStacks, setExpandedStacks] = useState({});
  const [expandedContainers, setExpandedContainers] = useState({});
  const [filter, setFilter] = useState("all");
  const [outputDialog, setOutputDialog] = useState({
    open: false,
    stackName: null,
    output: "",
  });
  const [snackbar, setSnackbar] = useState({ open: false, message: "" });

  const handleRefresh = () => {
    getDockerStatus();
  };

  const handleRestart = (stackName, operation = "restart") => {
    if (operation === "upgrade") {
      restartDockerStackWithUpgrade(stackName);
    } else {
      restartDockerStack(stackName);
    }
    setSnackbar({ open: true, message: `Restart initiated for ${stackName}` });
  };

  const toggleStack = (stackName) => {
    setExpandedStacks((prev) => ({ ...prev, [stackName]: !prev[stackName] }));
  };

  const toggleContainer = (containerName) => {
    setExpandedContainers((prev) => ({
      ...prev,
      [containerName]: !prev[containerName],
    }));
  };

  const unifiedStacks = buildUnifiedStackList(
    dockerStatus.running,
    dockerStatus.stacks,
  );

  const filteredStacks = unifiedStacks.filter((stack) => {
    if (filter === "all") return true;
    if (filter === "pending_updates") return stack.hasPendingUpdates;
    const state = getStackState(
      stack.name,
      dockerStatus.running,
      dockerStatus.stacks,
    );
    const isRestarting =
      restartStatus?.[stack.name]?.status === "requested" ||
      restartStatus?.[stack.name]?.status === "in_progress";
    if (filter === "running") {
      return state === "running" || isRestarting;
    }
    if (filter === "should_be_running") {
      return state === "should_be_running" || isRestarting;
    }
    return state === filter;
  });

  const allCount = unifiedStacks.length;
  const runningCount = unifiedStacks.filter((stack) => {
    const state = getStackState(
      stack.name,
      dockerStatus.running,
      dockerStatus.stacks,
    );
    const isRestarting =
      restartStatus?.[stack.name]?.status === "requested" ||
      restartStatus?.[stack.name]?.status === "in_progress";
    return state === "running" || isRestarting;
  }).length;
  const shouldBeRunningCount = unifiedStacks.filter((stack) => {
    const state = getStackState(
      stack.name,
      dockerStatus.running,
      dockerStatus.stacks,
    );
    const isRestarting =
      restartStatus?.[stack.name]?.status === "requested" ||
      restartStatus?.[stack.name]?.status === "in_progress";
    return state === "should_be_running" || isRestarting;
  }).length;
  const disabledCount = unifiedStacks.filter(
    (stack) =>
      getStackState(stack.name, dockerStatus.running, dockerStatus.stacks) ===
      "disabled",
  ).length;
  const pendingUpdatesCount = unifiedStacks.filter(
    (stack) => stack.hasPendingUpdates,
  ).length;
  const startableCount = unifiedStacks.filter(
    (stack) =>
      !stack.isDisabled &&
      !stack.isRunning &&
      stack.configReady !== false,
  ).length;

  const hasData = dockerStatus.running || dockerStatus.stacks;

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 } }}>
      <style>
        {`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}
      </style>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "flex-start", sm: "center" },
          gap: { xs: 1, sm: 2 },
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography
            variant="h4"
            component="h1"
            sx={{ fontSize: { xs: "1.5rem", sm: "2.125rem" }, mb: 0 }}
          >
            Docker Status
          </Typography>
          {connectionState === "connected" && !isLoading && (
            <Chip
              label={
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: "#4caf50",
                      animation: "pulse 2s infinite",
                    }}
                  />
                  <span>Live</span>
                </Box>
              }
              color="success"
              size="small"
              sx={{
                "& .MuiChip-label": {
                  padding: 0,
                  paddingLeft: 1.5,
                  paddingRight: 1.5,
                },
              }}
            />
          )}
          {connectionState === "reconnecting" && (
            <Chip label="Reconnecting..." color="warning" size="small" />
          )}
          {connectionState === "disconnected" && (
            <Chip label="Disconnected" color="error" size="small" />
          )}
        </Box>
        {isLoading && <Spinner />}
        {!isLoading && (
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={handleRefresh}
          >
            Refresh Data
          </Button>
        )}
      </Box>

      {dockerStatus.invalidPendingUpdates?.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Invalid Stack Names in Updates File</AlertTitle>
          The following stack names in the updates file no longer exist:{" "}
          <strong>{dockerStatus.invalidPendingUpdates.join(", ")}</strong>
          <br />
          <Typography variant="caption">
            Update or remove these entries from pendingContainerUpdates.txt
            <br />
            and fix diunUpdate.sh to prevent this in the future
          </Typography>
        </Alert>
      )}

      <h2 style={{ marginTop: 0 }}>Docker Stacks</h2>

      {tailscalePreflightStatus &&
        tailscalePreflightStatus.status !== "running" && (
          <Alert
            severity={
              tailscalePreflightStatus.status === "passed"
                ? "success"
                : tailscalePreflightStatus.status === "unavailable"
                  ? "info"
                  : "error"
            }
            sx={{ mb: 2 }}
            action={
              <Button
                color="inherit"
                size="small"
                startIcon={<RefreshIcon />}
                onClick={runTailscalePreflight}
              >
                Re-check
              </Button>
            }
          >
            <AlertTitle>
              {tailscalePreflightStatus.status === "passed" &&
                "Tailscale Preflight: OK"}
              {tailscalePreflightStatus.status === "unavailable" &&
                "Tailscale Preflight: Unavailable"}
              {tailscalePreflightStatus.status === "failed" &&
                "Tailscale Preflight: Issues Found"}
            </AlertTitle>
            {tailscalePreflightStatus.status === "unavailable" && (
              <Typography variant="body2">
                {tailscalePreflightStatus.message}
              </Typography>
            )}
            {tailscalePreflightStatus.status === "failed" &&
              tailscalePreflightStatus.error && (
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {tailscalePreflightStatus.error}
                </Typography>
              )}
            {tailscalePreflightStatus.status === "failed" &&
              tailscalePreflightStatus.checks
                ?.filter((c) => !c.ok)
                .map((c) => (
                  <Typography key={c.name} variant="body2" sx={{ mt: 0.5 }}>
                    <strong>{c.name}:</strong> {c.message}
                    {c.fixUrl && (
                      <>
                        {" "}
                        <a
                          href={c.fixUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Fix
                        </a>
                      </>
                    )}
                  </Typography>
                ))}
            {tailscalePreflightStatus.status === "passed" &&
              tailscalePreflightStatus.checks?.map((c) => (
                <Typography
                  key={c.name}
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.5 }}
                >
                  {c.name}: {c.message}
                </Typography>
              ))}
          </Alert>
        )}

      {tailscalePreflightStatus?.status === "running" && (
        <Alert severity="info" icon={<Spinner size={20} />} sx={{ mb: 2 }}>
          Running Tailscale preflight checks...
        </Alert>
      )}

      {tailscalePreflightStatus?.checks
        ?.filter((c) => c.advisory && !c.ok)
        .map((c) => (
          <Alert key={c.name} severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>{c.name}</AlertTitle>
            <Typography variant="body2">
              {c.message}
              {c.fixUrl && (
                <>
                  {" — "}
                  <a
                    href={c.fixUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Renew key
                  </a>
                </>
              )}
            </Typography>
          </Alert>
        ))}

      {dockerStatus.invalidPendingUpdates?.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Invalid Stack Names in Updates File</AlertTitle>
          The following stack names in the updates file no longer exist:{" "}
          <strong>{dockerStatus.invalidPendingUpdates.join(", ")}</strong>
          <br />
          <Typography variant="caption">
            Update or remove these entries from pendingContainerUpdates.txt
          </Typography>
        </Alert>
      )}

      <Box sx={{ display: "flex", gap: 1, mb: 2, flexWrap: "wrap" }}>
        <Chip
          label={`All (${allCount})`}
          onClick={() => setFilter("all")}
          color={filter === "all" ? "primary" : "default"}
          variant={filter === "all" ? "filled" : "outlined"}
        />
        <Chip
          label={`Running (${runningCount})`}
          onClick={() => setFilter("running")}
          color={filter === "running" ? "success" : "default"}
          variant={filter === "running" ? "filled" : "outlined"}
        />
        {shouldBeRunningCount > 0 && (
          <Chip
            label={`Should Be Running (${shouldBeRunningCount})`}
            onClick={() => setFilter("should_be_running")}
            color={filter === "should_be_running" ? "error" : "default"}
            variant={filter === "should_be_running" ? "filled" : "outlined"}
          />
        )}
        <Chip
          label={`Disabled (${disabledCount})`}
          onClick={() => setFilter("disabled")}
          variant={filter === "disabled" ? "filled" : "outlined"}
        />
        {pendingUpdatesCount > 0 && (
          <Chip
            label={`Pending Updates (${pendingUpdatesCount})`}
            onClick={() => setFilter("pending_updates")}
            color={filter === "pending_updates" ? "warning" : "default"}
            variant={filter === "pending_updates" ? "filled" : "outlined"}
            icon={<WarningIcon />}
          />
        )}
        {pendingUpdatesCount > 0 &&
          (!updateAllStatus ||
            updateAllStatus.status === "completed" ||
            updateAllStatus.status === "cancelled") && (
            <Button
              variant="contained"
              color="warning"
              startIcon={<UpgradeIcon />}
              onClick={startUpdateAll}
              size="small"
            >
              Update All ({pendingUpdatesCount})
            </Button>
          )}
        {startableCount > 0 &&
          (!startAllStatus ||
            startAllStatus.status === "completed" ||
            startAllStatus.status === "cancelled") && (
            <Button
              variant="contained"
              color="success"
              startIcon={<PlayArrowIcon />}
              onClick={startAllEnabled}
              size="small"
            >
              Start All Enabled ({startableCount})
            </Button>
          )}
      </Box>

      {!hasData && !isLoading && (
        <Typography color="text.secondary">
          {dockerStatus.error
            ? `Error: ${dockerStatus.error}`
            : "No Docker data available"}
        </Typography>
      )}

      {updateAllStatus && (
        <Card
          elevation={3}
          sx={{
            mb: 2,
            border: 2,
            borderColor:
              updateAllStatus.status === "paused"
                ? "error.main"
                : updateAllStatus.status === "completed"
                  ? "success.main"
                  : updateAllStatus.status === "cancelled"
                    ? "grey.500"
                    : "info.main",
          }}
        >
          <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                mb: updateAllStatus.status === "paused" ? 1.5 : 0,
              }}
            >
              {updateAllStatus.status === "running" && (
                <Spinner size={24} />
              )}
              {updateAllStatus.status === "completed" && (
                <CheckCircleIcon color="success" />
              )}
              {updateAllStatus.status === "paused" && (
                <WarningIcon color="error" />
              )}
              {updateAllStatus.status === "cancelled" && (
                <CancelIcon color="action" />
              )}
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>
                  {updateAllStatus.status === "running" &&
                    `Updating ${updateAllStatus.completed.length + 1} of ${updateAllStatus.total}: ${updateAllStatus.current || "..."}`}
                  {updateAllStatus.status === "paused" &&
                    `Update paused — ${updateAllStatus.failed?.stackName} failed`}
                  {updateAllStatus.status === "completed" &&
                    `Updated ${updateAllStatus.completed.length} of ${updateAllStatus.total} stacks`}
                  {updateAllStatus.status === "cancelled" &&
                    `Cancelled — ${updateAllStatus.completed.length} of ${updateAllStatus.total} stacks updated`}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={
                    (updateAllStatus.completed.length / updateAllStatus.total) *
                    100
                  }
                  sx={{ mt: 0.5 }}
                />
              </Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ flexShrink: 0 }}
              >
                {updateAllStatus.completed.length} / {updateAllStatus.total}
              </Typography>
              {updateAllStatus.status === "running" && (
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  onClick={cancelUpdateAll}
                >
                  Cancel
                </Button>
              )}
              {(updateAllStatus.status === "completed" ||
                updateAllStatus.status === "cancelled") && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={dismissUpdateAll}
                >
                  Dismiss
                </Button>
              )}
            </Box>
            {updateAllStatus.status === "paused" &&
              updateAllStatus.failed && (
                <Box>
                  <Typography
                    variant="body2"
                    color="error"
                    sx={{ mb: 1 }}
                  >
                    {updateAllStatus.failed.error}
                  </Typography>
                  <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => updateAllAction("skip")}
                    >
                      Skip & Continue
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => updateAllAction("retry")}
                    >
                      Retry
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      onClick={() => updateAllAction("cancel")}
                    >
                      Cancel Remaining
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      onClick={() =>
                        setOutputDialog({
                          open: true,
                          stackName: updateAllStatus.failed.stackName,
                          output:
                            updateAllStatus.failed.output || "No output",
                        })
                      }
                    >
                      View Output
                    </Button>
                  </Box>
                </Box>
              )}
          </CardContent>
        </Card>
      )}

      {startAllStatus && (
        <Card
          elevation={3}
          sx={{
            mb: 2,
            border: 2,
            borderColor:
              startAllStatus.status === "completed" &&
              (startAllStatus.failed?.length || 0) === 0
                ? "success.main"
                : startAllStatus.status === "completed" &&
                    (startAllStatus.failed?.length || 0) > 0
                  ? "warning.main"
                  : startAllStatus.status === "cancelled"
                    ? "grey.500"
                    : "info.main",
          }}
        >
          <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                mb:
                  startAllStatus.status === "completed" &&
                  (startAllStatus.failed?.length || 0) > 0
                    ? 1.5
                    : 0,
              }}
            >
              {startAllStatus.status === "running" && <Spinner size={24} />}
              {startAllStatus.status === "completed" &&
                (startAllStatus.failed?.length || 0) === 0 && (
                  <CheckCircleIcon color="success" />
                )}
              {startAllStatus.status === "completed" &&
                (startAllStatus.failed?.length || 0) > 0 && (
                  <WarningIcon color="warning" />
                )}
              {startAllStatus.status === "cancelled" && (
                <CancelIcon color="action" />
              )}
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body1" sx={{ fontWeight: 500 }}>
                  {startAllStatus.status === "running" &&
                    `Starting ${startAllStatus.completed.length + (startAllStatus.failed?.length || 0) + 1} of ${startAllStatus.total}: ${startAllStatus.current || "..."}`}
                  {startAllStatus.status === "completed" &&
                    (startAllStatus.failed?.length || 0) === 0 &&
                    `Started ${startAllStatus.completed.length} of ${startAllStatus.total} stacks`}
                  {startAllStatus.status === "completed" &&
                    (startAllStatus.failed?.length || 0) > 0 &&
                    `Started ${startAllStatus.completed.length} of ${startAllStatus.total} stacks (${startAllStatus.failed.length} failed)`}
                  {startAllStatus.status === "cancelled" &&
                    `Cancelled — ${startAllStatus.completed.length} of ${startAllStatus.total} stacks started`}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={
                    ((startAllStatus.completed.length +
                      (startAllStatus.failed?.length || 0)) /
                      startAllStatus.total) *
                    100
                  }
                  sx={{ mt: 0.5 }}
                />
              </Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ flexShrink: 0 }}
              >
                {startAllStatus.completed.length +
                  (startAllStatus.failed?.length || 0)}{" "}
                / {startAllStatus.total}
              </Typography>
              {startAllStatus.status === "running" && (
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  onClick={cancelStartAll}
                >
                  Cancel
                </Button>
              )}
              {(startAllStatus.status === "completed" ||
                startAllStatus.status === "cancelled") && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={dismissStartAll}
                >
                  Dismiss
                </Button>
              )}
            </Box>
            {startAllStatus.status === "completed" &&
              (startAllStatus.failed?.length || 0) > 0 && (
                <Box>
                  <Typography variant="body2" color="warning.main" sx={{ mb: 1 }}>
                    Failed: {startAllStatus.failed.map((f) => f.stackName).join(", ")}
                  </Typography>
                  <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                    {startAllStatus.failed.map((f) => (
                      <Button
                        key={f.stackName}
                        variant="text"
                        size="small"
                        onClick={() =>
                          setOutputDialog({
                            open: true,
                            stackName: f.stackName,
                            output: f.output || "No output",
                          })
                        }
                      >
                        View {f.stackName} output
                      </Button>
                    ))}
                  </Box>
                </Box>
              )}
          </CardContent>
        </Card>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {filteredStacks.map((stack) => {
          const stackState = getStackState(
            stack.name,
            dockerStatus.running,
            dockerStatus.stacks,
          );
          const stateDisplay = getStackStateDisplay(
            stackState,
            stack.containers,
            restartStatus?.[stack.name],
          );
          const containerCount = Object.keys(stack.containers).length;
          const isStackExpanded = expandedStacks[stack.name] ?? false;
          const sortedContainers = Object.keys(stack.containers).sort();

          return (
            <Card
              key={stack.name}
              elevation={2}
              sx={{
                opacity: stackState === "disabled" ? 0.6 : 1,
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  flexDirection: { xs: "column", sm: "row" },
                  alignItems: { xs: "stretch", sm: "center" },
                  justifyContent: { sm: "space-between" },
                  px: { xs: 1.5, sm: 2 },
                  py: 1,
                  gap: { xs: 0.5, sm: 1 },
                  cursor: containerCount > 0 ? "pointer" : "default",
                  "&:hover":
                    containerCount > 0
                      ? {
                          backgroundColor: "action.hover",
                        }
                      : {},
                }}
                onClick={() => containerCount > 0 && toggleStack(stack.name)}
              >
                {/* Row 1: Icon + name */}
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minWidth: 0,
                  }}
                >
                  {stack.icon && (
                    <Box
                      component="img"
                      src={getIconUrl(stack.icon)}
                      alt=""
                      sx={{
                        width: { xs: 24, sm: 32 },
                        height: { xs: 24, sm: 32 },
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {containerCount > 0 && (
                    <IconButton size="small" sx={{ p: 0, flexShrink: 0 }}>
                      {isStackExpanded ? (
                        <ExpandLessIcon />
                      ) : (
                        <ExpandMoreIcon />
                      )}
                    </IconButton>
                  )}
                  <Typography
                    variant="h6"
                    component="span"
                    sx={{
                      fontSize: { xs: "1rem", sm: "1.25rem" },
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {stack.name}
                  </Typography>
                  {containerCount > 0 && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      component="span"
                      sx={{
                        display: { xs: "none", sm: "inline" },
                        flexShrink: 0,
                      }}
                    >
                      ({containerCount} container
                      {containerCount !== 1 ? "s" : ""})
                    </Typography>
                  )}
                </Box>
                {/* Row 2 on mobile / right side on desktop: status + actions */}
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    pl: { xs: stack.icon ? 4 : 0, sm: 0 },
                    flexShrink: 0,
                    flexWrap: "wrap",
                  }}
                >
                  <Chip
                    label={stateDisplay.label}
                    color={stateDisplay.color}
                    size="small"
                  />
                  {stack.configReady === false && !stack.isDisabled && (
                    <Chip
                      label="Not Configured"
                      size="small"
                      color="warning"
                      variant="outlined"
                    />
                  )}
                  {stack.hasPendingUpdates &&
                    !(() => {
                      const status = restartStatus?.[stack.name];
                      return (
                        status?.status === "requested" ||
                        status?.status === "in_progress"
                      );
                    })() &&
                    !updateAllStatus?.queue?.includes(stack.name) &&
                    updateAllStatus?.current !== stack.name && (
                      <>
                        <Tooltip title="Click to apply pending updates">
                          <Chip
                            icon={<WarningIcon />}
                            label="Update"
                            size="small"
                            color="warning"
                            sx={{ cursor: "pointer" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestart(stack.name, "upgrade");
                            }}
                          />
                        </Tooltip>
                        <Tooltip title="View release notes">
                          <Chip
                            icon={<NewReleasesIcon />}
                            label="What's new?"
                            size="small"
                            color="info"
                            variant="outlined"
                            sx={{ cursor: "pointer" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              fetchReleaseNotes(stack.name);
                            }}
                          />
                        </Tooltip>
                      </>
                    )}
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    {(() => {
                      const stackRestartStatus = restartStatus?.[stack.name];
                      const isRestarting =
                        stackRestartStatus?.status === "requested" ||
                        stackRestartStatus?.status === "in_progress";
                      const restartCompleted =
                        stackRestartStatus?.status === "completed" ||
                        stackRestartStatus?.status === "failed";
                      const isQueuedForBatch =
                        updateAllStatus?.queue?.includes(stack.name);
                      const isBatchRunning =
                        updateAllStatus?.status === "running" ||
                        updateAllStatus?.status === "paused";

                      if (isQueuedForBatch) {
                        return (
                          <Chip label="Queued" size="small" variant="outlined" />
                        );
                      }

                      if (isRestarting) {
                        return (
                          <Chip
                            icon={<Spinner size={16} />}
                            label={
                              stackRestartStatus.status === "requested"
                                ? "Requested"
                                : stackRestartStatus.operation === "upgrade"
                                  ? "Updating..."
                                  : "Restarting..."
                            }
                            size="small"
                            color="info"
                          />
                        );
                      }

                      if (restartCompleted) {
                        return (
                          <Chip
                            label={
                              stackRestartStatus.status === "completed"
                                ? `${stackRestartStatus.operation === "upgrade" ? "Update" : "Restart"} Done`
                                : `${stackRestartStatus.operation === "upgrade" ? "Update" : "Restart"} Failed`
                            }
                            size="small"
                            color={
                              stackRestartStatus.status === "completed"
                                ? "success"
                                : "error"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setOutputDialog({
                                open: true,
                                stackName: stack.name,
                                output:
                                  stackRestartStatus.output || "No output",
                              });
                            }}
                            onDelete={(e) => {
                              e.stopPropagation();
                              clearRestartStatus(stack.name);
                            }}
                          />
                        );
                      }

                      return (
                        <>
                          <IconButton
                            size="small"
                            sx={{ p: { xs: 1, sm: 0.5 } }}
                            disabled={isBatchRunning}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestart(stack.name);
                            }}
                            title="Restart stack"
                          >
                            <RestartAltIcon />
                          </IconButton>
                          <IconButton
                            size="small"
                            sx={{ p: { xs: 1, sm: 0.5 } }}
                            disabled={isBatchRunning}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestart(stack.name, "upgrade");
                            }}
                            title="Restart and Update stack"
                          >
                            <UpgradeIcon />
                          </IconButton>
                        </>
                      );
                    })()}
                  </Box>
                </Box>
              </Box>

              {containerCount > 0 && (
                <Collapse in={isStackExpanded}>
                  <CardContent sx={{ pt: 0, px: { xs: 1, sm: 2 } }}>
                    <Box
                      sx={{ display: "flex", flexDirection: "column", gap: 1 }}
                    >
                      {sortedContainers.map((containerName) => {
                        const container = stack.containers[containerName];
                        const isContainerExpanded =
                          expandedContainers[containerName] ?? false;
                        const ports = formatPorts(container.ports);

                        return (
                          <Card
                            key={containerName}
                            variant="outlined"
                            sx={{ backgroundColor: "background.default" }}
                          >
                            <Box
                              sx={{
                                display: "flex",
                                flexDirection: { xs: "column", sm: "row" },
                                alignItems: {
                                  xs: "stretch",
                                  sm: "center",
                                },
                                justifyContent: { sm: "space-between" },
                                px: { xs: 1.5, sm: 2 },
                                py: 1,
                                gap: { xs: 0.5, sm: 1 },
                                cursor: "pointer",
                                "&:hover": {
                                  backgroundColor: "action.hover",
                                },
                              }}
                              onClick={() => toggleContainer(containerName)}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 1,
                                  minWidth: 0,
                                }}
                              >
                                {container.icon && (
                                  <Box
                                    component="img"
                                    src={getIconUrl(container.icon)}
                                    alt=""
                                    sx={{
                                      width: 20,
                                      height: 20,
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <IconButton
                                  size="small"
                                  sx={{ p: 0, flexShrink: 0 }}
                                >
                                  {isContainerExpanded ? (
                                    <ExpandLessIcon fontSize="small" />
                                  ) : (
                                    <ExpandMoreIcon fontSize="small" />
                                  )}
                                </IconButton>
                                <Typography
                                  variant="body1"
                                  component="span"
                                  sx={{
                                    fontWeight: 500,
                                    fontSize: { xs: "0.875rem", sm: "1rem" },
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {containerName}
                                </Typography>
                              </Box>
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: { xs: 1, sm: 2 },
                                  pl: {
                                    xs: container.icon ? 3.5 : 0,
                                    sm: 0,
                                  },
                                  flexShrink: 0,
                                }}
                              >
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{
                                    fontSize: {
                                      xs: "0.75rem",
                                      sm: "0.875rem",
                                    },
                                  }}
                                >
                                  {container.status}
                                </Typography>
                                <Chip
                                  label={container.state}
                                  color={getContainerStateColor(
                                    container.state,
                                  )}
                                  size="small"
                                />
                              </Box>
                            </Box>

                            <Collapse in={isContainerExpanded}>
                              <Box
                                sx={{
                                  px: { xs: 1.5, sm: 2 },
                                  py: 1.5,
                                  borderTop: 1,
                                  borderColor: "divider",
                                  backgroundColor: "grey.50",
                                }}
                              >
                                <Box
                                  sx={{
                                    display: "grid",
                                    gridTemplateColumns: "auto 1fr",
                                    gap: { xs: 0.5, sm: 1 },
                                    alignItems: "start",
                                  }}
                                >
                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{ fontWeight: 500 }}
                                  >
                                    Image:
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    sx={{ wordBreak: "break-all" }}
                                  >
                                    {container.image}
                                  </Typography>

                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{ fontWeight: 500 }}
                                  >
                                    Ports:
                                  </Typography>
                                  <Typography variant="body2">
                                    {ports || "None exposed"}
                                  </Typography>

                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{ fontWeight: 500 }}
                                  >
                                    ID:
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontFamily: "monospace",
                                      fontSize: "0.75rem",
                                    }}
                                  >
                                    {container.id.substring(0, 12)}
                                  </Typography>
                                </Box>
                              </Box>
                            </Collapse>
                          </Card>
                        );
                      })}
                    </Box>
                  </CardContent>
                </Collapse>
              )}
            </Card>
          );
        })}
      </Box>

      <Dialog
        open={outputDialog.open}
        onClose={() =>
          setOutputDialog({ open: false, stackName: null, output: "" })
        }
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Restart Output: {outputDialog.stackName}</DialogTitle>
        <DialogContent>
          <Box
            component="pre"
            sx={{
              backgroundColor: "grey.100",
              p: 2,
              borderRadius: 1,
              overflow: "auto",
              maxHeight: 400,
              fontFamily: "monospace",
              fontSize: "0.875rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {outputDialog.output}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setOutputDialog({ open: false, stackName: null, output: "" });
              if (outputDialog.stackName) {
                clearRestartStatus(outputDialog.stackName);
              }
            }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={releaseNotes !== null || releaseNotesLoading}
        onClose={clearReleaseNotes}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {releaseNotesLoading
            ? "Loading release notes..."
            : releaseNotes?.error && !releaseNotes?.releases?.length
              ? "Release Notes Unavailable"
              : `What's new in ${releaseNotes?.stackName}?`}
          {releaseNotes?.currentVersion && releaseNotes?.latestVersion && (
            <Typography variant="body2" color="text.secondary">
              {releaseNotes.currentVersion} &rarr; {releaseNotes.latestVersion}
            </Typography>
          )}
          {releaseNotes?.versionNotFound && releaseNotes?.currentVersion && (
            <Typography variant="caption" color="text.secondary">
              Could not find version {releaseNotes.currentVersion} in release
              history. Showing recent releases.
            </Typography>
          )}
        </DialogTitle>
        <DialogContent dividers>
          {releaseNotesLoading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <Spinner />
            </Box>
          )}
          {releaseNotes?.error && !releaseNotes?.releases?.length && (
            <Alert severity="warning">{releaseNotes.error}</Alert>
          )}
          {releaseNotes?.releases?.length === 0 &&
            !releaseNotes?.error &&
            !releaseNotesLoading && (
              <Typography color="text.secondary">
                You are already on the latest release.
              </Typography>
            )}
          {releaseNotes?.releases?.map((release) => (
            <Box key={release.tag} sx={{ mb: 3, "&:last-child": { mb: 0 } }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {release.name || release.tag}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 1, display: "block" }}
              >
                {new Date(release.publishedAt).toLocaleDateString()}
              </Typography>
              {release.bodyHtml ? (
                <Box
                  sx={{
                    "& p": { my: 1 },
                    "& h1, & h2, & h3": { mt: 2, mb: 1 },
                    "& ul, & ol": { pl: 3 },
                    "& li": { my: 0.5 },
                    "& code": {
                      backgroundColor: "grey.100",
                      px: 0.5,
                      borderRadius: 0.5,
                      fontFamily: "monospace",
                      fontSize: "0.875em",
                    },
                    "& pre": {
                      backgroundColor: "grey.100",
                      p: 2,
                      borderRadius: 1,
                      overflow: "auto",
                      fontFamily: "monospace",
                      fontSize: "0.875rem",
                    },
                    "& a": { color: "primary.main" },
                    "& img": { maxWidth: "100%" },
                  }}
                  dangerouslySetInnerHTML={{ __html: release.bodyHtml }}
                />
              ) : (
                <Box
                  component="pre"
                  sx={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "monospace",
                    fontSize: "0.875rem",
                  }}
                >
                  {release.body}
                </Box>
              )}
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          {releaseNotes?.repoUrl && (
            <Button
              href={`${releaseNotes.repoUrl}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              startIcon={<OpenInNewIcon />}
            >
              View on GitHub
            </Button>
          )}
          <Button onClick={clearReleaseNotes}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        message={snackbar.message}
      />
    </Box>
  );
};

export default DockerStatus;
