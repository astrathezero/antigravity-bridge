#!/bin/bash
set -e

echo "[start-browser] waiting for Xvfb display :99..."
for i in {1..30}; do
    [ -e /tmp/.X11-unix/X99 ] && { echo "[start-browser] display ready"; break; }
    sleep 0.5
done

echo "[start-browser] waiting for bridge on 127.0.0.1:8000..."
for i in {1..40}; do
    if curl -s http://127.0.0.1:8000/health > /dev/null 2>&1; then
        echo "[start-browser] bridge server ready"; break
    fi
    sleep 0.5
done

# Clear stale singleton locks left by previous container stop/restart
echo "[start-browser] clearing stale locks..."
rm -f /app/chrome-data/Singleton* \
      /app/chrome-data/Default/Singleton* \
      /app/chrome-data/Default/.org.chromium.Chromium.* \
      /tmp/.org.chromium.Chromium.* \
      /tmp/Singleton* 2>/dev/null || true

BROWSER_BIN=""
if [ -x "/usr/bin/chromium" ]; then
    BROWSER_BIN="/usr/bin/chromium"
elif [ -x "/usr/bin/chromium-browser" ]; then
    BROWSER_BIN="/usr/bin/chromium-browser"
elif [ -x "/usr/bin/google-chrome" ]; then
    BROWSER_BIN="/usr/bin/google-chrome"
else
    echo "[start-browser] ERROR: Chromium binary not found!" >&2
    exit 1
fi

echo "[start-browser] launching $BROWSER_BIN with Antigravity extension..."

exec "$BROWSER_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-port=9222 \
    --user-data-dir=/app/chrome-data \
    --load-extension=/app/extension \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --window-size=1280,800 \
    --start-maximized \
    "https://gemini.google.com/app"
