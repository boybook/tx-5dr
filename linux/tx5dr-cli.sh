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

    echo ""
    log_info "$(msg START_OK)"
    local web_url
    web_url=$(get_web_url)
    echo -e "  ${_BOLD}Web UI:${_NC} ${web_url}"
    echo -e "  ${_DIM}$(msg OPEN_URL)${_NC}"
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
        srv_status="active"
        local uptime
        uptime=$(systemctl show tx5dr --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
        [[ -n "$uptime" ]] && srv_detail="(since $uptime)"
    fi
    echo -e "  Server:     ${srv_status} ${_DIM}${srv_detail}${_NC}"

    # Nginx
    local ngx_status="inactive"
    systemctl is-active --quiet nginx 2>/dev/null && ngx_status="active"
    echo -e "  Nginx:      ${ngx_status}"

    # Ports
    local be_status="closed"
    is_port_open "${API_PORT}" && be_status="open"
    echo -e "  Backend:    port ${API_PORT} ${be_status}"

    local http_status="closed"
    is_port_open "${HTTP_PORT}" && http_status="open"
    local ip
    ip=$(get_local_ip)
    echo -e "  Web UI:     port ${HTTP_PORT} ${http_status} → http://${ip:-localhost}:${HTTP_PORT}"

    # Node.js
    local node_ver="not found"
    command -v node &>/dev/null && node_ver=$(node --version 2>/dev/null)
    echo -e "  Node.js:    ${node_ver}"

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

cmd_doctor() {
    run_doctor
}

cmd_logs() {
    case "${1:-}" in
        --nginx)
            sudo tail -f /var/log/nginx/error.log
            ;;
        --all)
            sudo journalctl -u tx5dr -u nginx -f
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
    echo "  doctor   Run full environment diagnostics"
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
    doctor)  cmd_doctor ;;
    logs)    cmd_logs "${2:-}" ;;
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
    help|--help|-h|*)
        cmd_help
        ;;
esac
