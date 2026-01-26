import Docker from 'dockerode';
import getFormattedDockerContainers from './dockerStatus.js';
import { updateStatus } from './statusEmitter.js';

const docker = new Docker();
let eventStream = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

let delayedRefreshTimeout = null;
const DELAYED_REFRESH_DELAY = 2500;

let periodicRefreshInterval = null;
const PERIODIC_REFRESH_INTERVAL = 60000;

let eventStreamBuffer = '';

const IMMEDIATE_ONLY_EVENTS = [
  'stop',
  'die',
  'kill',
  'pause',
  'unpause',
  'destroy',
];

const DELAYED_REFRESH_EVENTS = ['start', 'create', 'restart'];

const RELEVANT_EVENTS = [...IMMEDIATE_ONLY_EVENTS, ...DELAYED_REFRESH_EVENTS];

async function refreshDockerStatus() {
  try {
    const dockerData = await getFormattedDockerContainers();
    dockerData.lastUpdated = new Date().toISOString();
    updateStatus('docker', dockerData);
  } catch (error) {
    console.error('Error refreshing Docker status:', error);
    updateStatus('docker', {
      error: error.message,
      lastUpdated: new Date().toISOString(),
    });
  }
}

function calculateReconnectDelay() {
  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY,
  );
  reconnectAttempts++;
  return delay;
}

function resetReconnectAttempts() {
  reconnectAttempts = 0;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

function clearDelayedRefresh() {
  if (delayedRefreshTimeout) {
    clearTimeout(delayedRefreshTimeout);
    delayedRefreshTimeout = null;
  }
}

function scheduleDelayedRefresh() {
  clearDelayedRefresh();
  delayedRefreshTimeout = setTimeout(() => {
    console.log(
      'Docker delayed refresh: Checking container states after startup',
    );
    refreshDockerStatus();
    delayedRefreshTimeout = null;
  }, DELAYED_REFRESH_DELAY);
}

function startPeriodicRefresh() {
  stopPeriodicRefresh();
  periodicRefreshInterval = setInterval(() => {
    refreshDockerStatus();
  }, PERIODIC_REFRESH_INTERVAL);
}

function stopPeriodicRefresh() {
  if (periodicRefreshInterval) {
    clearInterval(periodicRefreshInterval);
    periodicRefreshInterval = null;
  }
}

async function startWatching() {
  try {
    console.log('Docker event watcher: Starting...');

    await refreshDockerStatus();

    const filters = { type: ['container'] };
    eventStream = await docker.getEvents({ filters });

    console.log('Docker event watcher: Subscribed to container events');
    resetReconnectAttempts();

    startPeriodicRefresh();

    eventStream.on('data', (chunk) => {
      try {
        const str = eventStreamBuffer + chunk.toString();
        const lines = str.split('\n');

        if (str.endsWith('\n')) {
          eventStreamBuffer = '';
        } else {
          eventStreamBuffer = lines.pop() || '';
        }

        lines.forEach((line) => {
          if (!line) return;

          try {
            const event = JSON.parse(line);

            if (
              event.Type === 'container' &&
              event.status &&
              RELEVANT_EVENTS.includes(event.status)
            ) {
              const containerName =
                event.Actor?.Attributes?.name || event.id?.substring(0, 12);
              console.log(`Docker event: ${event.status} - ${containerName}`);

              refreshDockerStatus();

              if (DELAYED_REFRESH_EVENTS.includes(event.status)) {
                console.log(
                  `Docker event: Scheduling delayed refresh for '${event.status}' event`,
                );
                scheduleDelayedRefresh();
              }
            }
          } catch (parseError) {
            console.error(
              'Failed to parse Docker event line:',
              parseError.message,
            );
          }
        });
      } catch (error) {
        console.error('Error processing Docker event stream data:', error);
      }
    });

    eventStream.on('error', (error) => {
      console.error('Docker event stream error:', error.message);

      clearDelayedRefresh();
      stopPeriodicRefresh();
      eventStreamBuffer = '';

      if (eventStream) {
        eventStream.removeAllListeners();
        eventStream = null;
      }

      const delay = calculateReconnectDelay();
      console.log(
        `Docker event watcher: Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`,
      );

      reconnectTimeout = setTimeout(() => {
        startWatching();
      }, delay);
    });

    eventStream.on('end', () => {
      console.log('Docker event stream ended');

      clearDelayedRefresh();
      stopPeriodicRefresh();
      eventStreamBuffer = '';

      if (eventStream) {
        eventStream.removeAllListeners();
        eventStream = null;
      }

      const delay = calculateReconnectDelay();
      console.log(`Docker event watcher: Reconnecting in ${delay / 1000}s...`);

      reconnectTimeout = setTimeout(() => {
        startWatching();
      }, delay);
    });
  } catch (error) {
    console.error('Failed to start Docker event watcher:', error.message);

    clearDelayedRefresh();
    stopPeriodicRefresh();
    eventStreamBuffer = '';

    const delay = calculateReconnectDelay();
    console.log(
      `Docker event watcher: Retrying in ${delay / 1000}s (attempt ${reconnectAttempts})...`,
    );

    reconnectTimeout = setTimeout(() => {
      startWatching();
    }, delay);

    updateStatus('docker', {
      error: `Failed to connect: ${error.message}`,
      lastUpdated: new Date().toISOString(),
    });
  }
}

async function stopWatching() {
  console.log('Docker event watcher: Stopping...');

  resetReconnectAttempts();
  clearDelayedRefresh();
  stopPeriodicRefresh();
  eventStreamBuffer = '';

  if (eventStream) {
    eventStream.removeAllListeners();
    eventStream.destroy();
    eventStream = null;
  }

  console.log('Docker event watcher: Stopped');
}

async function start() {
  await startWatching();
}

async function stop() {
  await stopWatching();
}

export default { init: start, stop };
