# Docker Status Standalone

A lightweight Docker container monitoring dashboard that can be hosted independently from the main Metatron home automation system.

## Features

- Real-time Docker container status monitoring
- Docker event streaming for live updates
- Stack-based organization with icons
- Material-UI dashboard interface
- Self-contained deployment in `~/containers/web-admin`

## Requirements

- Node.js 18+
- Access to Docker socket (`/var/run/docker.sock`)
- Docker containers directory at `~/containers`

## Installation

```bash
cd ~/containers/web-admin
npm install:all
```

## Development

```bash
# Terminal 1: Start backend
cd ~/containers/web-admin/backend
npm run dev

# Terminal 2: Start frontend dev server
cd ~/containers/web-admin/frontend
npm run dev
```

Access at `http://localhost:3000`

## Production Deployment

```bash
# Build frontend
cd ~/containers/web-admin
npm run build
# Start server
npm start
```

Access at `http://localhost:3001` (or configured port)

## Configuration

### Backend (.env)

| Variable             | Description               | Default                                 |
| -------------------- | ------------------------- | --------------------------------------- |
| `PORT`               | HTTP server port          | `3001`                                  |
| `DOCKER_SOCKET_PATH` | Docker socket location    | `/var/run/docker.sock`                  |
| `CONTAINERS_DIR`     | Containers directory      | `~/containers`                          |
| `ICONS_BASE_DIR`     | Dashboard icons directory | `~/containers/homepage/dashboard-icons` |

### Frontend (.env)

The frontend automatically detects the WebSocket URL from the browser's current location. No configuration needed.

## Directory Structure

```
web-admin/
├── backend/
│   ├── src/
│   │   ├── main.js              # Entry point
│   │   ├── server.js            # Express + WebSocket server
│   │   ├── dockerStatus.js      # Docker container fetching
│   │   ├── dockerWatcher.js     # Docker event monitoring
│   │   ├── containerFolderScanner.js
│   │   ├── dockerContainerIcons.js
│   │   └── statusEmitter.js     # Status broadcasting
│   ├── public/                  # Built frontend (after build)
│   ├── package.json
│   └── .env
│
├── frontend/
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── DockerStatus.jsx
│   │   └── hooks/useDockerStatus.js
│   ├── package.json
│   └── .env
│
└── README.md
```

## License

MIT
