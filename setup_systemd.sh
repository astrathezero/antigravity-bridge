#!/usr/bin/env bash
# ==============================================================================
# Antigravity Bridge - Systemd Service Installer & Updater
# ==============================================================================
# Usage:
#   chmod +x setup_systemd.sh
#   ./setup_systemd.sh
# ==============================================================================

set -e

CURRENT_USER=$(whoami)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PYTHON_BIN=$(which python3 || echo "/usr/bin/python3")
SERVICE_NAME="antigravity-bridge"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

echo "============================================================"
echo "🚀 Installing / Updating Antigravity Bridge Systemd Service"
echo "============================================================"
echo "  User:         ${CURRENT_USER}"
echo "  Working Dir:  ${SCRIPT_DIR}"
echo "  Python:       ${PYTHON_BIN}"
echo "  Service File: ${SERVICE_PATH}"
echo "============================================================"

# Generate dynamic systemd service content
sudo bash -c "cat <<EOF > ${SERVICE_PATH}
[Unit]
Description=Antigravity / agy OpenAI & Anthropic REST API Bridge Server
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${PYTHON_BIN} ${SCRIPT_DIR}/antigravity_bridge.py --host 127.0.0.1 --port 8000 --profile-concurrency 1
Restart=always
RestartSec=5
Environment=PATH=${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1

# Security Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF"

echo "🔄 Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "⚡ Enabling and restarting ${SERVICE_NAME}..."
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo ""
echo "✅ Antigravity Bridge service successfully installed and started!"
echo ""
sudo systemctl status "${SERVICE_NAME}" --no-pager
