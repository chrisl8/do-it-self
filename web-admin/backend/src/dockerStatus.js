import Docker from 'dockerode';
import esMain from 'es-main';
import scanContainerFolders from './containerFolderScanner.js';
import { getContainerIconFilename, getStackIcon } from './dockerContainerIcons.js';
import { getPendingUpdates } from './pendingUpdates.js';
import { getConfigStatus } from './configRegistry.js';

const docker = new Docker();

async function getDockerContainers() {
  const containers = await docker.listContainers({ all: false });
  return containers.map((c) => ({
    id: c.Id,
    image: c.Image,
    name: c.Names?.[0]?.replace(/^\//, '') || '',
    status: c.Status,
    state: c.State,
    ports: (c.Ports || []).map((p) => ({
      private: p.PrivatePort,
      public: p.PublicPort,
      type: p.Type,
      ip: p.IP,
    })),
    labels: c.Labels,
  }));
}

async function getFormattedDockerContainers() {
  try {
    const containers = await getDockerContainers();
    const running = {};
    const containerIconMap = {};

    if (containers && containers.length > 0) {
      for (const container of containers) {
        if (
          container.labels &&
          container.labels['com.docker.compose.project']
        ) {
          const containerName = container.name.replace(/^\//, '');
          const projectName = container.labels['com.docker.compose.project'];
          if (!running[projectName]) {
            running[projectName] = {};
          }
          const icon = getContainerIconFilename(containerName);
          container.icon = icon;
          if (icon) {
            if (!containerIconMap[projectName]) {
              containerIconMap[projectName] = [];
            }
            containerIconMap[projectName].push(icon);
          }
          running[projectName][containerName] = container;
        }
      }
    }

    const stacks = await scanContainerFolders();

    const pendingUpdates = getPendingUpdates();

    let configStatus = { containers: {} };
    try {
      configStatus = await getConfigStatus();
    } catch {
      // Config registry not set up yet -- that's fine
    }

    const stacksWithIcons = {};
    for (const [name, info] of Object.entries(stacks)) {
      const stackIcons = containerIconMap[name] || [];
      const config = configStatus.containers[name];
      stacksWithIcons[name] = {
        ...info,
        icon: getStackIcon(name, stackIcons),
        hasPendingUpdates: pendingUpdates.has(name),
        // isDisabled now reflects user-config + registry enabled state,
        // not a filesystem marker. Containers not in config are treated
        // as enabled (default).
        isDisabled: config ? !config.enabled : false,
        configReady: config?.ready ?? null,
        configMissing: config?.missing ?? [],
      };
    }

    const invalidPendingUpdates = [...pendingUpdates].filter(
      (name) => !stacks.hasOwnProperty(name),
    );
    if (invalidPendingUpdates.length > 0) {
      console.warn(
        "[dockerStatus] Invalid stack names in pending updates file:",
        invalidPendingUpdates,
      );
    }

    return { running, stacks: stacksWithIcons, invalidPendingUpdates };
  } catch (error) {
    console.error('Error fetching Docker containers:', error);
    throw error;
  }
}

if (esMain(import.meta)) {
  (async () => {
    try {
      const projectList = await getFormattedDockerContainers();
      console.log('Docker Compose Projects:', projectList);
    } catch (error) {
      console.error('Error fetching Docker containers:', error);
    }
  })();
}
export default getFormattedDockerContainers;
