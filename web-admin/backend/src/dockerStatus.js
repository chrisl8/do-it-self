import Docker from 'dockerode';
import esMain from 'es-main';
import scanContainerFolders from './containerFolderScanner.js';
import { getContainerIconFilename, getStackIcon } from './dockerContainerIcons.js';
import { getPendingUpdates } from './pendingUpdates.js';

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

    const stacksWithIcons = {};
    for (const [name, info] of Object.entries(stacks)) {
      const stackIcons = containerIconMap[name] || [];
      stacksWithIcons[name] = {
        ...info,
        icon: getStackIcon(name, stackIcons),
        hasPendingUpdates: pendingUpdates.has(name),
      };
    }

    return { running, stacks: stacksWithIcons };
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
