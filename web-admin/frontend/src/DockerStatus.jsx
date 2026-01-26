import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Spinner from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import UpgradeIcon from '@mui/icons-material/Upgrade';

const getRunningContainersStatus = (containers) => {
  if (!containers || Object.keys(containers).length === 0) return null;
  const states = Object.values(containers).map((c) => c.state);
  if (states.every((s) => s === 'running')) return 'success';
  if (states.some((s) => s === 'running')) return 'warning';
  return 'error';
};

const getIconUrl = (icon) => {
  if (!icon) return null;
  if (icon.startsWith('fallback/')) {
    return `/dashboard-icons/${icon}`;
  }
  const ext = icon.split('.').pop();
  return `/dashboard-icons/${ext}/${icon}`;
};

const getRunningStatusLabel = (status) => {
  switch (status) {
    case 'success':
      return 'All Running';
    case 'warning':
      return 'Partial';
    case 'error':
      return 'Stopped';
    default:
      return 'Unknown';
  }
};

const getStackState = (stackName, runningStacks, filesystemStacks) => {
  const isRunning = runningStacks && runningStacks[stackName];
  const filesystemInfo = filesystemStacks?.[stackName];

  if (isRunning) {
    return 'running';
  }
  if (filesystemInfo?.isDisabled) {
    return 'disabled';
  }
  if (filesystemInfo) {
    return 'should_be_running';
  }
  return 'unknown';
};

const getStackStateDisplay = (state, containers) => {
  switch (state) {
    case 'running': {
      const runningStatus = getRunningContainersStatus(containers);
      return {
        color: runningStatus || 'success',
        label: getRunningStatusLabel(runningStatus),
      };
    }
    case 'disabled':
      return { color: 'default', label: 'Disabled' };
    case 'should_be_running':
      return { color: 'error', label: 'Should Be Running' };
    default:
      return { color: 'warning', label: 'Unknown' };
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
          sortOrder: 'z999',
          isDisabled: false,
          folderPath: null,
          icon: null,
          containers,
          isRunning: true,
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
  return publicPorts.map((p) => `${p.public}:${p.private}/${p.type}`).join(', ');
};

const getContainerStateColor = (state) => {
  if (state === 'running') return 'success';
  if (state === 'exited' || state === 'dead') return 'error';
  return 'warning';
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
  const [filter, setFilter] = useState('all');
  const [outputDialog, setOutputDialog] = useState({
    open: false,
    stackName: null,
    output: '',
  });

  const handleRefresh = () => {
    getDockerStatus();
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

  const unifiedStacks = buildUnifiedStackList(dockerStatus.running, dockerStatus.stacks);

  const filteredStacks = unifiedStacks.filter((stack) => {
    if (filter === 'all') return true;
    const state = getStackState(stack.name, dockerStatus.running, dockerStatus.stacks);
    return state === filter;
  });

  const hasData = dockerStatus.running || dockerStatus.stacks;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <h1 style={{ marginBottom: 0 }}>Docker Status</h1>
          {connectionState === 'connected' && !isLoading && (
            <Chip
              label="Live"
              color="success"
              size="small"
              sx={{
                '&::before': {
                  content: '""',
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: '#4caf50',
                  marginRight: '6px',
                  animation: 'pulse 2s infinite',
                },
                '@keyframes pulse': {
                  '0%, 100%': { opacity: 1 },
                  '50%': { opacity: 0.5 },
                },
              }}
            />
          )}
          {connectionState === 'reconnecting' && (
            <Chip label="Reconnecting..." color="warning" size="small" />
          )}
          {connectionState === 'disconnected' && (
            <Chip label="Disconnected" color="error" size="small" />
          )}
        </Box>
        {isLoading && <Spinner />}
        {!isLoading && (
          <button
            onClick={handleRefresh}
            style={{ height: 'fit-content', padding: '8px 16px', cursor: 'pointer' }}
          >
            Refresh Data
          </button>
        )}
      </Box>

      <h2 style={{ marginTop: 0 }}>Docker Stacks</h2>

      <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <Chip
          label="All"
          onClick={() => setFilter('all')}
          color={filter === 'all' ? 'primary' : 'default'}
          variant={filter === 'all' ? 'filled' : 'outlined'}
        />
        <Chip
          label="Running"
          onClick={() => setFilter('running')}
          color={filter === 'running' ? 'success' : 'default'}
          variant={filter === 'running' ? 'filled' : 'outlined'}
        />
        <Chip
          label="Should Be Running"
          onClick={() => setFilter('should_be_running')}
          color={filter === 'should_be_running' ? 'error' : 'default'}
          variant={filter === 'should_be_running' ? 'filled' : 'outlined'}
        />
        <Chip
          label="Disabled"
          onClick={() => setFilter('disabled')}
          variant={filter === 'disabled' ? 'filled' : 'outlined'}
        />
      </Box>

      {!hasData && !isLoading && (
        <Typography color="text.secondary">
          {dockerStatus.error ? `Error: ${dockerStatus.error}` : 'No Docker data available'}
        </Typography>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredStacks.map((stack) => {
          const stackState = getStackState(stack.name, dockerStatus.running, dockerStatus.stacks);
          const stateDisplay = getStackStateDisplay(stackState, stack.containers);
          const containerCount = Object.keys(stack.containers).length;
          const isStackExpanded = expandedStacks[stack.name] ?? false;
          const sortedContainers = Object.keys(stack.containers).sort();

          return (
            <Card
              key={stack.name}
              elevation={2}
              sx={{
                opacity: stackState === 'disabled' ? 0.6 : 1,
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: { xs: 'flex-start', sm: 'space-between' },
                  px: 2,
                  py: 1,
                  gap: 1,
                  cursor: containerCount > 0 ? 'pointer' : 'default',
                  '&:hover':
                    containerCount > 0
                      ? {
                          backgroundColor: 'action.hover',
                        }
                      : {},
                }}
                onClick={() => containerCount > 0 && toggleStack(stack.name)}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
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
                      {isStackExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
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
                      ({containerCount} container{containerCount !== 1 ? 's' : ''})
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip
                    label={stateDisplay.label}
                    color={stateDisplay.color}
                    size="small"
                  />
                  {(() => {
                    const stackRestartStatus = restartStatus?.[stack.name];
                    const isRestarting =
                      stackRestartStatus?.status === 'requested' ||
                      stackRestartStatus?.status === 'in_progress';
                    const restartCompleted =
                      stackRestartStatus?.status === 'completed' ||
                      stackRestartStatus?.status === 'failed';

                    if (isRestarting) {
                      return (
                        <Chip
                          icon={<Spinner size={16} />}
                          label={
                            stackRestartStatus.status === 'requested'
                              ? 'Requested'
                              : 'Restarting...'
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
                            stackRestartStatus.status === 'completed'
                              ? `${stackRestartStatus.operation === 'upgrade' ? 'Upgrade' : 'Restart'} Done`
                              : `${stackRestartStatus.operation === 'upgrade' ? 'Upgrade' : 'Restart'} Failed`
                          }
                          size="small"
                          color={
                            stackRestartStatus.status === 'completed'
                              ? 'success'
                              : 'error'
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setOutputDialog({
                              open: true,
                              stackName: stack.name,
                              output: stackRestartStatus.output || 'No output',
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
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            restartDockerStack(stack.name);
                          }}
                          title="Restart stack"
                        >
                          <RestartAltIcon />
                        </IconButton>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            restartDockerStackWithUpgrade(stack.name);
                          }}
                          title="Restart and Upgrade stack"
                        >
                          <UpgradeIcon />
                        </IconButton>
                      </Box>
                    );
                  })()}
                </Box>
              </Box>

              {containerCount > 0 && (
                <Collapse in={isStackExpanded}>
                  <CardContent sx={{ pt: 0 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {sortedContainers.map((containerName) => {
                        const container = stack.containers[containerName];
                        const isContainerExpanded = expandedContainers[containerName] ?? false;
                        const ports = formatPorts(container.ports);

                        return (
                          <Card
                            key={containerName}
                            variant="outlined"
                            sx={{ backgroundColor: 'background.default' }}
                          >
                            <Box
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: { xs: 'flex-start', sm: 'space-between' },
                                px: 2,
                                py: 1,
                                gap: 1,
                                cursor: 'pointer',
                                '&:hover': {
                                  backgroundColor: 'action.hover',
                                },
                              }}
                              onClick={() => toggleContainer(containerName)}
                            >
                              <Box
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
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
                                  display: 'flex',
                                  alignItems: 'center',
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
                                  color={getContainerStateColor(container.state)}
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
                                  borderColor: 'divider',
                                  backgroundColor: 'grey.50',
                                }}
                              >
                                <Box
                                  sx={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto 1fr',
                                    gap: 1,
                                    alignItems: 'start',
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
                                    {ports || 'None exposed'}
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
                                      fontFamily: 'monospace',
                                      fontSize: '0.75rem',
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
        onClose={() => setOutputDialog({ open: false, stackName: null, output: '' })}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Restart Output: {outputDialog.stackName}</DialogTitle>
        <DialogContent>
          <Box
            component="pre"
            sx={{
              backgroundColor: 'grey.100',
              p: 2,
              borderRadius: 1,
              overflow: 'auto',
              maxHeight: 400,
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {outputDialog.output}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setOutputDialog({ open: false, stackName: null, output: '' });
              if (outputDialog.stackName) {
                clearRestartStatus(outputDialog.stackName);
              }
            }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DockerStatus;
