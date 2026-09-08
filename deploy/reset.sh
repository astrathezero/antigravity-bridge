#!/bin/bash
# Antigravity Bridge - Headless Deployment Reset Utility
# Restarts browser or clears locks without losing session cookies.

set -e

ACTION="${1:-restart}"

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
    docker exec antigravity-bridge supervisorctl restart browser
    echo "Chromium restarted."
elif [ "$ACTION" = "logs" ]; then
    docker logs -f antigravity-bridge
else
    echo "Usage: $0 [restart|clean|logs]"
    exit 1
fi
