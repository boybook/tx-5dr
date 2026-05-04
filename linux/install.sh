#!/bin/bash
# TX-5DR One-Click Install Script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _d in "$SCRIPT_DIR/lib" "$SCRIPT_DIR/../lib" "/usr/share/tx5dr/lib"; do
    if [[ -f "$_d/common.sh" ]]; then LIB_DIR="$_d"; break; fi
done
if [[ -z "${LIB_DIR:-}" ]]; then echo "ERROR: Cannot find lib/common.sh" >&2; exit 1; fi
# shellcheck source=lib/common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=lib/checks.sh
source "$LIB_DIR/checks.sh"

MODE="install"
DEB_FILE=""
for arg in "$@"; do
    case "$arg" in
        --check-only) MODE="check" ;;
        --docker) MODE="docker" ;;
        --no-live""kit|--with-live""kit)
            log_warn "This option has been removed; realtime voice now uses rtc-data-audio with ws-compat fallback."
            ;;
        *.deb|*.rpm) DEB_FILE="$arg" ;;
    esac
done

detect_os
load_config
TOTAL_STEPS=7
[[ "$MODE" == "check" ]] && TOTAL_STEPS=5
[[ "$MODE" == "docker" ]] && TOTAL_STEPS=2
ISSUES=0

step_header() {
    local n="$1" label="$2"
    echo ""
    log_step "$(msg STEP "$n" "$TOTAL_STEPS")  $label"
}

echo ""
echo -e "${_BOLD}TX-5DR Server Install${_NC}"
echo "═══════════════════════════════════════"

step_header 1 "$(msg CHECKING_ENV)"
log_info "OS: ${OS_ID} ${OS_VERSION_ID} (${OS_CODENAME}), Arch: ${ARCH}"
log_info "rtc-data-audio UDP port: ${RTC_DATA_AUDIO_UDP_PORT:-50110}"

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
        if fix_nodejs; then log_ok "Node.js $(node --version 2>/dev/null) (installed)"; else log_fail "Node.js (fix failed)"; ISSUES=$((ISSUES + 1)); fi
    fi
fi

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
    if fix_glibcxx; then log_ok "GLIBCXX_3.4.32 (fixed)"; else log_fail "GLIBCXX_3.4.32 (fix failed)"; ISSUES=$((ISSUES + 1)); fi
fi

if ! check_rtc_data_audio_udp_config; then
    log_fail "rtc-data-audio UDP port invalid (${RTC_DATA_AUDIO_UDP_PORT:-})"
    ISSUES=$((ISSUES + 1))
fi

if [[ "$MODE" == "docker" ]]; then
    echo ""
    [[ $ISSUES -eq 0 ]] && log_info "$(msg ALL_CHECKS_PASSED)" || log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
    rm -rf /var/lib/apt/lists/* 2>/dev/null || true
    exit $ISSUES
fi

step_header 4 "Opus"
if check_libopus; then
    log_ok "libopus"
elif [[ "$MODE" == "check" ]]; then
    log_fail "libopus not found (realtime voice will fall back to PCM)"
    echo "      $(msg FIX_OPUS)"
    ISSUES=$((ISSUES + 1))
else
    require_root
    if fix_opus; then log_ok "Opus audio codec (installed)"; else log_fail "Opus setup failed"; ISSUES=$((ISSUES + 1)); fi
fi

step_header 5 "nginx"
if check_nginx_installed; then
    nginx_ver=$($NGINX_BIN -v 2>&1 | grep -oP '[\d.]+' | head -1 || true)
    log_ok "nginx ${nginx_ver}"
elif [[ "$MODE" == "check" ]]; then
    log_fail "nginx not found"
    echo "      $(msg FIX_NGINX)"
    ISSUES=$((ISSUES + 1))
else
    require_root
    if fix_nginx; then log_ok "nginx (installed)"; else log_fail "nginx (fix failed)"; ISSUES=$((ISSUES + 1)); fi
fi

if [[ "$MODE" != "check" ]]; then
    require_root
    fix_rtc_data_audio_firewall >/dev/null 2>&1 || true
fi

if [[ "$MODE" != "docker" ]] && command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    if check_selinux_nginx "${HTTP_PORT}"; then
        log_ok "SELinux nginx (port ${HTTP_PORT}, proxy)"
    elif [[ "$MODE" == "check" ]]; then
        log_fail "SELinux nginx (port ${HTTP_PORT} blocked or proxy disabled)"
        ISSUES=$((ISSUES + 1))
    else
        require_root
        if fix_selinux_nginx "${HTTP_PORT}"; then log_ok "SELinux nginx (fixed)"; else log_fail "SELinux nginx (fix failed)"; ISSUES=$((ISSUES + 1)); fi
    fi
fi

if [[ "$MODE" == "check" ]]; then
    echo ""
    [[ $ISSUES -eq 0 ]] && log_info "$(msg ALL_CHECKS_PASSED)" || log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
    exit $ISSUES
fi

step_header 6 "Install TX-5DR"
require_root
IS_UPGRADE=false
if [[ -f /usr/share/tx5dr/packages/server/dist/index.js ]]; then IS_UPGRADE=true; fi

if [[ -n "$DEB_FILE" && -f "$DEB_FILE" ]]; then
    $IS_UPGRADE && systemctl stop tx5dr 2>/dev/null || true
    if [[ "$DEB_FILE" == *.rpm ]]; then
        if rpm -q tx5dr &>/dev/null; then dnf reinstall -y "$DEB_FILE" 2>&1 | tail -3 || rpm -Uvh --force "$DEB_FILE" 2>&1 | tail -3 || true; else dnf install -y "$DEB_FILE" 2>&1 | tail -3 || rpm -ivh --force "$DEB_FILE" 2>&1 | tail -3 || true; fi
    else
        dpkg -i --force-depends "$DEB_FILE" 2>&1 | tail -3
        apt-get install -f -y >/dev/null 2>&1 || true
    fi
elif [[ -n "$DEB_FILE" ]]; then
    log_error "File not found: $DEB_FILE"; exit 1
else
    if $IS_UPGRADE; then log_ok "TX-5DR already installed (no package file provided, keeping current version)"; else log_error "No .deb file provided and TX-5DR is not installed."; exit 1; fi
fi

# Post-install: verify @discordjs/opus native module loads correctly
if [[ -d /usr/share/tx5dr/packages/server/node_modules/@discordjs/opus ]]; then
    if check_opus_module; then
        log_ok "Opus native module verified (realtime voice codec ready)"
    else
        log_warn "Opus native module check failed, attempting prebuild path fix..."
        fix_opus
        if check_opus_module; then
            log_ok "Opus native module fixed"
        else
            log_warn "Opus native module still unavailable; realtime voice will fall back to PCM"
        fi
    fi
fi

step_header 7 "Start & Verify"
systemctl daemon-reload
systemctl start nginx 2>/dev/null || true
if $IS_UPGRADE; then systemctl restart tx5dr; else systemctl start tx5dr; fi

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

echo ""
echo "═══════════════════════════════════════"
log_info "$(msg START_OK)"
echo ""
web_url=$(get_web_url)
echo -e "  ${_BOLD}Web UI:${_NC} ${web_url}"
echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"
echo ""
