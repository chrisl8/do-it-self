#!/bin/bash
set -e

WEB_ADMIN_DIR="${HOME}/containers/web-admin"

# Ensure proper environment for PM2 when run from cron
export HOME="${HOME:-$WEB_ADMIN_DIR}"
export PM2_HOME="$HOME/.pm2"

# Dynamically find Node.js binaries regardless of installation method (n, nvm, fnm, system, etc.)
# In cron, PATH is minimal, so we search common installation directories
NODE_PATH=""
SEARCH_PATHS=(
    "$HOME/.nvm/versions/node"/*/bin
    "$HOME/.local/share/fnm"/*/bin
    "$HOME/.fnm"/current/bin
    "$HOME/n/bin"
    "/usr/local/n/bin"
    "/opt/n/bin"
)

for dir in "${SEARCH_PATHS[@]}"; do
    if [ -x "$dir/node" ]; then
        NODE_PATH="$dir/node"
        break
    fi
done

if [ -z "$NODE_PATH" ]; then
    NODE_PATH=$(command -v node 2>/dev/null)
fi

if [ -n "$NODE_PATH" ]; then
    NODE_DIR=$(dirname "$NODE_PATH")
    export PATH="$NODE_DIR:$PATH"
fi

# Also add npm's global bin directory to PATH (for pm2 installed globally)
NPM_PREFIX=$(npm config get prefix 2>/dev/null)
if [ -n "$NPM_PREFIX" ] && [ -d "$NPM_PREFIX/bin" ]; then
    export PATH="$NPM_PREFIX/bin:$PATH"
fi

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"


if ! command -v pm2 &> /dev/null; then
    echo "ERROR: pm2 command not found. Is Node.js installed and in PATH?"
    # Debug logging for environment issues
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-web-admin.sh invoked with HOME=$HOME PM2_HOME=$PM2_HOME PATH=$PATH"
    exit 1
fi
PM2_NAME="Container Web Admin" # This must match what is in ../web-admin/ecosystem.config.js
ECOSYSTEM_FILE="$WEB_ADMIN_DIR/ecosystem.config.js"
ENV_FILE="$WEB_ADMIN_DIR/backend/.env"

command="$1"
if [ -z "$command" ]; then
    command="start"
fi

load_env() {
    if [ -f "$ENV_FILE" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            if [[ "$line" =~ ^[^#].*= ]]; then
                key="${line%%=*}"
                value="${line#*=}"
                export "$key=$value"
            fi
        done < "$ENV_FILE"
    fi
}

start() {
    if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        STATUS=$(pm2 jlist 2>/dev/null | grep -o "\"status\":\"[^\"]*\"" | head -1 | grep -o "online" || true)
        if [ "$STATUS" = "online" ]; then
             return 0
        fi
        echo "web-admin process exists but is not healthy, restarting..."
    fi

    echo "Starting web-admin..."

    if [ ! -d "$WEB_ADMIN_DIR/backend/node_modules" ] || \
       [ ! -d "$WEB_ADMIN_DIR/frontend/node_modules" ]; then
        echo "Installing dependencies..."
        cd "$WEB_ADMIN_DIR" && npm run install:all
    fi

    echo "Building frontend..."
    cd "$WEB_ADMIN_DIR" && npm run build

    load_env

    if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        echo "Restarting existing web-admin process..."
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting existing PM2 process: $PM2_NAME"
        pm2 restart "$PM2_NAME"
    else
        echo "Starting web-admin via PM2..."
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting new PM2 process from $ECOSYSTEM_FILE"
        pm2 start "$ECOSYSTEM_FILE"
        pm2 save
    fi

    echo "web-admin started successfully"
}

stop() {
    echo "Stopping web-admin..."
    if pm2 list 2>/dev/null | grep -q "$PM2_NAME"; then
        pm2 stop "$PM2_NAME"
        pm2 delete "$PM2_NAME"
        echo "web-admin stopped"
    else
        echo "web-admin is not running"
    fi
}

restart() {
    stop
    start
}

case "$command" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    *)
        echo "Usage: $0 {start|stop|restart}"
        exit 1
        ;;
esac
