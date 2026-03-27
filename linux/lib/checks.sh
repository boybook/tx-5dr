#!/bin/bash
# TX-5DR environment checks and auto-fix functions
# Requires: source lib/common.sh first

# ── Check functions (return 0=pass, 1=fail) ──────────────────────────────────

check_nodejs() {
    if ! command -v node &>/dev/null; then
        return 1
    fi
    local ver
    ver=$(node --version 2>/dev/null | sed 's/^v//')
    local major
    major=$(echo "$ver" | cut -d. -f1)
    [[ -n "$major" && "$major" -ge 20 ]] && return 0
    return 1
}

check_glibcxx() {
    # Find libstdc++.so.6 and check for GLIBCXX_3.4.32
    local libpath=""
    for p in /usr/lib/x86_64-linux-gnu/libstdc++.so.6 \
             /usr/lib/aarch64-linux-gnu/libstdc++.so.6 \
             /usr/lib64/libstdc++.so.6 \
             /usr/lib/libstdc++.so.6; do
        [[ -f "$p" ]] && libpath="$p" && break
    done
    [[ -z "$libpath" ]] && return 1

    if command -v strings &>/dev/null; then
        strings "$libpath" 2>/dev/null | grep -q "GLIBCXX_3.4.32"
    else
        grep -q "GLIBCXX_3.4.32" "$libpath" 2>/dev/null
    fi
}

check_glibc_execstack() {
    # Only relevant if glibc >= 2.41
    local glibc_int
    glibc_int=$(get_glibc_version_int)
    [[ "$glibc_int" -lt 241 ]] && return 0  # Not needed

    # Check if systemd service has GLIBC_TUNABLES
    if [[ -f /lib/systemd/system/tx5dr.service ]]; then
        grep -q "GLIBC_TUNABLES=glibc.rtld.execstack=2" /lib/systemd/system/tx5dr.service && return 0
    fi
    return 1
}

NGINX_BIN=""
_find_nginx() {
    if [[ -n "$NGINX_BIN" ]]; then return; fi
    NGINX_BIN=$(command -v nginx 2>/dev/null || true)
    [[ -z "$NGINX_BIN" && -x /usr/sbin/nginx ]] && NGINX_BIN=/usr/sbin/nginx
}

check_nginx_installed() {
    _find_nginx
    [[ -n "$NGINX_BIN" ]]
}

check_nginx_config() {
    _find_nginx
    # nginx -t requires root on most systems
    if [[ $EUID -eq 0 ]]; then
        $NGINX_BIN -t 2>/dev/null
    else
        sudo $NGINX_BIN -t 2>/dev/null
    fi
}

check_nginx_running() {
    systemctl is-active --quiet nginx 2>/dev/null
}

check_nginx() {
    check_nginx_installed && check_nginx_config && check_nginx_running
}

check_tx5dr_service() {
    systemctl is-active --quiet tx5dr 2>/dev/null
}

check_ports() {
    local api_port="${API_PORT:-4000}"
    local http_port="${HTTP_PORT:-8076}"
    is_port_open "$api_port" && is_port_open "$http_port"
}

check_tx5dr_user() {
    id tx5dr &>/dev/null || return 1
    # Check audio and dialout group membership
    local groups
    groups=$(id -nG tx5dr 2>/dev/null)
    echo "$groups" | grep -qw "audio" || return 1
    echo "$groups" | grep -qw "dialout" || return 1
    return 0
}

# Returns 0 if SSL is configured, 1 if not. Sets SSL_PORT if found.
check_ssl() {
    SSL_PORT=""
    local conf="/etc/nginx/conf.d/tx5dr.conf"
    if [[ -f "$conf" ]] && grep -q "ssl_certificate" "$conf" 2>/dev/null; then
        # Extract the ssl listen port
        SSL_PORT=$(grep -oP 'listen\s+\K\d+(?=\s+ssl)' "$conf" 2>/dev/null | head -1)
        [[ -n "$SSL_PORT" ]] && return 0
    fi
    return 1
}

check_disk_space() {
    local dir="${DATA_DIR:-/var/lib/tx5dr}"
    [[ ! -d "$dir" ]] && dir="/"
    local avail_kb
    avail_kb=$(df -k "$dir" 2>/dev/null | tail -1 | awk '{print $4}')
    [[ -n "$avail_kb" && "$avail_kb" -gt 102400 ]]  # > 100MB
}

# ── Fix functions ────────────────────────────────────────────────────────────

fix_nodejs() {
    log_info "$(msg INSTALLING_NODEJS)"
    detect_os
    case "$(os_family)" in
        debian)
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 || true
            apt-get install -y nodejs 2>&1 || true
            ;;
        rhel)
            curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>&1 || true
            dnf install -y nodejs 2>&1 || yum install -y nodejs 2>&1 || true
            ;;
        *)
            log_error "$(msg FIX_NODEJS)"
            return 1
            ;;
    esac
    check_nodejs
}

fix_glibcxx() {
    log_info "$(msg UPGRADING_GLIBCXX)"
    log_warn "$(msg GLIBCXX_WARN)"
    detect_os
    case "$(os_family)" in
        debian)
            case "$OS_ID" in
                debian)
                    echo "deb http://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/trixie-temp.list
                    apt-get update -qq 2>&1 || true
                    apt-get install -y -t trixie libstdc++6 2>&1 || true
                    rm -f /etc/apt/sources.list.d/trixie-temp.list
                    apt-get update -qq 2>&1 || true
                    ;;
                *)
                    # Ubuntu 22.04 may need PPA or manual install
                    # Ubuntu 24.04+ already has GLIBCXX_3.4.32
                    if check_glibcxx; then
                        return 0
                    fi
                    log_warn "$(msg FIX_GLIBCXX)"
                    return 1
                    ;;
            esac
            ;;
        rhel)
            # Fedora/RHEL typically ships a recent enough libstdc++ via system gcc-libs
            dnf install -y gcc-c++ 2>&1 || yum install -y gcc-c++ 2>&1 || true
            ;;
        *)
            log_warn "$(msg FIX_GLIBCXX)"
            return 1
            ;;
    esac
    check_glibcxx
}

fix_nginx() {
    log_info "$(msg INSTALLING_NGINX)"
    detect_os
    case "$(os_family)" in
        debian)
            apt-get install -y nginx 2>&1 || true
            ;;
        rhel)
            dnf install -y nginx 2>&1 || yum install -y nginx 2>&1 || true
            ;;
        *)
            log_error "$(msg FIX_NGINX)"
            return 1
            ;;
    esac
    systemctl enable nginx >/dev/null 2>&1
    systemctl start nginx >/dev/null 2>&1
    check_nginx_installed
}

fix_tx5dr_user_groups() {
    if id tx5dr &>/dev/null; then
        usermod -a -G audio,dialout tx5dr 2>/dev/null || true
    fi
}

# ── Composite: run all doctor checks ─────────────────────────────────────────

run_doctor() {
    load_config
    local issues=0

    echo ""
    echo -e "${_BOLD}TX-5DR $(msg ALL_CHECKS_PASSED | head -c0)Environment Check${_NC}"
    echo "─────────────────────────────────────────"

    # Node.js
    if check_nodejs; then
        check_line "$(msg CHECK_NODEJS)" "ok" "$(node --version 2>/dev/null)"
    else
        check_line "$(msg CHECK_NODEJS)" "fail" "not found or < 20"
        echo -e "      ${_DIM}$(msg FIX_NODEJS)${_NC}"
        issues=$((issues + 1))
    fi

    # GLIBCXX
    if check_glibcxx; then
        check_line "$(msg CHECK_GLIBCXX)" "ok" "found"
    else
        check_line "$(msg CHECK_GLIBCXX)" "fail" "not found"
        echo -e "      ${_DIM}$(msg FIX_GLIBCXX)${_NC}"
        issues=$((issues + 1))
    fi

    # glibc execstack
    local glibc_ver
    glibc_ver=$(ldd --version 2>&1 | grep -oP '\d+\.\d+' | head -1 || true)
    local glibc_int
    glibc_int=$(get_glibc_version_int)
    if [[ "$glibc_int" -ge 241 ]]; then
        if check_glibc_execstack; then
            check_line "$(msg CHECK_GLIBC)" "ok" "${glibc_ver} (GLIBC_TUNABLES configured)"
        else
            check_line "$(msg CHECK_GLIBC)" "fail" "${glibc_ver} (GLIBC_TUNABLES missing)"
            issues=$((issues + 1))
        fi
    else
        check_line "$(msg CHECK_GLIBC)" "ok" "${glibc_ver}"
    fi

    # nginx
    if check_nginx_installed; then
        local nginx_ver
        nginx_ver=$($NGINX_BIN -v 2>&1 | grep -oP '[\d.]+' | head -1 || true)
        check_line "$(msg CHECK_NGINX_INSTALLED)" "ok" "${nginx_ver}"
    else
        check_line "$(msg CHECK_NGINX_INSTALLED)" "fail" "not found"
        echo -e "      ${_DIM}$(msg FIX_NGINX)${_NC}"
        issues=$((issues + 1))
    fi

    if check_nginx_installed; then
        if check_nginx_config; then
            check_line "$(msg CHECK_NGINX_CONFIG)" "ok" ""
        else
            check_line "$(msg CHECK_NGINX_CONFIG)" "fail" "nginx -t failed"
            issues=$((issues + 1))
        fi

        if check_nginx_running; then
            check_line "$(msg CHECK_NGINX_RUNNING)" "ok" "active"
        else
            check_line "$(msg CHECK_NGINX_RUNNING)" "fail" "inactive"
            issues=$((issues + 1))
        fi
    fi

    # TX-5DR service
    if check_tx5dr_service; then
        check_line "$(msg CHECK_SERVICE)" "ok" "active"
    else
        check_line "$(msg CHECK_SERVICE)" "fail" "inactive"
        issues=$((issues + 1))
    fi

    # Ports
    if is_port_open "${API_PORT}"; then
        check_line "$(msg CHECK_PORT_BACKEND "$API_PORT")" "ok" "open"
    else
        check_line "$(msg CHECK_PORT_BACKEND "$API_PORT")" "fail" "closed"
        issues=$((issues + 1))
    fi

    if is_port_open "${HTTP_PORT}"; then
        check_line "$(msg CHECK_PORT_HTTP "$HTTP_PORT")" "ok" "open"
    else
        check_line "$(msg CHECK_PORT_HTTP "$HTTP_PORT")" "fail" "closed"
        issues=$((issues + 1))
    fi

    # User
    if check_tx5dr_user; then
        local groups
        groups=$(id -nG tx5dr 2>/dev/null)
        check_line "$(msg CHECK_USER)" "ok" "groups: $groups"
    else
        if id tx5dr &>/dev/null; then
            check_line "$(msg CHECK_USER)" "fail" "missing audio/dialout group"
        else
            check_line "$(msg CHECK_USER)" "fail" "user not found"
        fi
        issues=$((issues + 1))
    fi

    # Disk space
    if check_disk_space; then
        local free
        free=$(df -h "${DATA_DIR:-/var/lib/tx5dr}" 2>/dev/null | tail -1 | awk '{print $4}')
        check_line "$(msg CHECK_DISK)" "ok" "${free} free"
    else
        check_line "$(msg CHECK_DISK)" "fail" "< 100MB free"
        issues=$((issues + 1))
    fi

    # SSL (warning only, not counted as issue)
    if check_ssl; then
        check_line "$(msg CHECK_SSL)" "ok" "$(printf "$(msg SSL_OK)" "$SSL_PORT")"
    else
        check_line "$(msg CHECK_SSL)" "fail" "$(msg SSL_NOT_CONFIGURED)"
        echo -e "      ${_DIM}$(msg SSL_HINT)${_NC}"
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        log_info "$(msg ALL_CHECKS_PASSED)"
    else
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$issues")"
    fi
    return $issues
}
