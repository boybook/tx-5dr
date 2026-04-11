#!/bin/bash
# /usr/bin/tx5dr — TX-5DR service management CLI
set -euo pipefail

# Find lib/ at the installed location
for _d in /usr/share/tx5dr/lib "$(dirname "$0")/../lib"; do
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

load_config

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_start() {
    echo "$(msg STARTING)"
    sudo systemctl start tx5dr

    # Wait for backend
    echo -n "  "
    if wait_for_port "${API_PORT}" 15; then
        log_ok "$(msg PORT_READY "$API_PORT") (backend)"
    else
        log_fail "$(msg PORT_FAIL "$API_PORT" "15")"
        echo ""
        log_error "$(msg START_FAIL)"
        sudo journalctl -u tx5dr -n 10 --no-pager 2>/dev/null | sed 's/^/    /'
        echo ""
        log_info "$(msg RUN_DOCTOR)"
        exit 1
    fi

    # Ensure nginx is running
    if ! check_nginx_running 2>/dev/null; then
        sudo systemctl start nginx 2>/dev/null || true
    fi

    echo -n "  "
    if wait_for_port "${HTTP_PORT}" 5; then
        log_ok "$(msg PORT_READY "$HTTP_PORT") (nginx)"
    else
        log_warn "$(msg PORT_FAIL "$HTTP_PORT" "5")"
    fi

    # Wait a moment for server to write token file
    sleep 1

    # Check HTTPS port if SSL is configured
    if check_ssl; then
        echo -n "  "
        if is_port_open "${HTTPS_PORT:-8443}"; then
            log_ok "$(msg PORT_READY "${HTTPS_PORT:-8443}") (HTTPS)"
        fi
    fi

    echo ""
    log_info "$(msg START_OK)"
    local web_url
    web_url=$(get_web_url)
    echo -e "  ${_BOLD}Web UI:${_NC} ${web_url}"
    echo -e "  ${_BOLD}Plugins:${_NC} ${PLUGIN_DIR}"
    echo -e "  ${_DIM}Place plugin folders there, then reload plugins from the web UI.${_NC}"
    echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"

    if ! check_ssl; then
        echo ""
        log_warn "$(msg SSL_NOT_CONFIGURED)"
        echo -e "  ${_DIM}$(msg SSL_HINT)${_NC}"
    elif check_ssl_cert_is_self_signed 2>/dev/null; then
        echo ""
        echo -e "  ${_DIM}$(msg SSL_BROWSER_WARNING)${_NC}"
    fi
    echo ""
}

cmd_stop() {
    echo "$(msg STOPPING)"
    sudo systemctl stop tx5dr

    # Confirm port closed
    local elapsed=0
    while is_port_open "${API_PORT}" && [[ $elapsed -lt 10 ]]; do
        sleep 1; elapsed=$((elapsed + 1))
    done

    if is_port_open "${API_PORT}"; then
        log_warn "$(msg PORT_IN_USE "$API_PORT")"
    else
        log_ok "$(msg STOP_OK)"
    fi
}

cmd_restart() {
    echo "$(msg RESTARTING)"
    sudo systemctl restart tx5dr

    echo -n "  "
    if wait_for_port "${API_PORT}" 15; then
        log_ok "$(msg PORT_READY "$API_PORT") (backend)"
    else
        log_fail "$(msg PORT_FAIL "$API_PORT" "15")"
        echo ""
        log_error "$(msg START_FAIL)"
        sudo journalctl -u tx5dr -n 10 --no-pager 2>/dev/null | sed 's/^/    /'
        echo ""
        log_info "$(msg RUN_DOCTOR)"
        exit 1
    fi

    if ! check_nginx_running 2>/dev/null; then
        sudo systemctl start nginx 2>/dev/null || true
    fi

    echo -n "  "
    if wait_for_port "${HTTP_PORT}" 5; then
        log_ok "$(msg PORT_READY "$HTTP_PORT") (nginx)"
    else
        log_warn "$(msg PORT_FAIL "$HTTP_PORT" "5")"
    fi

    sleep 1
    echo ""
    log_info "$(msg START_OK)"
    local web_url
    web_url=$(get_web_url)
    echo -e "  ${_BOLD}Web UI:${_NC} ${web_url}"
    echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"
    echo ""
}

cmd_status() {
    echo ""
    echo -e "${_BOLD}TX-5DR Status${_NC}"
    echo "─────────────────────────────────────"

    # Server
    local srv_status="inactive"
    local srv_detail=""
    if systemctl is-active --quiet tx5dr 2>/dev/null; then
        srv_status=$(get_systemd_state tx5dr)
        local uptime
        uptime=$(systemctl show tx5dr --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
        [[ -n "$uptime" ]] && srv_detail="(since $uptime)"
    else
        srv_status=$(get_systemd_state tx5dr)
    fi
    echo -e "  Server:     ${srv_status} ${_DIM}${srv_detail}${_NC}"

    if check_livekit_binary 2>/dev/null; then
        local livekit_status
        livekit_status=$(get_systemd_state tx5dr-livekit)
        echo -e "  LiveKit:    ${livekit_status}"
    else
        echo -e "  LiveKit:    ${_YELLOW}not installed${_NC} ${_DIM}(ws-compat mode, run: sudo tx5dr enable-livekit)${_NC}"
    fi

    # Nginx
    local ngx_status
    ngx_status=$(get_systemd_state nginx)
    echo -e "  Nginx:      ${ngx_status}"

    # Ports
    local be_status="closed"
    is_port_open "${API_PORT}" && be_status="open"
    echo -e "  Backend:    port ${API_PORT} ${be_status}"

    if check_livekit_binary 2>/dev/null; then
        local livekit_port_status="closed"
        is_port_open "${LIVEKIT_SIGNAL_PORT}" && livekit_port_status="open"
        echo -e "  Signaling:  internal port ${LIVEKIT_SIGNAL_PORT} ${livekit_port_status}"
        echo -e "  Browser RT: same-origin ${_DIM}/livekit${_NC}"

        local livekit_tcp_status="closed"
        check_livekit_tcp_port && livekit_tcp_status="open"
        echo -e "  RTC TCP:    port ${LIVEKIT_TCP_PORT} ${livekit_tcp_status}"

        echo -e "  RTC UDP:    ${LIVEKIT_UDP_PORT_START}-${LIVEKIT_UDP_PORT_END} ${_DIM}$(describe_livekit_udp_binding)${_NC}"
    fi

    local http_status="closed"
    is_port_open "${HTTP_PORT}" && http_status="open"
    local ip
    ip=$(get_local_ip)
    echo -e "  Web UI:     port ${HTTP_PORT} ${http_status} → http://${ip:-localhost}:${HTTP_PORT}"

    # SSL
    if check_ssl; then
        local ssl_status="closed"
        is_port_open "${SSL_PORT}" && ssl_status="open"
        local ssl_mode_label=""
        if check_ssl_cert_is_self_signed 2>/dev/null; then
            ssl_mode_label=" ${_DIM}(self-signed)${_NC}"
        fi
        echo -e "  HTTPS:      port ${SSL_PORT} ${ssl_status} → https://${ip:-localhost}:${SSL_PORT}${ssl_mode_label}"
    else
        echo -e "  HTTPS:      ${_YELLOW}not configured${_NC} ${_DIM}(run: sudo tx5dr doctor --fix)${_NC}"
    fi

    # Node.js
    local node_ver="not found"
    command -v node &>/dev/null && node_ver=$(node --version 2>/dev/null)
    echo -e "  Node.js:    ${node_ver}"

    if check_livekit_binary 2>/dev/null; then
        echo -e "  LK Binary:  $(get_livekit_binary_path)"
    else
        echo -e "  LK Binary:  ${_DIM}not installed${_NC}"
    fi

    local lk_config_path
    lk_config_path=$(get_livekit_config_path)
    if check_livekit_config_exists; then
        if can_read_file_noninteractive "${lk_config_path}"; then
            if check_livekit_config_consistency; then
                echo -e "  LK Config:  ${lk_config_path}"
            else
                echo -e "  LK Config:  ${_YELLOW}${lk_config_path} (mismatch with config.env)${_NC}"
            fi
        else
            echo -e "  LK Config:  ${lk_config_path} ${_DIM}(run sudo tx5dr doctor to validate contents)${_NC}"
        fi
    else
        echo -e "  LK Config:  ${_RED}missing (${lk_config_path})${_NC}"
    fi

    if check_livekit_url_consistency; then
        echo -e "  LK URL:     ${LIVEKIT_URL} ${_DIM}(internal bridge)${_NC}"
    else
        echo -e "  LK URL:     ${_YELLOW}${LIVEKIT_URL} ${_DIM}(internal bridge, expected port ${LIVEKIT_SIGNAL_PORT})${_NC}"
    fi

    local livekit_cred_state
    livekit_cred_state=$(describe_livekit_credentials_state)
    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
        echo -e "  LK Creds:   ${_YELLOW}${livekit_cred_state}${_NC}"
    elif check_livekit_credentials_exists; then
        local rotated_at=""
        rotated_at=$(get_livekit_credential_timestamp "LIVEKIT_CREDENTIALS_ROTATED_AT" 2>/dev/null || true)
        echo -e "  LK Creds:   ${livekit_cred_state}"
        echo -e "  LK CredFile:${_DIM} $(get_livekit_credentials_path)${_NC}"
        [[ -n "$rotated_at" ]] && echo -e "  LK Rotated:${_DIM} ${rotated_at}${_NC}"
    else
        echo -e "  LK Creds:   ${_RED}missing${_NC} ${_DIM}(run: sudo tx5dr livekit-creds rotate)${_NC}"
    fi

    # Version
    local version="unknown"
    [[ -f /usr/share/tx5dr/version ]] && version=$(cat /usr/share/tx5dr/version)
    echo -e "  Version:    ${version}"

    # Data dir
    if [[ -d "${DATA_DIR}" ]]; then
        local used free
        used=$(du -sh "${DATA_DIR}" 2>/dev/null | cut -f1)
        free=$(df -h "${DATA_DIR}" 2>/dev/null | tail -1 | awk '{print $4}')
        echo -e "  Data Dir:   ${DATA_DIR} (${used} used, ${free} free)"
    fi
    echo -e "  Plugins:    ${PLUGIN_DIR}"
    echo -e "  ${_DIM}Drop plugin folders there, then reload plugins from the web UI.${_NC}"

    echo ""
}

cmd_token() {
    if [[ "${1:-}" == "--reset" ]]; then
        local token_file="${CONFIG_DIR}/.admin-token"
        if [[ -f "$token_file" ]]; then
            sudo rm -f "$token_file"
        fi
        echo "$(msg TOKEN_RESET)"
        sudo systemctl restart tx5dr
        sleep 3
    fi

    local token
    token=$(read_admin_token)
    if [[ -z "$token" ]]; then
        # Token might need time to be generated
        sleep 2
        token=$(read_admin_token)
    fi

    if [[ -n "$token" ]]; then
        local web_url
        web_url=$(get_web_url)
        echo ""
        echo -e "  ${_BOLD}$(msg TOKEN_LABEL):${_NC} ${token}"
        echo -e "  ${_BOLD}Web UI:${_NC}      ${web_url}"
        echo -e "  ${_DIM}File: ${CONFIG_DIR}/.admin-token${_NC}"
        echo ""
    else
        log_warn "$(msg TOKEN_NOT_FOUND)"
    fi
}

cmd_update() {
    detect_os
    local current_ver="unknown"
    [[ -f /usr/share/tx5dr/version ]] && current_ver=$(cat /usr/share/tx5dr/version)

    echo "$(msg CHECKING_UPDATE)"

    # Map arch: dpkg uses amd64/arm64, release assets also use amd64/arm64
    local pkg_arch="$ARCH"

    # Determine asset name based on OS family (rpm for RHEL/Fedora, deb otherwise)
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
    local preferred_source="github"
    local sources=()

    if should_prefer_oss_download; then
        preferred_source="oss"
        log_info "Detected mainland China or OSS override. Preferring OSS mirror."
    fi

    if [[ "$preferred_source" == "oss" ]]; then
        sources=(oss github)
    else
        sources=(github oss)
    fi

    local source
    for source in "${sources[@]}"; do
        if manifest_json=$(fetch_server_manifest_from_source "$source" 2>/dev/null); then
            download_url=$(get_server_manifest_package_url "$manifest_json" "$pkg_arch" "$pkg_ext" 2>/dev/null || true)
            package_sha256=$(get_server_manifest_package_sha256 "$manifest_json" "$pkg_arch" "$pkg_ext" 2>/dev/null || true)
            remote_version=$(get_server_manifest_version "$manifest_json" 2>/dev/null || true)
            remote_sha=$(get_server_manifest_commit "$manifest_json" 2>/dev/null || true)
            remote_date=$(get_server_manifest_published_at "$manifest_json" 2>/dev/null || true)
            remote_date="${remote_date%%T*}"
            if [[ -n "$download_url" ]]; then
                break
            fi
        fi
        if [[ "$source" == "oss" ]]; then
            log_warn "OSS manifest unavailable, falling back to GitHub metadata."
        else
            log_warn "GitHub manifest unavailable, falling back to direct release asset."
        fi
    done

    if [[ -z "$download_url" ]]; then
        package_sha256=""
        download_url="$fallback_url"
    fi

    local remote_label="${remote_version:-nightly}"
    if [[ "$remote_label" == "nightly" && ( -n "${remote_sha:-}" || -n "${remote_date:-}" ) ]]; then
        remote_label="nightly (${remote_sha:-unknown}, ${remote_date:-unknown})"
    fi
    log_info "$(printf "$(msg UPDATE_AVAILABLE)" "$current_ver" "$remote_label")"

    # Download
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
            log_warn "OSS package checksum mismatch, falling back to GitHub release..."
            rm -f "$tmp_pkg"
            if ! curl -fSL --progress-bar -o "$tmp_pkg" "$fallback_url"; then
                log_error "$(msg UPDATE_FAILED)"
                return 1
            fi
        fi
    fi

    # Install using install.sh (handles stop → dpkg/dnf → restart → verify)
    sudo bash /usr/share/tx5dr/install.sh "$tmp_pkg"
    local rc=$?
    rm -f "$tmp_pkg"

    if [[ $rc -eq 0 ]]; then
        log_info "$(msg UPDATE_DONE)"
    fi
    return $rc
}

remove_config_env_livekit_overrides() {
    local config_env="/etc/tx5dr/config.env"
    [[ -f "$config_env" ]] || return 0

    local tmp_file
    tmp_file=$(mktemp)
    grep -Ev '^[[:space:]]*LIVEKIT_API_KEY=|^[[:space:]]*LIVEKIT_API_SECRET=' "$config_env" > "$tmp_file" || true
    cat "$tmp_file" > "$config_env"
    rm -f "$tmp_file"
}

cmd_doctor_fix_internal() {
    require_root
    load_config
    detect_os

    local changed_livekit=0

    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" && "${LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE:-}" == "/etc/tx5dr/config.env" ]]; then
        log_info "Removing legacy LiveKit credential overrides from /etc/tx5dr/config.env"
        remove_config_env_livekit_overrides
        load_config
    fi

    if ! check_nodejs; then
        fix_nodejs || true
    fi
    if ! check_glibcxx; then
        fix_glibcxx || true
    fi
    if ! check_nginx_installed; then
        fix_nginx || true
    fi
    if check_nginx_installed && ! check_nginx_realtime_proxy_config; then
        fix_nginx_realtime_proxy_config || true
    fi
    if ! check_livekit_binary; then
        fix_livekit_binary || true
    fi
    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" != "1" ]]; then
        if ! check_livekit_credentials_exists || ! check_livekit_credentials_loaded; then
            if fix_livekit_credentials; then
                changed_livekit=1
            fi
            load_config
        fi
    fi
    if ! check_livekit_config_exists || ! check_livekit_config_consistency; then
        if fix_livekit_config; then
            changed_livekit=1
        fi
        load_config
    fi
    if ! check_tx5dr_user; then
        fix_tx5dr_user_groups || true
    fi

    # SSL certificate
    if ! check_ssl_cert_files; then
        log_info "$(msg SSL_GENERATING)"
        if generate_self_signed_cert; then
            log_ok "$(msg SSL_GENERATED)"
        fi
    elif check_ssl_cert_is_self_signed && ! check_ssl_cert_validity; then
        log_info "$(msg SSL_GENERATING)"
        if renew_self_signed_cert; then
            log_ok "$(msg SSL_RENEWED)"
        fi
    fi

    # nginx HTTPS block
    if check_ssl_cert_files && check_nginx_installed && ! check_nginx_ssl_block; then
        log_info "$(msg SSL_PATCHING_NGINX)"
        if fix_nginx_ssl_config; then
            log_ok "$(printf "$(msg SSL_NGINX_PATCHED)" "${HTTPS_PORT:-8443}")"
        fi
    fi

    # SELinux for HTTPS port
    if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        local https_port="${HTTPS_PORT:-8443}"
        if ! check_selinux_nginx "$https_port"; then
            fix_selinux_nginx "$https_port" || true
        fi
    fi

    if [[ $changed_livekit -eq 1 ]]; then
        systemctl daemon-reload 2>/dev/null || true
        systemctl restart tx5dr-livekit 2>/dev/null || true
        systemctl restart tx5dr 2>/dev/null || true
    fi

    run_doctor
}

cmd_doctor() {
    case "${1:-}" in
        --fix|fix)
            if [[ $EUID -ne 0 ]]; then
                exec sudo "$0" __doctor_fix
            fi
            "$0" __doctor_fix
            ;;
        --help|-h|help)
            echo "Usage: tx5dr doctor [--fix]"
            ;;
        *)
            run_doctor
            ;;
    esac
}

cmd_livekit_creds_help() {
    echo "Usage: tx5dr livekit-creds [status|rotate]"
    echo ""
    echo "  status   Show managed LiveKit credential status"
    echo "  rotate   Regenerate managed credentials and LiveKit config"
}

cmd_livekit_creds() {
    local action="${1:-status}"
    case "$action" in
        status)
            load_config
            echo ""
            echo -e "${_BOLD}LiveKit Credentials${_NC}"
            echo "─────────────────────────────────────"
            echo -e "  State:      $(describe_livekit_credentials_state)"
            if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
                echo -e "  Source:     ${LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE:-environment}"
            else
                echo -e "  File:       $(get_livekit_credentials_path)"
            fi
            local created_at rotated_at
            created_at=$(get_livekit_credential_timestamp "LIVEKIT_CREDENTIALS_CREATED_AT" 2>/dev/null || true)
            rotated_at=$(get_livekit_credential_timestamp "LIVEKIT_CREDENTIALS_ROTATED_AT" 2>/dev/null || true)
            [[ -n "$created_at" ]] && echo -e "  Created:    ${created_at}"
            [[ -n "$rotated_at" ]] && echo -e "  Rotated:    ${rotated_at}"
            echo ""
            ;;
        rotate)
            if [[ $EUID -ne 0 ]]; then
                exec sudo "$0" __rotate_livekit_creds
            fi
            "$0" __rotate_livekit_creds
            ;;
        --help|-h|help)
            cmd_livekit_creds_help
            ;;
        *)
            log_error "Unknown livekit-creds action: $action"
            cmd_livekit_creds_help
            return 1
            ;;
    esac
}

cmd_livekit_creds_rotate_internal() {
    load_config
    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
        if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE:-}" == "/etc/tx5dr/config.env" ]]; then
            log_info "Removing legacy LiveKit credential overrides from /etc/tx5dr/config.env"
            remove_config_env_livekit_overrides
            load_config
        else
            log_error "Cannot rotate managed LiveKit credentials while environment override is active (${LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE:-environment})."
            return 1
        fi
    fi
    if ! write_livekit_credentials_file; then
        log_error "Failed to generate LiveKit credentials."
        return 1
    fi
    if ! fix_livekit_config; then
        log_error "Failed to regenerate LiveKit config."
        return 1
    fi

    systemctl daemon-reload 2>/dev/null || true
    systemctl restart tx5dr-livekit
    systemctl restart tx5dr

    echo -n "  "
    if wait_for_port "${LIVEKIT_SIGNAL_PORT}" 15; then
        log_ok "$(msg PORT_READY "${LIVEKIT_SIGNAL_PORT}") (livekit)"
    else
        log_fail "$(msg PORT_FAIL "${LIVEKIT_SIGNAL_PORT}" "15")"
        return 1
    fi

    echo -n "  "
    if wait_for_port "${API_PORT}" 15; then
        log_ok "$(msg PORT_READY "${API_PORT}") (backend)"
    else
        log_fail "$(msg PORT_FAIL "${API_PORT}" "15")"
        return 1
    fi

    log_info "LiveKit credentials rotated."
    log_info "Credential file: $(get_livekit_credentials_path)"
}

cmd_ssl_help() {
    echo "Usage: tx5dr ssl [status|renew]"
    echo ""
    echo "  status   Show SSL certificate status (default)"
    echo "  renew    Regenerate self-signed certificate (365 days)"
    echo ""
    echo "To use your own certificate:"
    echo "  1. Replace /etc/tx5dr/ssl/server.crt and server.key"
    echo "  2. Update TX5DR_SSL_MODE=custom in /etc/tx5dr/ssl/cert-info.env"
    echo "  3. Run: sudo systemctl reload nginx"
}

cmd_ssl_status() {
    load_config
    echo ""
    echo -e "${_BOLD}SSL Certificate Status${_NC}"
    echo "─────────────────────────────────────"

    local ssl_dir="${SSL_DIR:-/etc/tx5dr/ssl}"
    if [[ ! -f "$ssl_dir/server.crt" ]] || [[ ! -f "$ssl_dir/server.key" ]]; then
        echo -e "  Status:     ${_RED}not configured${_NC}"
        echo -e "  ${_DIM}Run: sudo tx5dr doctor --fix${_NC}"
        echo ""
        return
    fi

    local mode="unknown"
    [[ -f "$ssl_dir/cert-info.env" ]] && mode=$(grep "TX5DR_SSL_MODE=" "$ssl_dir/cert-info.env" 2>/dev/null | cut -d= -f2 || true)
    echo -e "  Mode:       ${mode}"
    echo -e "  Cert:       $ssl_dir/server.crt"
    echo -e "  Key:        $ssl_dir/server.key"

    # Certificate details
    local subject valid_from valid_to fingerprint san_display
    subject=$(openssl x509 -subject -noout -in "$ssl_dir/server.crt" 2>/dev/null | sed 's/^subject=//' || true)
    valid_from=$(openssl x509 -startdate -noout -in "$ssl_dir/server.crt" 2>/dev/null | cut -d= -f2 || true)
    valid_to=$(openssl x509 -enddate -noout -in "$ssl_dir/server.crt" 2>/dev/null | cut -d= -f2 || true)
    fingerprint=$(openssl x509 -fingerprint -sha256 -noout -in "$ssl_dir/server.crt" 2>/dev/null | cut -d= -f2 || true)
    san_display=$(openssl x509 -ext subjectAltName -noout -in "$ssl_dir/server.crt" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' || true)

    echo -e "  Subject:    ${subject}"
    echo -e "  Valid:      ${valid_from} → ${valid_to}"
    [[ -n "$fingerprint" ]] && echo -e "  SHA-256:    ${fingerprint}"
    [[ -n "$san_display" ]] && echo -e "  SAN:        ${san_display}"

    if check_ssl_cert_validity; then
        echo -e "  Validity:   ${_GREEN}valid${_NC}"
    else
        echo -e "  Validity:   ${_RED}expired or expiring soon${_NC}"
    fi

    if check_nginx_ssl_block; then
        echo -e "  nginx:      ${_GREEN}HTTPS block present (port ${HTTPS_PORT:-8443})${_NC}"
    else
        echo -e "  nginx:      ${_YELLOW}HTTPS block missing${_NC}"
    fi

    echo ""
    if [[ "$mode" == "self-signed" ]]; then
        echo -e "  ${_DIM}$(msg SSL_BROWSER_WARNING)${_NC}"
        echo ""
        echo -e "  ${_DIM}$(msg SSL_REPLACE_HINT)${_NC}"
    fi
    echo ""
}

cmd_ssl_renew_internal() {
    require_root
    load_config

    if ! check_ssl_cert_is_self_signed && check_ssl_cert_files; then
        log_error "Cannot renew: certificate is not self-signed (mode is custom)."
        log_info "Replace /etc/tx5dr/ssl/server.crt and server.key manually."
        return 1
    fi

    log_info "$(msg SSL_GENERATING)"
    if generate_self_signed_cert; then
        log_ok "$(msg SSL_RENEWED)"
        systemctl reload nginx 2>/dev/null || true
    else
        log_error "Failed to generate certificate."
        return 1
    fi
}

cmd_ssl() {
    local action="${1:-status}"
    case "$action" in
        status)
            cmd_ssl_status
            ;;
        renew)
            if [[ $EUID -ne 0 ]]; then
                exec sudo "$0" __ssl_renew
            fi
            "$0" __ssl_renew
            ;;
        --help|-h|help)
            cmd_ssl_help
            ;;
        *)
            log_error "Unknown ssl action: $action"
            cmd_ssl_help
            return 1
            ;;
    esac
}

cmd_logs() {
    case "${1:-}" in
        --nginx)
            sudo tail -f /var/log/nginx/error.log
            ;;
        --all)
            sudo journalctl -u tx5dr -u tx5dr-livekit -u nginx -f
            ;;
        *)
            journalctl -u tx5dr -f
            ;;
    esac
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
    echo "  livekit-creds     Show or rotate managed LiveKit credentials"
    echo "  enable-livekit    Install and enable LiveKit (optional)"
    echo "  disable-livekit   Disable LiveKit (switch to ws-compat mode)"
    echo "  enable   Enable auto-start on boot"
    echo "  disable  Disable auto-start on boot"
    echo "  version  Show version"
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "${1:-help}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    token)   cmd_token "${2:-}" ;;
    update)  cmd_update ;;
    doctor)  cmd_doctor "${2:-}" ;;
    ssl)     cmd_ssl "${2:-}" ;;
    livekit-creds) cmd_livekit_creds "${2:-}" ;;
    logs)    cmd_logs "${2:-}" ;;
    __doctor_fix) cmd_doctor_fix_internal ;;
    __ssl_renew) cmd_ssl_renew_internal ;;
    __rotate_livekit_creds) cmd_livekit_creds_rotate_internal ;;
    enable)
        sudo systemctl enable tx5dr
        log_ok "TX-5DR enabled for auto-start on boot."
        ;;
    disable)
        sudo systemctl disable tx5dr
        log_ok "TX-5DR disabled from auto-start."
        ;;
    version)
        if [[ -f /usr/share/tx5dr/version ]]; then
            cat /usr/share/tx5dr/version
        else
            echo "TX-5DR (version unknown)"
        fi
        ;;
    enable-livekit)
        require_root
        load_config
        log_info "Installing and enabling LiveKit..."
        if ! check_livekit_binary 2>/dev/null; then
            if fix_livekit_binary; then
                log_ok "LiveKit binary installed"
            else
                log_error "Failed to install LiveKit binary"
                exit 1
            fi
        else
            log_ok "LiveKit binary already present"
        fi
        if ! (check_livekit_credentials_exists 2>/dev/null && check_livekit_credentials_loaded 2>/dev/null); then
            if fix_livekit_credentials; then
                log_ok "LiveKit credentials generated"
            else
                log_error "Failed to generate LiveKit credentials"
                exit 1
            fi
        else
            log_ok "LiveKit credentials already present"
        fi
        if ! check_livekit_config 2>/dev/null; then
            if fix_livekit_config; then
                log_ok "LiveKit config generated"
            else
                log_error "Failed to generate LiveKit config"
                exit 1
            fi
        else
            log_ok "LiveKit config already present"
        fi
        systemctl daemon-reload
        systemctl enable --now tx5dr-livekit 2>/dev/null || true
        systemctl restart tx5dr 2>/dev/null || true
        echo ""
        if wait_for_port "${LIVEKIT_SIGNAL_PORT:-7880}" 10 2>/dev/null; then
            log_ok "LiveKit enabled and running on port ${LIVEKIT_SIGNAL_PORT:-7880}"
        else
            log_warn "LiveKit service started but port ${LIVEKIT_SIGNAL_PORT:-7880} not yet ready"
        fi
        log_ok "TX-5DR restarted with LiveKit support"
        ;;
    disable-livekit)
        require_root
        log_info "Disabling LiveKit..."
        systemctl disable --now tx5dr-livekit 2>/dev/null || true
        systemctl restart tx5dr 2>/dev/null || true
        log_ok "LiveKit disabled. TX-5DR will use ws-compat mode."
        ;;
    help|--help|-h|*)
        cmd_help
        ;;
esac
