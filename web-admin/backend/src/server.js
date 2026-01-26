import express from 'express';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import os from 'os';
import 'dotenv/config';
import getFormattedDockerContainers from './dockerStatus.js';
import { statusEmitter, getStatus } from './statusEmitter.js';

const fileName = fileURLToPath(import.meta.url);
const dirName = dirname(fileName);

const app = express();

const CONTAINERS_DIR = join(os.homedir(), 'containers');
const ICONS_BASE_DIR = join(CONTAINERS_DIR, 'homepage/dashboard-icons');

app.use(express.static(join(dirName, '../public')));

app.use(
  '/dashboard-icons/svg',
  express.static(join(ICONS_BASE_DIR, 'svg')),
);
app.use(
  '/dashboard-icons/png',
  express.static(join(ICONS_BASE_DIR, 'png')),
);
app.use(
  '/dashboard-icons/webp',
  express.static(join(ICONS_BASE_DIR, 'webp')),
);
app.use(
  '/dashboard-icons/fallback',
  express.static(join(CONTAINERS_DIR, 'homepage/icons')),
);

// Catch-all route for SPA - serve index.html for all non-file routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/dashboard-icons/')) {
    return next();
  }
  const indexPath = join(dirName, '../public/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Error sending index.html:', err);
      res.status(500).send('Error loading page');
    }
  });
});

const port = process.env.PORT || 8080;

async function webserver() {
  const server = app.listen(port);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (ws) => {
    console.log('WebSocket client connected');

    const emitStatusToFrontEnd = () => {
      const status = getStatus();
      status.type = 'status';
      ws.send(JSON.stringify(status));
    };

    emitStatusToFrontEnd();

    statusEmitter.on('update', () => {
      emitStatusToFrontEnd();
    });

    ws.on('message', async (data) => {
      const message = JSON.parse(data);
      if (message.type === 'getDockerContainers') {
        try {
          const containers = await getFormattedDockerContainers();
          ws.send(
            JSON.stringify({ type: 'dockerContainers', payload: containers }),
          );
        } catch (e) {
          console.error('Error getting docker containers:', e);
          ws.send(
            JSON.stringify({
              type: 'dockerContainersError',
              error:
                e?.message ||
                'Unable to obtain docker containers via Docker Engine API.',
            }),
          );
        }
      } else if (message.type === 'restartDockerStack') {
        const stackName = message.payload?.stackName;
        if (!stackName) {
          ws.send(
            JSON.stringify({
              type: 'dockerStackRestartResult',
              success: false,
              stackName,
              error: 'No stack name provided',
            }),
          );
          return;
        }

        const scriptPath = join(
          os.homedir(),
          'containers/scripts/all-containers.sh',
        );
        const child = spawn(scriptPath, [
          '--stop',
          '--start',
          '--no-wait',
          '--container',
          stackName,
        ]);

        ws.send(
          JSON.stringify({
            type: 'dockerStackRestartStarted',
            stackName,
          }),
        );

        let output = '';
        child.stdout.on('data', (data) => {
          output += data.toString();
        });
        child.stderr.on('data', (data) => {
          output += data.toString();
        });

        child.on('close', (code) => {
          ws.send(
            JSON.stringify({
              type: 'dockerStackRestartResult',
              success: code === 0,
              stackName,
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            }),
          );
        });
      } else if (message.type === 'restartDockerStackWithUpgrade') {
        const stackName = message.payload?.stackName;
        if (!stackName) {
          ws.send(
            JSON.stringify({
              type: 'dockerStackRestartResult',
              success: false,
              stackName,
              operation: 'upgrade',
              error: 'No stack name provided',
            }),
          );
          return;
        }

        const scriptPath = join(
          os.homedir(),
          'containers/scripts/all-containers.sh',
        );
        const child = spawn(scriptPath, [
          '--stop',
          '--start',
          '--no-wait',
          '--container',
          stackName,
          '--update-git-repos',
          '--get-updates',
        ]);

        ws.send(
          JSON.stringify({
            type: 'dockerStackRestartStarted',
            stackName,
            operation: 'upgrade',
          }),
        );

        let output = '';
        child.stdout.on('data', (data) => {
          output += data.toString();
        });
        child.stderr.on('data', (data) => {
          output += data.toString();
        });

        child.on('close', (code) => {
          ws.send(
            JSON.stringify({
              type: 'dockerStackRestartResult',
              success: code === 0,
              stackName,
              operation: 'upgrade',
              output,
              error: code !== 0 ? `Script exited with code ${code}` : null,
            }),
          );
        });
      }
    });

    ws.on('close', () => {
      statusEmitter.removeListener('update', emitStatusToFrontEnd);
      console.log('WebSocket client disconnected');
    });
  });

  console.log(`Docker Status server running on port ${port}`);
}

export default webserver;
