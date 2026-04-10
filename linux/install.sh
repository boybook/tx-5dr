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
INSTALL_LIVEKIT=""
for arg in "$@"; do
    case "$arg" in
        --check-only)    MODE="check" ;;
        --docker)        MODE="docker" ;;
        --no-livekit)    INSTALL_LIVEKIT="false" ;;
        --with-livekit)  INSTALL_LIVEKIT="true" ;;
        *.deb|*.rpm)     DEB_FILE="$arg" ;;
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

# SELinux nginx (RHEL/Fedora only, after nginx is installed)
if [[ "$MODE" != "docker" ]] && command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    if check_selinux_nginx "${HTTP_PORT}"; then
        log_ok "SELinux nginx (port ${HTTP_PORT}, proxy)"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "SELinux nginx (port ${HTTP_PORT} blocked or proxy disabled)"
        echo "      sudo semanage port -a -t http_port_t -p tcp ${HTTP_PORT} && sudo setsebool -P httpd_can_network_connect 1"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_selinux_nginx "${HTTP_PORT}"; then
            log_ok "SELinux nginx (port ${HTTP_PORT}, proxy) (fixed)"
        else
            log_fail "SELinux nginx (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi
fi

# LiveKit server binary (native only, optional)
if [[ "$MODE" != "docker" ]]; then
    # Determine whether to install LiveKit
    if [[ -z "$INSTALL_LIVEKIT" && "$MODE" == "install" ]]; then
        # Interactive prompt (skip in check-only mode)
        echo ""
        echo -e "  ${_BOLD}Install LiveKit realtime voice service?${_NC}"
        echo "  Recommended for lower-latency voice transport."
        echo "  Not required — you can always install later via: sudo tx5dr enable-livekit"
        echo -n "  [Y/n]: "
        read -r livekit_answer </dev/tty 2>/dev/null || livekit_answer="y"
        case "${livekit_answer,,}" in
            n|no) INSTALL_LIVEKIT="false" ;;
            *)    INSTALL_LIVEKIT="true" ;;
        esac
    fi
    [[ -z "$INSTALL_LIVEKIT" ]] && INSTALL_LIVEKIT="true"

    if [[ "$INSTALL_LIVEKIT" != "true" ]]; then
        log_info "LiveKit skipped (ws-compat mode). Install later: sudo tx5dr enable-livekit"
    fi

  if [[ "$INSTALL_LIVEKIT" == "true" ]]; then
    if check_livekit_binary; then
        log_ok "livekit-server ($(get_livekit_binary_path))"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "livekit-server not found"
        echo "      expected bundled path: /usr/share/tx5dr/bin/livekit-server"
        echo "      $(msg FIX_LIVEKIT_BINARY)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_livekit_binary; then
            log_ok "livekit-server ($(get_livekit_binary_path))"
        else
            log_fail "livekit-server (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi

    if check_livekit_credentials_exists && check_livekit_credentials_loaded; then
        log_ok "LiveKit credentials ($(get_livekit_credentials_path))"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "LiveKit credentials missing or invalid"
        echo "      $(msg FIX_LIVEKIT_CREDENTIALS)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_livekit_credentials; then
            log_ok "LiveKit credentials ($(get_livekit_credentials_path))"
        else
            log_fail "LiveKit credentials (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi

    if check_livekit_config; then
        log_ok "LiveKit config ($(get_livekit_config_path))"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "LiveKit config missing or mismatched"
        echo "      $(msg FIX_LIVEKIT_CONFIG)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_livekit_config; then
            log_ok "LiveKit config ($(get_livekit_config_path))"
        else
            log_fail "LiveKit config (fix failed)"
            ISSUES=$((ISSUES + 1))
        fi
    fi

    if check_livekit_url_consistency; then
        log_ok "LiveKit bridge URL (${LIVEKIT_URL})"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "LiveKit bridge URL port mismatch: ${LIVEKIT_URL}"
        echo "      expected to target signaling port ${LIVEKIT_SIGNAL_PORT}"
        ISSUES=$((ISSUES + 1))
    else
        log_warn "LiveKit bridge URL port mismatch: ${LIVEKIT_URL}"
        log_warn "Update LIVEKIT_URL to target signaling port ${LIVEKIT_SIGNAL_PORT} if you changed the port."
    fi
  fi  # INSTALL_LIVEKIT == true
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
        if rpm -q tx5dr &>/dev/null; then
            dnf reinstall -y "$DEB_FILE" 2>&1 | tail -3 || rpm -Uvh --force "$DEB_FILE" 2>&1 | tail -3 || true
        else
            dnf install -y "$DEB_FILE" 2>&1 | tail -3 || rpm -ivh --force "$DEB_FILE" 2>&1 | tail -3 || true
        fi
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

if [[ "${INSTALL_LIVEKIT:-true}" == "true" ]] && check_livekit_binary 2>/dev/null; then
    echo -n "  "
    if wait_for_port "${LIVEKIT_SIGNAL_PORT:-7880}" 15; then
        log_ok "$(msg PORT_READY "${LIVEKIT_SIGNAL_PORT:-7880}") (livekit)"
    else
        log_warn "$(msg PORT_FAIL "${LIVEKIT_SIGNAL_PORT:-7880}" "15") (livekit — ws-compat fallback active)"
    fi
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
