#!/bin/bash
# Antigravity Bridge - Headless Deployment Reset Utility
# Restarts browser or clears locks without losing session cookies.

set -e

ACTION="${1:-restart}"

# Follow whichever stack deploy/.env describes rather than a hardcoded container name.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
fi
CONTAINER_NAME="${CONTAINER_NAME:-antigravity-bridge2}"

if [ "$ACTION" = "clean" ]; then
    echo "WARNING: This will remove all saved Chrome login sessions!"
    read -p "Are you sure? (y/N) " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        docker compose down
        rm -rf ./chrome-data
        mkdir -p ./chrome-data
        echo "Chrome data directory reset."
        docker compose up -d
    else
        echo "Aborted."
    fi
elif [ "$ACTION" = "restart" ]; then
    echo "Restarting Chromium inside container..."
    docker exec "$CONTAINER_NAME" supervisorctl restart browser
    echo "Chromium restarted."
elif [ "$ACTION" = "logs" ]; then
    docker logs -f "$CONTAINER_NAME"
else
    echo "Usage: $0 [restart|clean|logs]"
    exit 1
fi
