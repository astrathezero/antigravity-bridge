#!/usr/bin/env bash
# ==============================================================================
# Antigravity Bridge (Node.js Edition) - LaunchAgent Installer (macOS)
# ==============================================================================
# Usage:
#   chmod +x setup_launchd_mac.sh
#   ./setup_launchd_mac.sh [start | stop | restart | status | uninstall]
# ==============================================================================

set -e

ACTION="${1:-start}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=$(which node || echo "/usr/local/bin/node")
LABEL="com.antigravity.bridge.node"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/AntigravityBridge"
STDOUT_LOG="${LOG_DIR}/bridge-node.log"
STDERR_LOG="${LOG_DIR}/bridge-node.err.log"

mkdir -p "$PLIST_DIR"
mkdir -p "$LOG_DIR"

install_and_start() {
    echo "============================================================"
    echo "🍏 Installing Antigravity Bridge LaunchAgent for macOS"
    echo "============================================================"
    echo "  Node:        $NODE_BIN"
    echo "  Working Dir: $SCRIPT_DIR"
    echo "  Plist File:  $PLIST_PATH"
    echo "  Logs:        $STDOUT_LOG"
    echo "============================================================"

    cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${SCRIPT_DIR}/src/index.mjs</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>8008</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
EOF

    # Unload if currently loaded
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    sleep 1

    # Load and start
    launchctl load -w "$PLIST_PATH"
    sleep 2

    echo ""
    echo "✅ Service loaded into macOS LaunchAgents!"
    check_status
}

stop_service() {
    echo "🛑 Stopping Antigravity Bridge service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "✅ Service unloaded."
}

check_status() {
    echo "📊 Service Status:"
    if launchctl list | grep -q "$LABEL"; then
        echo "   [OK] LaunchAgent '$LABEL' is registered and running."
        echo "   [OK] Health Check (Port 8008):"
        curl -s http://127.0.0.1:8008/health || echo "   (Waiting for endpoint...)"
    else
        echo "   [WARN] LaunchAgent '$LABEL' is not loaded."
    fi
    echo ""
    echo "   View live logs: tail -f $STDOUT_LOG"
}

uninstall_service() {
    stop_service
    rm -f "$PLIST_PATH"
    echo "✅ Removed plist file: $PLIST_PATH"
}

case "$ACTION" in
    start|install)
        install_and_start
        ;;
    stop)
        stop_service
        ;;
    restart)
        stop_service
        sleep 1
        launchctl load -w "$PLIST_PATH"
        check_status
        ;;
    status)
        check_status
        ;;
    uninstall)
        uninstall_service
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|uninstall}"
        exit 1
        ;;
esac
