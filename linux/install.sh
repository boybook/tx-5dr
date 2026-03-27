#!/bin/bash
# TX-5DR One-Click Install Script
# Usage:
#   sudo bash install.sh [path-to-local.deb]    # Install from local file
#   sudo bash install.sh --check-only            # Only check environment
#   sudo bash install.sh --docker                # Docker mode (skip systemd/user/nginx)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find lib/ relative to this script, or at the installed location
for _d in "$SCRIPT_DIR/lib" "$SCRIPT_DIR/../lib" "/usr/share/tx5dr/lib"; do
    if [[ -f "$_d/common.sh" ]]; then
        LIB_DIR="$_d"
        break
    fi
done
if [[ -z "${LIB_DIR:-}" ]]; then
    echo "ERROR: Cannot find lib/common.sh" >&2; exit 1
fi

# shellcheck source=lib/common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=lib/checks.sh
source "$LIB_DIR/checks.sh"

# ── Parse arguments ──────────────────────────────────────────────────────────

MODE="install"
DEB_FILE=""
for arg in "$@"; do
    case "$arg" in
        --check-only) MODE="check" ;;
        --docker)     MODE="docker" ;;
        *.deb|*.rpm)  DEB_FILE="$arg" ;;
    esac
done

detect_os
load_config

TOTAL_STEPS=6
[[ "$MODE" == "check" ]] && TOTAL_STEPS=4
[[ "$MODE" == "docker" ]] && TOTAL_STEPS=2

ISSUES=0

# ── Helper ───────────────────────────────────────────────────────────────────

step_header() {
    local n="$1" label="$2"
    echo ""
    log_step "$(msg STEP "$n" "$TOTAL_STEPS")  $label"
}

run_check_fix() {
    local check_fn="$1" fix_fn="$2" label="$3"
    if "$check_fn"; then
        log_ok "$label"
        return 0
    fi
    if [[ "$MODE" == "check" ]]; then
        log_fail "$label"
        ISSUES=$((ISSUES + 1))
        return 1
    fi
    # Attempt auto-fix
    if "$fix_fn"; then
        log_ok "$label (fixed)"
        return 0
    else
        log_fail "$label (fix failed)"
        ISSUES=$((ISSUES + 1))
        return 1
    fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${_BOLD}TX-5DR Server Install${_NC}"
echo "═══════════════════════════════════════"

# Step 1: System info
step_header 1 "$(msg CHECKING_ENV)"
log_info "OS: ${OS_ID} ${OS_VERSION_ID} (${OS_CODENAME}), Arch: ${ARCH}"

# Step 2: Node.js (skip in docker mode)
if [[ "$MODE" != "docker" ]]; then
    step_header 2 "Node.js >= 20"
    if check_nodejs; then
        log_ok "Node.js $(node --version 2>/dev/null)"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "Node.js not found or < 20"
        echo "      $(msg FIX_NODEJS)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_nodejs; then
            log_ok "Node.js $(node --version 2>/dev/null) (installed)"
        else
            log_fail "Node.js (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi
fi

# Step 3: GLIBCXX (both native and docker)
STEP_N=3
[[ "$MODE" == "docker" ]] && STEP_N=2
step_header $STEP_N "GLIBCXX_3.4.32"
if check_glibcxx; then
    log_ok "GLIBCXX_3.4.32 found"
elif [[ "$MODE" == "check" ]]; then
    log_fail "GLIBCXX_3.4.32 not found"
    echo "      $(msg FIX_GLIBCXX)"
    ISSUES=$((ISSUES + 1))
else
    require_root
    if fix_glibcxx; then
        log_ok "GLIBCXX_3.4.32 (fixed)"
    else
        log_fail "GLIBCXX_3.4.32 (fix failed)"
        ISSUES=$((ISSUES + 1))
    fi
fi

# Check glibc version (informational)
local_glibc_int=$(get_glibc_version_int)
# Avoid SIGPIPE: head -1 closes pipe causing ldd to get signal 141 under pipefail
local_glibc_ver=$(ldd --version 2>&1 | grep -oP '\d+\.\d+' | head -1 || true)
if [[ "$local_glibc_int" -ge 241 ]]; then
    log_info "glibc ${local_glibc_ver} detected — GLIBC_TUNABLES=glibc.rtld.execstack=2 is configured in service file"
fi

# Docker mode: done after GLIBCXX fix
if [[ "$MODE" == "docker" ]]; then
    echo ""
    if [[ $ISSUES -eq 0 ]]; then
        log_info "$(msg ALL_CHECKS_PASSED)"
    else
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
    fi
    # Cleanup apt cache in docker
    rm -rf /var/lib/apt/lists/* 2>/dev/null || true
    exit $ISSUES
fi

# Step 4: nginx (native only)
if [[ "$MODE" != "docker" ]]; then
    step_header 4 "nginx"
    if check_nginx_installed; then
        nginx_ver=$($NGINX_BIN -v 2>&1 | grep -oP '[\d.]+' | head -1 || true)
        log_ok "nginx ${nginx_ver}"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "nginx not found"
        echo "      $(msg FIX_NGINX)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_nginx; then
            log_ok "nginx (installed)"
        else
            log_fail "nginx (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi
fi

# Check-only mode: done
if [[ "$MODE" == "check" ]]; then
    echo ""
    if [[ $ISSUES -eq 0 ]]; then
        log_info "$(msg ALL_CHECKS_PASSED)"
    else
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
    fi
    exit $ISSUES
fi

# Step 5: Install / Upgrade TX-5DR package
step_header 5 "Install TX-5DR"
require_root
IS_UPGRADE=false
if [[ -f /usr/share/tx5dr/packages/server/dist/index.js ]]; then
    IS_UPGRADE=true
fi

if [[ -n "$DEB_FILE" && -f "$DEB_FILE" ]]; then
    if $IS_UPGRADE; then
        log_info "Upgrading from $DEB_FILE"
        # Stop running service before upgrade
        systemctl stop tx5dr 2>/dev/null || true
    else
        log_info "Installing from $DEB_FILE"
    fi
    if [[ "$DEB_FILE" == *.rpm ]]; then
        dnf install -y "$DEB_FILE" 2>&1 | tail -3 || rpm -ivh --force "$DEB_FILE" 2>&1 | tail -3 || true
    else
        dpkg -i --force-depends "$DEB_FILE" 2>&1 | tail -3
        apt-get install -f -y >/dev/null 2>&1 || true
    fi
elif [[ -n "$DEB_FILE" ]]; then
    log_error "File not found: $DEB_FILE"
    exit 1
else
    if $IS_UPGRADE; then
        log_ok "TX-5DR already installed (no package file provided, keeping current version)"
    else
        log_error "No .deb file provided and TX-5DR is not installed."
        log_error "Usage: sudo bash install.sh path/to/tx5dr.deb"
        exit 1
    fi
fi

# Step 6: Start / Restart and verify
step_header 6 "Start & Verify"
systemctl daemon-reload
systemctl start nginx 2>/dev/null || true
if $IS_UPGRADE; then
    systemctl restart tx5dr
else
    systemctl start tx5dr
fi

echo -n "  "
if wait_for_port "${API_PORT}" 15; then
    log_ok "$(msg PORT_READY "$API_PORT") (backend)"
else
    log_fail "$(msg PORT_FAIL "$API_PORT" "15")"
    echo ""
    log_error "$(msg START_FAIL)"
    journalctl -u tx5dr -n 10 --no-pager 2>/dev/null | sed 's/^/    /'
    echo ""
    log_info "$(msg RUN_DOCTOR)"
    exit 1
fi

echo -n "  "
if wait_for_port "${HTTP_PORT}" 5; then
    log_ok "$(msg PORT_READY "$HTTP_PORT") (nginx)"
else
    log_warn "$(msg PORT_FAIL "$HTTP_PORT" "5") — nginx may need reload"
    systemctl reload nginx 2>/dev/null || true
fi

# Success — show access info
echo ""
echo "═══════════════════════════════════════"
log_info "$(msg START_OK)"
echo ""
web_url=$(get_web_url)
echo -e "  ${_BOLD}Web UI:${_NC} ${web_url}"
echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"
echo ""
