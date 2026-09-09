#!/bin/bash
# start-browser.sh
# Single Chromium instance with Antigravity extension.
# Opens multiple Gemini tabs (one per Google account) via Chrome multi-login.
# Sessions are persisted in /app/chrome-data (mounted as Docker volume).
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

# Clear stale singleton locks left by previous container stop/restart
echo "[start-browser] clearing stale Chrome locks..."
rm -f /app/chrome-data/Singleton* \
      /app/chrome-data/Default/Singleton* \
      /app/chrome-data/Default/.org.chromium.Chromium.* \
      /tmp/.org.chromium.Chromium.* \
      /tmp/Singleton* 2>/dev/null || true

# Detect Chromium binary
BROWSER_BIN=""
for bin in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    [ -x "$bin" ] && { BROWSER_BIN="$bin"; break; }
done
if [ -z "$BROWSER_BIN" ]; then
    echo "[start-browser] ERROR: Chromium binary not found!" >&2
    exit 1
fi

# How many Gemini tabs/accounts to open (default 2, max 10)
CHROME_ACCOUNTS="${CHROME_ACCOUNTS:-2}"
if [ "$CHROME_ACCOUNTS" -gt 10 ]; then CHROME_ACCOUNTS=10; fi

# Build Gemini URL list for each account slot
# account 0 → /app, account 1 → /u/1/app, account 2 → /u/2/app, ...
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

IFS=',' read -ra CUSTOM_URL_LIST <<< "${CHROME_URLS:-}"

# First URL to open at launch (the rest will be opened via CDP after Chrome starts)
FIRST_URL="${CUSTOM_URL_LIST[0]:-${DEFAULT_URLS[0]}}"

# UI and window scaling (default 0.8 = 80%)
CHROME_SCALE="${CHROME_SCALE:-0.8}"

echo "[start-browser] launching $BROWSER_BIN (accounts=$CHROME_ACCOUNTS, scale=$CHROME_SCALE)..."

"$BROWSER_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-port=9222 \
    --user-data-dir=/app/chrome-data \
    --load-extension=/app/extension \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --use-mock-keychain \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --restore-last-session \
    --force-device-scale-factor="$CHROME_SCALE" \
    --high-dpi-support=1 \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-features=TranslateUI \
    --window-size=1280,800 \
    --start-maximized \
    "$FIRST_URL" &

BROWSER_PID=$!
echo "[start-browser] Chrome PID: $BROWSER_PID"

# Wait for Chrome to fully start and remote debugging to be available
echo "[start-browser] waiting for Chrome remote debugging port 9222..."
for i in {1..30}; do
    if curl -sf http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
        echo "[start-browser] Chrome ready (remote debugging UP)"
        break
    fi
    sleep 1
done

# Open additional Gemini tabs for accounts 1..N via CDP (only if not already restored)
if [ "$CHROME_ACCOUNTS" -gt 1 ]; then
    echo "[start-browser] ensuring $CHROME_ACCOUNTS Gemini tab(s) are active..."
    EXISTING_TABS=$(curl -sf http://127.0.0.1:9222/json/list 2>/dev/null || echo "[]")
    for i in $(seq 1 $((CHROME_ACCOUNTS - 1))); do
        URL="${CUSTOM_URL_LIST[$i]:-${DEFAULT_URLS[$i]}}"
        ALREADY_OPEN=$(echo "$EXISTING_TABS" | grep -E "gemini\.google\.com/u/${i}/(app|canvas)" || true)
        if [ -z "$ALREADY_OPEN" ]; then
            echo "[start-browser] opening tab $i → $URL"
            curl -sf -X PUT "http://127.0.0.1:9222/json/new?${URL}" > /dev/null 2>&1 || \
                echo "[start-browser] warning: could not open tab for $URL"
            sleep 2
        else
            echo "[start-browser] tab $i ($URL) already restored from previous session"
        fi
    done
    echo "[start-browser] all $CHROME_ACCOUNTS Gemini tabs confirmed"
fi

# Health-check loop: re-open any missing Gemini tabs every 5 minutes
echo "[start-browser] starting tab health monitor..."
(
    while true; do
        sleep 300
        # Check if Chrome is still alive
        kill -0 $BROWSER_PID 2>/dev/null || break

        # Get current open Gemini URLs
        OPEN_URLS=$(curl -sf http://127.0.0.1:9222/json/list 2>/dev/null | \
            python3 -c "
import json,sys
try:
    tabs=json.load(sys.stdin)
    for t in tabs:
        u=t.get('url','')
        if 'gemini.google.com' in u: print(u)
except: pass
" 2>/dev/null || true)

        # Re-open any missing accounts (matches both /app and /canvas)
        for i in $(seq 0 $((CHROME_ACCOUNTS - 1))); do
            URL="${CUSTOM_URL_LIST[$i]:-${DEFAULT_URLS[$i]}}"
            if [ "$i" -eq 0 ]; then
                ACCOUNT_PATTERN="gemini\.google\.com/(app|canvas)"
            else
                ACCOUNT_PATTERN="gemini\.google\.com/u/${i}/(app|canvas)"
            fi
            if ! echo "$OPEN_URLS" | grep -Eq "$ACCOUNT_PATTERN"; then
                echo "[start-browser] health-check: re-opening missing tab → $URL"
                curl -sf -X PUT "http://127.0.0.1:9222/json/new?${URL}" > /dev/null 2>&1 || true
            fi
        done
    done
) &

echo "[start-browser] all done. waiting for Chrome to exit..."
wait $BROWSER_PID
