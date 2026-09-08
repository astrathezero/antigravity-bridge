#!/usr/bin/env bash
# ==============================================================================
# Antigravity Bridge - Safe Staging & Deployment Protocol Script
# ==============================================================================
# Enforces safe modifications to prevent service disruptions:
# 1. Edit ONLY in staging file (never live antigravity_bridge.py)
# 2. Run isolated unit tests in temporary sandbox
# 3. Atomic deployment with automatic backup
# 4. Immediate post-deployment health check & auto-rollback on failure
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVE_FILE="$SCRIPT_DIR/antigravity_bridge.py"
DEFAULT_STAGING_FILE="$SCRIPT_DIR/antigravity_bridge.py.staging"
TEST_FILE="$SCRIPT_DIR/test_antigravity_bridge.py"
HEALTH_URL="http://127.0.0.1:8000/health"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
    cat <<USG
Usage: $0 <command> [arguments]

Commands:
  stage [source]        Create a new staging file ($DEFAULT_STAGING_FILE)
  test [staging_file]   Run syntax check and unittest in isolated sandbox
  deploy [staging_file] Test staging file, backup live, replace, restart & verify
  rollback [bak_file]   Restore previous backup and restart service
  status                Check live service status and health check endpoint

Examples:
  $0 stage
  # ... edit antigravity_bridge.py.staging ...
  $0 test antigravity_bridge.py.staging
  $0 deploy antigravity_bridge.py.staging
  $0 rollback
USG
    exit 1
}

cmd_stage() {
    local src="${1:-$LIVE_FILE}"
    local dst="$DEFAULT_STAGING_FILE"

    if [ ! -f "$src" ]; then
        log_err "Source file not found: $src"
        exit 1
    fi

    cp "$src" "$dst"
    log_ok "Staging copy created: $dst"
    log_info "👉 Edit '$dst' freely. NEVER touch '$LIVE_FILE' directly while live!"
}

cmd_test() {
    local staging="${1:-$DEFAULT_STAGING_FILE}"

    if [ ! -f "$staging" ]; then
        log_err "Staging file does not exist: $staging"
        exit 1
    fi

    log_info "🔍 1. Running Python syntax check (py_compile)..."
    if ! python3 -m py_compile "$staging"; then
        log_err "Syntax check FAILED for $staging"
        return 1
    fi
    log_ok "Syntax check passed."

    log_info "🧪 2. Creating isolated sandbox for unit tests..."
    local tmpdir
    tmpdir=$(mktemp -d /tmp/staging_test_XXXXXX)

    cp "$staging" "$tmpdir/antigravity_bridge.py"
    cp "$TEST_FILE" "$tmpdir/test_antigravity_bridge.py"

    log_info "🏃 3. Executing unit test suite in sandbox..."
    local test_res=0
    (cd "$tmpdir" && python3 -m unittest test_antigravity_bridge.py) || test_res=$?

    rm -rf "$tmpdir"

    if [ "$test_res" -eq 0 ]; then
        log_ok "All isolated unit tests passed successfully! 🟢"
        return 0
    else
        log_err "Unit tests FAILED! Do NOT deploy this staging file. ❌"
        return 1
    fi
}

get_api_key() {
    python3 -c '
import sys, os
sys.path.insert(0, "/home/attasit/antigravity-bridge")
try:
    import antigravity_bridge
    keys = antigravity_bridge.get_configured_api_keys()
    if keys:
        print(list(keys.keys())[0])
except Exception:
    pass
' 2>/dev/null
}

wait_for_health() {
    local timeout=15
    local api_key
    api_key=$(get_api_key)
    local auth_header=()
    if [ -n "$api_key" ]; then
        auth_header=(-H "Authorization: Bearer $api_key")
    fi

    log_info "⏳ Waiting for Antigravity Bridge service to become healthy (timeout: ${timeout}s)..."
    for ((i=1; i<=timeout; i++)); do
        local resp
        resp=$(curl -s -o /dev/null -w "%{http_code}" "${auth_header[@]}" "$HEALTH_URL" 2>/dev/null || echo "000")
        if [ "$resp" = "200" ]; then
            log_ok "Service is UP and HEALTHY! (HTTP 200 after ${i}s)"
            return 0
        fi
        sleep 1
    done

    log_err "Service failed to report healthy within ${timeout}s (HTTP code: $resp)"
    return 1
}

cmd_deploy() {
    local staging="${1:-$DEFAULT_STAGING_FILE}"

    if [ ! -f "$staging" ]; then
        log_err "Staging file does not exist: $staging"
        exit 1
    fi

    log_info "🚀 Initiating Safe Deployment for: $staging"
    
    # Step 1: Must pass tests
    if ! cmd_test "$staging"; then
        log_err "Deployment aborted due to test failures! Live bridge untouched."
        exit 1
    fi

    # Step 2: Backup live file
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local bak_file="$SCRIPT_DIR/antigravity_bridge.py.bak.$timestamp"
    local latest_bak="$SCRIPT_DIR/antigravity_bridge.py.bak"

    log_info "💾 Backing up live file to $bak_file"
    cp "$LIVE_FILE" "$bak_file"
    cp "$LIVE_FILE" "$latest_bak"

    # Step 3: Atomic replace
    log_info "🔄 Deploying staging code to $LIVE_FILE..."
    cp "$staging" "$LIVE_FILE"

    # Step 4: Restart service
    log_info "⚡ Restarting antigravity-bridge service (via systemd auto-restart on SIGTERM)..."
    pkill -f "antigravity_bridge.py" || true
    sleep 2

    # Step 5: Post-deployment health verification
    if wait_for_health; then
        log_ok "🎉 DEPLOYMENT SUCCESSFUL! Bridge is healthy and running updated code."
        cmd_status
    else
        log_err "🚨 CRITICAL: Post-deployment health check failed! INITIATING AUTO-ROLLBACK..."
        cp "$latest_bak" "$LIVE_FILE"
        pkill -f "antigravity_bridge.py" || true
        sleep 3
        if wait_for_health; then
            log_warn "⚠️ Rollback to backup was successful. Service is restored with previous working version."
        else
            log_err "❌ FATAL: Auto-rollback failed to restore health. Please check systemctl logs manually!"
        fi
        exit 1
    fi
}

cmd_rollback() {
    local bak_file="${1:-$SCRIPT_DIR/antigravity_bridge.py.bak}"

    if [ ! -f "$bak_file" ]; then
        log_err "Backup file not found: $bak_file"
        exit 1
    fi

    log_warn "Reverting $LIVE_FILE to $bak_file..."
    cp "$bak_file" "$LIVE_FILE"
    pkill -f "antigravity_bridge.py" || true
    sleep 3

    if wait_for_health; then
        log_ok "Rollback completed and service is healthy."
    else
        log_err "Service not healthy after rollback."
        exit 1
    fi
}

cmd_status() {
    log_info "📊 Current Service Status:"
    systemctl status antigravity-bridge.service --no-pager | head -n 15 || true
    echo ""
    local api_key
    api_key=$(get_api_key)
    local auth_header=()
    if [ -n "$api_key" ]; then
        auth_header=(-H "Authorization: Bearer $api_key")
    fi
    log_info "🩺 Health Check Endpoint Output:"
    curl -s "${auth_header[@]}" "$HEALTH_URL" | python3 -m json.tool | head -n 25 || true
    echo ""
}

ACTION="${1:-}"
case "$ACTION" in
    stage)
        cmd_stage "${2:-}"
        ;;
    test)
        cmd_test "${2:-}"
        ;;
    deploy)
        cmd_deploy "${2:-}"
        ;;
    rollback)
        cmd_rollback "${2:-}"
        ;;
    status)
        cmd_status
        ;;
    *)
        usage
        ;;
esac
