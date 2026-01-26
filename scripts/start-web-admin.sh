#!/bin/bash
set -e

WEB_ADMIN_DIR="${HOME}/containers/web-admin"
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
        pm2 restart "$PM2_NAME"
    else
        echo "Starting web-admin via PM2..."
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
