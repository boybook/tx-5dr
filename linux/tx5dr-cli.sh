#!/bin/bash
# /usr/bin/tx5dr — TX-5DR service management CLI
set -euo pipefail

for _d in /usr/share/tx5dr/lib "$(dirname "$0")/../lib"; do
    if [[ -f "$_d/common.sh" ]]; then LIB_DIR="$_d"; break; fi
done
if [[ -z "${LIB_DIR:-}" ]]; then echo "ERROR: Cannot find lib/common.sh" >&2; exit 1; fi
# shellcheck source=lib/common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=lib/checks.sh
source "$LIB_DIR/checks.sh"
load_config

cmd_start() {
    echo "$(msg STARTING)"
    sudo systemctl start tx5dr
    echo -n "  "
    if wait_for_port "${API_PORT}" 15; then log_ok "$(msg PORT_READY "$API_PORT") (backend)"; else log_fail "$(msg PORT_FAIL "$API_PORT" "15")"; sudo journalctl -u tx5dr -n 10 --no-pager 2>/dev/null | sed 's/^/    /'; exit 1; fi
    if ! check_nginx_running 2>/dev/null; then sudo systemctl start nginx 2>/dev/null || true; fi
    echo -n "  "
    if wait_for_port "${HTTP_PORT}" 5; then log_ok "$(msg PORT_READY "$HTTP_PORT") (nginx)"; else log_warn "$(msg PORT_FAIL "$HTTP_PORT" "5")"; fi
    sleep 1
    echo ""
    log_info "$(msg START_OK)"
    echo -e "  ${_BOLD}Web UI:${_NC} $(get_web_url)"
    echo -e "  ${_BOLD}Plugins:${_NC} ${PLUGIN_DIR}"
    echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"
    if ! check_ssl; then echo ""; log_warn "$(msg SSL_NOT_CONFIGURED)"; echo -e "  ${_DIM}$(msg SSL_HINT)${_NC}"; fi
}

cmd_stop() {
    echo "$(msg STOPPING)"
    sudo systemctl stop tx5dr
    log_ok "$(msg STOP_OK)"
}

cmd_restart() {
    echo "$(msg RESTARTING)"
    sudo systemctl restart tx5dr
    echo -n "  "
    if wait_for_port "${API_PORT}" 15; then log_ok "$(msg PORT_READY "$API_PORT") (backend)"; else log_fail "$(msg PORT_FAIL "$API_PORT" "15")"; sudo journalctl -u tx5dr -n 10 --no-pager 2>/dev/null | sed 's/^/    /'; exit 1; fi
    if ! check_nginx_running 2>/dev/null; then sudo systemctl start nginx 2>/dev/null || true; fi
    echo -n "  "
    if wait_for_port "${HTTP_PORT}" 5; then log_ok "$(msg PORT_READY "$HTTP_PORT") (nginx)"; else log_warn "$(msg PORT_FAIL "$HTTP_PORT" "5")"; fi
    echo ""
    log_info "$(msg START_OK)"
    echo -e "  ${_BOLD}Web UI:${_NC} $(get_web_url)"
}

cmd_status() {
    echo ""
    echo -e "${_BOLD}TX-5DR Status${_NC}"
    echo "─────────────────────────────────────"
    local srv_status ngx_status be_status http_status ip version
    srv_status=$(get_systemd_state tx5dr)
    ngx_status=$(get_systemd_state nginx)
    be_status="closed"; is_port_open "${API_PORT}" && be_status="open"
    http_status="closed"; is_port_open "${HTTP_PORT}" && http_status="open"
    ip=$(get_local_ip)
    version="unknown"; [[ -f /usr/share/tx5dr/version ]] && version=$(cat /usr/share/tx5dr/version)
    echo -e "  Server:     ${srv_status}"
    echo -e "  Nginx:      ${ngx_status}"
    echo -e "  Backend:    port ${API_PORT} ${be_status}"
    echo -e "  Web UI:     port ${HTTP_PORT} ${http_status} → http://${ip:-localhost}:${HTTP_PORT}"
    if check_ssl; then
        local ssl_status="closed"; is_port_open "${SSL_PORT}" && ssl_status="open"
        echo -e "  HTTPS:      port ${SSL_PORT} ${ssl_status} → https://${ip:-localhost}:${SSL_PORT}"
    else
        echo -e "  HTTPS:      ${_YELLOW}not configured${_NC} ${_DIM}(run: sudo tx5dr doctor --fix)${_NC}"
    fi
    echo -e "  Realtime:   rtc-data-audio UDP ${RTC_DATA_AUDIO_UDP_PORT:-50110}, fallback ws-compat"
    echo -e "  Node.js:    $(command -v node >/dev/null 2>&1 && node --version || echo not found)"
    echo -e "  Version:    ${version}"
    echo -e "  Data Dir:   ${DATA_DIR}"
    echo -e "  Plugins:    ${PLUGIN_DIR}"
}

cmd_token() {
    case "${1:-}" in
        --reset|reset)
            sudo rm -f "${CONFIG_DIR}/.admin-token" 2>/dev/null || true
            log_info "$(msg TOKEN_RESET)"
            cmd_restart
            ;;
        *)
            local token_file="${CONFIG_DIR}/.admin-token"
            if [[ -f "$token_file" ]]; then echo -e "${_BOLD}$(msg TOKEN_LABEL):${_NC} $(sudo cat "$token_file")"; else log_warn "$(msg TOKEN_NOT_FOUND)"; fi
            ;;
    esac
}

cmd_update() {
    detect_os
    local current_ver="unknown"
    [[ -f /usr/share/tx5dr/version ]] && current_ver=$(cat /usr/share/tx5dr/version)

    echo "$(msg CHECKING_UPDATE)"

    local pkg_arch="$ARCH"
    local pkg_ext="deb"
    [[ "$(os_family)" == "rhel" ]] && pkg_ext="rpm"
    local asset_name="TX-5DR-nightly-server-linux-${pkg_arch}.${pkg_ext}"
    local fallback_url
    fallback_url=$(get_github_release_asset_url "nightly-server" "$asset_name")

    local manifest_json=""
    local download_url=""
    local package_sha256=""
    local remote_version="nightly"
    local remote_sha="unknown"
    local remote_date="unknown"
    local remote_title=""
    local preferred_source="github"

    if should_prefer_oss_download; then
        preferred_source="oss"
        log_info "Detected mainland China or OSS override. Preferring OSS mirror."
    fi

    if manifest_json=$(fetch_server_manifest_from_source "$preferred_source" 2>/dev/null); then
        download_url=$(get_server_manifest_package_url_for_source "$manifest_json" "$pkg_arch" "$pkg_ext" "$preferred_source" 2>/dev/null || true)
        package_sha256=$(get_server_manifest_package_sha256 "$manifest_json" "$pkg_arch" "$pkg_ext" 2>/dev/null || true)
        remote_version=$(get_server_manifest_version "$manifest_json" 2>/dev/null || true)
        remote_sha=$(get_server_manifest_commit "$manifest_json" 2>/dev/null || true)
        remote_date=$(get_server_manifest_published_at "$manifest_json" 2>/dev/null || true)
        remote_date="${remote_date%%T*}"
        remote_title=$(get_server_manifest_commit_title "$manifest_json" 2>/dev/null || true)

        if [[ -z "$download_url" ]]; then
            local fallback_source="oss"
            [[ "$preferred_source" == "oss" ]] && fallback_source="github"
            download_url=$(get_server_manifest_package_url_for_source "$manifest_json" "$pkg_arch" "$pkg_ext" "$fallback_source" 2>/dev/null || true)
        fi
    else
        log_warn "Release manifest unavailable, falling back to direct GitHub release asset."
    fi

    if [[ -z "$download_url" ]]; then
        package_sha256=""
        download_url="$fallback_url"
    fi

    local remote_label="${remote_version:-nightly}"
    if [[ "$remote_label" == "nightly" && ( -n "${remote_sha:-}" || -n "${remote_date:-}" ) ]]; then
        remote_label="nightly (${remote_sha:-unknown}, ${remote_date:-unknown})"
    fi
    log_info "$(printf "$(msg UPDATE_AVAILABLE)" "$current_ver" "$remote_label")"
    [[ -n "$remote_title" ]] && log_info "Latest summary: $remote_title"

    local tmp_pkg="/tmp/${asset_name}"
    echo "$(printf "$(msg DOWNLOADING)" "$asset_name")"
    if ! curl -fSL --progress-bar -o "$tmp_pkg" "$download_url"; then
        log_warn "Primary download failed, falling back to GitHub release..."
        if ! curl -fSL --progress-bar -o "$tmp_pkg" "$fallback_url"; then
            log_error "$(msg UPDATE_FAILED)"
            rm -f "$tmp_pkg"
            return 1
        fi
        package_sha256=""
    fi

    if [[ -n "$package_sha256" ]] && command -v sha256sum &>/dev/null; then
        if ! printf "%s  %s\n" "$package_sha256" "$tmp_pkg" | sha256sum -c - >/dev/null 2>&1; then
            log_warn "Package checksum mismatch, falling back to GitHub release..."
            rm -f "$tmp_pkg"
            if ! curl -fSL --progress-bar -o "$tmp_pkg" "$fallback_url"; then
                log_error "$(msg UPDATE_FAILED)"
                return 1
            fi
        fi
    fi

    sudo bash /usr/share/tx5dr/install.sh "$tmp_pkg"
    local rc=$?
    rm -f "$tmp_pkg"

    [[ $rc -eq 0 ]] && log_info "$(msg UPDATE_DONE)"
    return $rc
}

cmd_doctor_fix_internal() {
    require_root
    load_config
    detect_os
    check_nodejs || fix_nodejs || true
    check_glibcxx || fix_glibcxx || true
    check_nginx_installed || fix_nginx || true
    check_nginx_realtime_proxy_config || fix_nginx_realtime_proxy_config || true
    check_rtc_data_audio_udp_config || true
    fix_rtc_data_audio_firewall || true
    check_tx5dr_user || fix_tx5dr_user_groups || true
    if ! check_ssl_cert_files; then generate_self_signed_cert || true; elif check_ssl_cert_is_self_signed && ! check_ssl_cert_validity; then renew_self_signed_cert || true; fi
    if check_ssl_cert_files && check_nginx_installed && ! check_nginx_ssl_block; then fix_nginx_ssl_config || true; fi
    if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then fix_selinux_nginx "${HTTPS_PORT:-8443}" || true; fi
    run_doctor
}

cmd_doctor() {
    case "${1:-}" in
        --fix|fix) if [[ $EUID -ne 0 ]]; then exec sudo "$0" __doctor_fix; fi; "$0" __doctor_fix ;;
        --help|-h|help) echo "Usage: tx5dr doctor [--fix]" ;;
        *) run_doctor ;;
    esac
}

cmd_ssl() {
    case "${1:-status}" in
        status) run_doctor | sed -n '/SSL/Ip' || true ;;
        renew) if [[ $EUID -ne 0 ]]; then exec sudo "$0" __ssl_renew; fi; renew_self_signed_cert; systemctl reload nginx 2>/dev/null || true ;;
        --help|-h|help) echo "Usage: tx5dr ssl [status|renew]" ;;
        *) log_error "Unknown ssl action: ${1:-}"; return 1 ;;
    esac
}

cmd_logs() {
    case "${1:-}" in
        --nginx) sudo tail -f /var/log/nginx/error.log ;;
        --all) sudo journalctl -u tx5dr -u nginx -f ;;
        *) journalctl -u tx5dr -f ;;
    esac
}

cmd_removed_realtime() {
    log_error "This legacy realtime command has been removed. Use rtc-data-audio with ws-compat fallback instead."
    return 1
}

cmd_help() {
    echo ""
    echo -e "${_BOLD}TX-5DR Digital Radio Server${_NC}"
    echo ""
    echo "Usage: tx5dr <command>"
    echo ""
    echo "Commands:"
    echo "  start    Start server and verify startup"
    echo "  stop     Stop server"
    echo "  restart  Restart server"
    echo "  status   Show service status dashboard"
    echo "  logs     Follow service logs (--nginx / --all)"
    echo "  token    Show admin token (--reset to regenerate)"
    echo "  update   Download and install latest nightly build"
    echo "  doctor   Run full environment diagnostics (--fix to auto-repair)"
    echo "  ssl      Show SSL certificate status (renew to regenerate)"
    echo "  enable   Enable auto-start on boot"
    echo "  disable  Disable auto-start on boot"
    echo "  version  Show version"
    echo ""
}

case "${1:-help}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    token) cmd_token "${2:-}" ;;
    update) cmd_update ;;
    doctor) cmd_doctor "${2:-}" ;;
    ssl) cmd_ssl "${2:-}" ;;
    logs) cmd_logs "${2:-}" ;;
    __doctor_fix) cmd_doctor_fix_internal ;;
    __ssl_renew) renew_self_signed_cert; systemctl reload nginx 2>/dev/null || true ;;
    live""kit-creds|enable-live""kit|disable-live""kit|__rotate_live""kit_creds) cmd_removed_realtime ;;
    enable) sudo systemctl enable tx5dr; log_ok "TX-5DR enabled for auto-start on boot." ;;
    disable) sudo systemctl disable tx5dr; log_ok "TX-5DR disabled from auto-start." ;;
    version) [[ -f /usr/share/tx5dr/version ]] && cat /usr/share/tx5dr/version || echo "TX-5DR (version unknown)" ;;
    help|--help|-h|*) cmd_help ;;
esac
