#!/bin/bash
set -e

# Wait for the Xvfb display to become available
echo "[start-vnc] waiting for Xvfb display :99..."
for i in {1..30}; do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.5
done

# Check for password from environment or /app/.env
VNC_PASS="${noVNC_PASSWORD:-${NOVNC_PASSWORD:-}}"
if [ -z "$VNC_PASS" ] && [ -f "/app/.env" ]; then
    VNC_PASS=$(grep -E '^(noVNC_PASSWORD|NOVNC_PASSWORD)=' /app/.env | head -n 1 | cut -d '=' -f2-)
fi
VNC_PASS=$(echo "$VNC_PASS" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//')

if [ -n "$VNC_PASS" ]; then
    echo "[start-vnc] password protection ENABLED"
    PASS_FILE="/tmp/.vnc_passwd"
    x11vnc -storepasswd "$VNC_PASS" "$PASS_FILE"
    exec x11vnc -display :99 -forever -shared -rfbauth "$PASS_FILE" -rfbport 5900 -listen 127.0.0.1
else
    echo "[start-vnc] running without password (loopback only)"
    exec x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1
fi
