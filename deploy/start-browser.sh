#!/bin/bash
# start-browser.sh
# Single Chromium instance with Antigravity extension.
# Opens multiple Gemini tabs (one per Google account) via Chrome multi-login.
# Sessions are persisted in /app/chrome-data (mounted as Docker volume).
set -e

BROWSER_PID=""

# Graceful shutdown trap to ensure SQLite cookies and WAL are cleanly flushed to disk
cleanup() {
    echo "[start-browser] Graceful shutdown triggered. Terminating Chromium PID $BROWSER_PID..."
    if [ -n "$BROWSER_PID" ] && kill -0 "$BROWSER_PID" 2>/dev/null; then
        kill -TERM "$BROWSER_PID" 2>/dev/null || true
        # Wait up to 20 seconds for clean exit and SQLite/cookie commits
        for i in {1..40}; do
            if ! kill -0 "$BROWSER_PID" 2>/dev/null; then
                echo "[start-browser] Chromium exited cleanly."
                break
            fi
            sleep 0.5
        done
        kill -9 "$BROWSER_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGTERM SIGINT

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

# Sanitize exit_type and enforce session cookie retention in Preferences and Local State
python3 -c "
import json, os
for p in ['/app/chrome-data/Default/Preferences', '/app/chrome-data/Local State']:
    if os.path.exists(p):
        try:
            with open(p, 'r') as f: d = json.load(f)
            if 'profile' in d and isinstance(d['profile'], dict):
                d['profile']['exit_type'] = 'Normal'
                d['profile']['exited_cleanly'] = True
            # Enforce restore_on_startup: 1 so Chromium preserves all session cookies across restarts
            if 'Default' in p:
                if 'session' not in d or not isinstance(d['session'], dict):
                    d['session'] = {}
                d['session']['restore_on_startup'] = 1
            with open(p, 'w') as f: json.dump(d, f)
        except Exception: pass
" 2>/dev/null || true

# Detect Chromium binary (prioritize native ELF binary over wrapper script)
BROWSER_BIN=""
for bin in /usr/lib/chromium/chromium /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    [ -x "$bin" ] && { BROWSER_BIN="$bin"; break; }
done
if [ -z "$BROWSER_BIN" ]; then
    echo "[start-browser] ERROR: Chromium binary not found!" >&2
    exit 1
fi

# How many Gemini tabs/accounts to open (default 3, max 10)
CHROME_ACCOUNTS="${CHROME_ACCOUNTS:-3}"
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

# Collect initial URLs to launch together
INITIAL_URLS=()
for i in $(seq 0 $((CHROME_ACCOUNTS - 1))); do
    INITIAL_URLS+=("${CUSTOM_URL_LIST[$i]:-${DEFAULT_URLS[$i]}}")
done

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
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --force-device-scale-factor="$CHROME_SCALE" \
    --high-dpi-support=1 \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-features=TranslateUI,DeviceBoundSessions \
    --window-size=1280,800 \
    --start-maximized \
    "${INITIAL_URLS[@]}" &

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

# Ensure all configured Gemini account tabs are active
echo "[start-browser] checking open account tabs..."
EXISTING_TABS=$(curl -sf http://127.0.0.1:9222/json/list 2>/dev/null || echo "[]")
for i in $(seq 0 $((CHROME_ACCOUNTS - 1))); do
    URL="${CUSTOM_URL_LIST[$i]:-${DEFAULT_URLS[$i]}}"
    if [ "$i" -eq 0 ]; then
        PAT="gemini\.google\.com/(app|canvas)"
    else
        PAT="gemini\.google\.com/u/${i}/(app|canvas)"
    fi
    if ! echo "$EXISTING_TABS" | grep -Eq "$PAT"; then
        echo "[start-browser] opening missing account tab $i → $URL"
        curl -sf -X PUT "http://127.0.0.1:9222/json/new?${URL}" > /dev/null 2>&1 || true
        sleep 1
    fi
done

# Health-check loop: only re-open tabs if count of Gemini tabs is less than CHROME_ACCOUNTS
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
        if 'gemini.google.com' in u or 'accounts.google.com' in u:
            print(u)
except: pass
" 2>/dev/null || true)

        GEMINI_TAB_COUNT=$(echo "$OPEN_URLS" | grep -c -v '^$' || true)

        # Only attempt to restore if we actually have fewer open tabs than CHROME_ACCOUNTS
        if [ "$GEMINI_TAB_COUNT" -lt "$CHROME_ACCOUNTS" ]; then
            echo "[start-browser] health-check: detected $GEMINI_TAB_COUNT open tabs (expected $CHROME_ACCOUNTS)"
            for i in $(seq 0 $((CHROME_ACCOUNTS - 1))); do
                URL="${CUSTOM_URL_LIST[$i]:-${DEFAULT_URLS[$i]}}"
                if [ "$i" -eq 0 ]; then
                    ACCOUNT_PATTERN="gemini\.google\.com/(app|canvas)"
                else
                    ACCOUNT_PATTERN="gemini\.google\.com/u/${i}/(app|canvas)"
                fi
                if ! echo "$OPEN_URLS" | grep -Eq "$ACCOUNT_PATTERN"; then
                    echo "[start-browser] health-check: re-opening missing tab $i → $URL"
                    curl -sf -X PUT "http://127.0.0.1:9222/json/new?${URL}" > /dev/null 2>&1 || true
                    sleep 2
                fi
            done
        fi
    done
) &

echo "[start-browser] all done. waiting for Chrome to exit..."
wait $BROWSER_PID
