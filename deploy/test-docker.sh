#!/usr/bin/env bash
# ==============================================================================
# Antigravity Bridge - Docker & noVNC Automated Deployment Test Suite
# ==============================================================================
# Usage:
#   bash deploy/test-docker.sh            # Run comprehensive validation
#   bash deploy/test-docker.sh --check    # Check running container health only
#   bash deploy/test-docker.sh --build    # Test build docker image
#   bash deploy/test-docker.sh --logs     # Show supervisor & browser logs
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Port and container name come from deploy/.env so this script follows the stack it is testing
# instead of the defaults it was originally written against.
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
fi
BRIDGE_PORT="${BRIDGE_PORT:-8000}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
CONTAINER_NAME="${CONTAINER_NAME:-antigravity-bridge2}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

pass() { echo -e "  [${GREEN}PASS${NC}] $1"; }
warn() { echo -e "  [${YELLOW}WARN${NC}] $1"; }
fail() { echo -e "  [${RED}FAIL${NC}] $1"; }
info() { echo -e "${BLUE}==>${NC} $1"; }

echo -e "${BLUE}================================================================${NC}"
echo -e "${BLUE}  🐳 Antigravity Bridge - Docker + noVNC Test & Diagnostic Tool ${NC}"
echo -e "${BLUE}================================================================${NC}"

# 1. Verify repository file structure
info "Step 1: Checking deployment files & permissions..."
ERRORS=0

check_file() {
    if [ -f "$1" ]; then
        pass "Found $(basename "$1")"
    else
        fail "Missing $1"
        ERRORS=$((ERRORS + 1))
    fi
}

check_file "$SCRIPT_DIR/Dockerfile"
check_file "$SCRIPT_DIR/docker-compose.yml"
check_file "$SCRIPT_DIR/start-browser.sh"
check_file "$SCRIPT_DIR/start-vnc.sh"
check_file "$SCRIPT_DIR/supervisord.conf"
check_file "$SCRIPT_DIR/.env.example"

# Ensure host bridge_config.json exists so Docker volume mount doesn't create a directory
if [ ! -f "$ROOT_DIR/bridge_config.json" ]; then
    echo "{}" > "$ROOT_DIR/bridge_config.json"
    pass "Created missing $ROOT_DIR/bridge_config.json (prevents Docker directory mount bug)"
else
    pass "Host bridge_config.json exists and is a regular file"
fi

# Ensure scripts have execute permissions
chmod +x "$SCRIPT_DIR/start-browser.sh" "$SCRIPT_DIR/start-vnc.sh" 2>/dev/null || true
if [ -f "$SCRIPT_DIR/reset.sh" ]; then chmod +x "$SCRIPT_DIR/reset.sh" 2>/dev/null || true; fi

# Check .env configuration
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    warn "deploy/.env not found; copying from deploy/.env.example..."
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    pass "Created deploy/.env from template"
else
    pass "deploy/.env exists"
fi

# 2. Check Docker availability
info "Step 2: Checking Docker & Docker Compose engine..."
DOCKER_BIN=$(command -v docker || true)

if [ -z "$DOCKER_BIN" ]; then
    warn "Docker CLI is not installed on this machine ($(uname -s) $(uname -m))."
    echo -e "\n${YELLOW}ℹ️  Note:${NC} If you are developing on a Mac and deploying to an Ubuntu 24.04 server:"
    echo "  1. Push code to your repository: git push origin feat/web-extension-bridge"
    echo "  2. On your Ubuntu server, install Docker:"
    echo "     curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker \$USER"
    echo "  3. Run this script directly on the server: bash deploy/test-docker.sh"
    echo ""
    pass "Static deployment configuration check completed successfully!"
    exit 0
fi

pass "Docker binary located at $DOCKER_BIN"
DOCKER_VER=$($DOCKER_BIN --version)
pass "$DOCKER_VER"

COMPOSE_CMD=""
if $DOCKER_BIN compose version >/dev/null 2>&1; then
    COMPOSE_CMD="$DOCKER_BIN compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
else
    fail "Neither 'docker compose' nor 'docker-compose' found"
    ERRORS=$((ERRORS + 1))
fi

if [ -n "$COMPOSE_CMD" ]; then
    pass "Docker Compose is available: $($COMPOSE_CMD version)"
fi

# 3. Validate Docker Compose config syntax
info "Step 3: Validating docker-compose.yml configuration..."
if [ -n "$COMPOSE_CMD" ]; then
    if (cd "$SCRIPT_DIR" && $COMPOSE_CMD config >/dev/null); then
        pass "docker-compose.yml syntax and variable substitution are valid"
    else
        fail "docker-compose.yml failed syntax validation"
        exit 1
    fi
fi

# 4. Optional Build Test
if [ "$1" = "--build" ]; then
    info "Step 4: Testing container build..."
    (cd "$SCRIPT_DIR" && $COMPOSE_CMD build)
    pass "Docker image built successfully"
    exit 0
fi

# 5. Check running container status
info "Step 4: Checking running container & service endpoints..."
CONTAINER_ID=$($DOCKER_BIN ps -q -f "name=^${CONTAINER_NAME}$" || true)

if [ -z "$CONTAINER_ID" ]; then
    warn "Container '$CONTAINER_NAME' is not currently running."
    echo "  To start the container, run:"
    echo "    cd deploy && $COMPOSE_CMD up -d --build"
    echo "  Then re-run this script to verify live endpoints."
    exit 0
fi

pass "Container '$CONTAINER_NAME' is RUNNING (ID: ${CONTAINER_ID:0:12})"

# Check noVNC HTTP Port
if curl -sf -o /dev/null -m 5 "http://127.0.0.1:${NOVNC_PORT}/"; then
    pass "noVNC web interface is UP on http://127.0.0.1:${NOVNC_PORT}"
else
    fail "noVNC port ${NOVNC_PORT} is not responding on 127.0.0.1:${NOVNC_PORT}"
    ERRORS=$((ERRORS + 1))
fi

# Check Bridge API Port
HEALTH_OUT=$(curl -sf -m 5 "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null || true)
if [ -n "$HEALTH_OUT" ]; then
    pass "Antigravity Bridge API is HEALTHY on http://127.0.0.1:${BRIDGE_PORT}"
else
    fail "Bridge API /health is not responding on 127.0.0.1:${BRIDGE_PORT}"
    ERRORS=$((ERRORS + 1))
fi

# Check Extension Status
EXT_OUT=$(curl -sf -m 5 "http://127.0.0.1:${BRIDGE_PORT}/extension/status" 2>/dev/null || true)
if [ -n "$EXT_OUT" ]; then
    # The bridge pretty-prints its JSON, so the value is preceded by a space; the old pattern
    # never matched and this always reported 0 connected extension clients.
    CLIENTS_COUNT=$(echo "$EXT_OUT" | grep -o '"connected_clients_count"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
    pass "Extension status endpoint OK (connected_clients: ${CLIENTS_COUNT:-0})"
else
    warn "Extension status endpoint did not respond"
fi

# Check Chrome Remote Debugging port inside container
CDP_OUT=$($DOCKER_BIN exec "$CONTAINER_NAME" curl -sf -m 3 http://127.0.0.1:9222/json/version 2>/dev/null || true)
if [ -n "$CDP_OUT" ]; then
    pass "Chromium CDP Remote Debugging is UP on port 9222 inside container"
    TABS_OUT=$($DOCKER_BIN exec "$CONTAINER_NAME" curl -sf -m 3 http://127.0.0.1:9222/json/list 2>/dev/null || true)
    GEMINI_TABS=$(echo "$TABS_OUT" | grep -o 'https://gemini.google.com[^"]*' | wc -l || echo "0")
    pass "Open Gemini tabs detected inside Chromium: $GEMINI_TABS"
else
    warn "Chromium CDP port 9222 not reachable inside container"
fi

# 6. Show logs if requested
if [ "$1" = "--logs" ]; then
    info "Fetching container supervisord & service logs..."
    $DOCKER_BIN exec "$CONTAINER_NAME" tail -n 30 /var/log/supervisord.log /var/log/bridge.log /var/log/browser.log 2>/dev/null || true
fi

echo -e "\n${GREEN}================================================================${NC}"
echo -e "${GREEN}  🎉 All Docker & noVNC deployment checks completed! ${NC}"
echo -e "${GREEN}================================================================${NC}"
