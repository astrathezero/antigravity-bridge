#!/bin/bash
# start-browser.sh — launch multiple Chromium windows, one per Google account
# Each window uses an isolated --user-data-dir so cookies/sessions don't mix
set -e

echo "[start-browser] waiting for Xvfb display :99..."
for i in {1..30}; do
    [ -e /tmp/.X11-unix/X99 ] && { echo "[start-browser] display ready"; break; }
    sleep 0.5
done

echo "[start-browser] waiting for bridge on 127.0.0.1:8000..."
for i in {1..60}; do
    if curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; then
        echo "[start-browser] bridge ready"; break
    fi
    sleep 1
done

# Clear stale singleton locks
echo "[start-browser] clearing stale Chrome locks..."
find /app/chrome-data -name 'Singleton*' -delete 2>/dev/null || true
find /tmp -name '.org.chromium.Chromium.*' -delete 2>/dev/null || true

# Detect Chromium binary
BROWSER_BIN=""
for bin in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    [ -x "$bin" ] && { BROWSER_BIN="$bin"; break; }
done
if [ -z "$BROWSER_BIN" ]; then
    echo "[start-browser] ERROR: Chromium binary not found!" >&2
    exit 1
fi

# How many Chrome windows to open (default 2, max 10)
CHROME_ACCOUNTS="${CHROME_ACCOUNTS:-2}"
if [ "$CHROME_ACCOUNTS" -gt 10 ]; then CHROME_ACCOUNTS=10; fi

# Build URL list (custom or auto-generated)
IFS=',' read -ra URL_LIST <<< "${CHROME_URLS:-}"
DEFAULT_URLS=(
    "https://gemini.google.com/app"
    "https://gemini.google.com/u/1/app"
    "https://gemini.google.com/u/2/app"
    "https://gemini.google.com/u/3/app"
    "https://gemini.google.com/u/4/app"
    "https://gemini.google.com/u/5/app"
    "https://gemini.google.com/u/6/app"
    "https://gemini.google.com/u/7/app"
    "https://gemini.google.com/u/8/app"
    "https://gemini.google.com/u/9/app"
)

COMMON_FLAGS=(
    --no-sandbox
    --disable-dev-shm-usage
    --disable-gpu
    --remote-debugging-port=9222
    --load-extension=/app/extension
    --no-first-run
    --no-default-browser-check
    --disable-background-timer-throttling
    --disable-backgrounding-occluded-windows
    --disable-renderer-backgrounding
    --disable-features=TranslateUI
    --window-size=1280,800
)

echo "[start-browser] launching $CHROME_ACCOUNTS Chromium window(s) with Antigravity extension..."

PIDS=()
for i in $(seq 0 $((CHROME_ACCOUNTS - 1))); do
    URL="${URL_LIST[$i]:-${DEFAULT_URLS[$i]}}"
    PROFILE_DIR="/app/chrome-data/profile$i"
    mkdir -p "$PROFILE_DIR"

    # Offset window position so windows don't overlap in noVNC
    OFFSET_X=$((( i % 5 ) * 60))
    OFFSET_Y=$(((i / 5 ) * 40))

    echo "[start-browser] window $i → $URL (profile$i)"
    "$BROWSER_BIN" \
        "${COMMON_FLAGS[@]}" \
        --user-data-dir="$PROFILE_DIR" \
        --window-position="$OFFSET_X,$OFFSET_Y" \
        "$URL" &
    PIDS+=($!)
    sleep 1   # slight stagger to avoid race on X display
done

echo "[start-browser] all $CHROME_ACCOUNTS windows launched (PIDs: ${PIDS[*]})"

# Wait for all browser processes — supervisor will restart if they all exit
wait "${PIDS[@]}"
