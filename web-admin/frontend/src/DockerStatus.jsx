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
import WarningIcon from "@mui/icons-material/Warning";
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
  connectionState,
  isLoading,
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

  const hasData = dockerStatus.running || dockerStatus.stacks;

  return (
    <Box sx={{ p: 3 }}>
      <style>
        {`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}
      </style>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <h1 style={{ marginBottom: 0 }}>Docker Status</h1>
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
      </Box>

      {!hasData && !isLoading && (
        <Typography color="text.secondary">
          {dockerStatus.error
            ? `Error: ${dockerStatus.error}`
            : "No Docker data available"}
        </Typography>
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
                  alignItems: "center",
                  justifyContent: { xs: "flex-start", sm: "space-between" },
                  px: 2,
                  py: 1,
                  gap: 1,
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
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {stack.icon && (
                    <Box
                      component="img"
                      src={getIconUrl(stack.icon)}
                      alt=""
                      sx={{ width: 32, height: 32 }}
                    />
                  )}
                  {containerCount > 0 && (
                    <IconButton size="small" sx={{ p: 0 }}>
                      {isStackExpanded ? (
                        <ExpandLessIcon />
                      ) : (
                        <ExpandMoreIcon />
                      )}
                    </IconButton>
                  )}
                  <Typography variant="h6" component="span">
                    {stack.name}
                  </Typography>
                  {containerCount > 0 && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      component="span"
                    >
                      ({containerCount} container
                      {containerCount !== 1 ? "s" : ""})
                    </Typography>
                  )}
                  {stack.hasPendingUpdates &&
                    !(() => {
                      const status = restartStatus?.[stack.name];
                      return (
                        status?.status === "requested" ||
                        status?.status === "in_progress"
                      );
                    })() && (
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
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip
                    label={stateDisplay.label}
                    color={stateDisplay.color}
                    size="small"
                  />
                </Box>
              </Box>

              {containerCount > 0 && (
                <Collapse in={isStackExpanded}>
                  <CardContent sx={{ pt: 0 }}>
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
                                alignItems: "center",
                                justifyContent: {
                                  xs: "flex-start",
                                  sm: "space-between",
                                },
                                px: 2,
                                py: 1,
                                gap: 1,
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
                                }}
                              >
                                {container.icon && (
                                  <Box
                                    component="img"
                                    src={getIconUrl(container.icon)}
                                    alt=""
                                    sx={{ width: 20, height: 20 }}
                                  />
                                )}
                                <IconButton size="small" sx={{ p: 0 }}>
                                  {isContainerExpanded ? (
                                    <ExpandLessIcon fontSize="small" />
                                  ) : (
                                    <ExpandMoreIcon fontSize="small" />
                                  )}
                                </IconButton>
                                <Typography
                                  variant="body1"
                                  component="span"
                                  sx={{ fontWeight: 500 }}
                                >
                                  {containerName}
                                </Typography>
                              </Box>
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 2,
                                }}
                              >
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{ minWidth: 100 }}
                                >
                                  {container.status}
                                </Typography>
                                <Chip
                                  label={container.state}
                                  color={getContainerStateColor(
                                    container.state,
                                  )}
                                  size="small"
                                  sx={{ minWidth: 70 }}
                                />
                              </Box>
                            </Box>

                            <Collapse in={isContainerExpanded}>
                              <Box
                                sx={{
                                  px: 2,
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
                                    gap: 1,
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
                                  <Typography variant="body2">
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
