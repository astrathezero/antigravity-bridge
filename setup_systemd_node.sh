#!/usr/bin/env bash
# ==============================================================================
# Antigravity Bridge (Node.js Edition) - Systemd Service Installer (Linux)
# ==============================================================================
# Usage:
#   chmod +x setup_systemd_node.sh
#   ./setup_systemd_node.sh
# ==============================================================================

set -e

CURRENT_USER=$(whoami)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=$(which node || echo "/usr/bin/node")
SERVICE_NAME="antigravity-bridge-node"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [ ! -x "$NODE_BIN" ]; then
    echo "❌ Error: node binary not found. Please install Node.js (v18+) first."
    exit 1
fi

echo "============================================================"
echo "🚀 Installing Antigravity Bridge Node.js Service (Port 8008)"
echo "============================================================"
echo "  User:         ${CURRENT_USER}"
echo "  Working Dir:  ${SCRIPT_DIR}"
echo "  Node Binary:  ${NODE_BIN}"
echo "  Service File: ${SERVICE_PATH}"
echo "============================================================"

# Generate systemd service configuration
sudo bash -c "cat <<EOF > ${SERVICE_PATH}
[Unit]
Description=Antigravity Bridge REST API Server (Node.js Edition)
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/src/index.mjs --host 127.0.0.1 --port 8008
Restart=always
RestartSec=5
Environment=PATH=${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
Environment=NODE_ENV=production
Environment=ANTIGRAVITY_PORT=8008
Environment=ANTIGRAVITY_QUOTA_CACHE_FILE=${HOME}/.config/antigravity/quota_cache_node.json
Environment=ANTIGRAVITY_SANDBOX_BASE=${HOME}/.config/antigravity/sandboxes-node

# Resource bounds
MemoryMax=2G
TasksMax=512

[Install]
WantedBy=multi-user.target
EOF"

echo "🔄 Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "⚡ Enabling and starting ${SERVICE_NAME} on port 8008..."
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo ""
echo "✅ Antigravity Bridge Node.js service installed successfully!"
echo "   Status command: sudo systemctl status ${SERVICE_NAME}"
echo "   Logs command:   sudo journalctl -u ${SERVICE_NAME} -f"
echo "   Health check:   curl http://127.0.0.1:8008/health"
