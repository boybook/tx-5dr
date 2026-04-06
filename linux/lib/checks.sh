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
    # Find libstdc++.so.6 via ldconfig cache (works on any distro/arch),
    # then fall back to well-known paths if ldconfig is unavailable.
    local libpath=""
    if command -v ldconfig &>/dev/null; then
        libpath=$(ldconfig -p 2>/dev/null | grep 'libstdc++\.so\.6\b' | awk '{print $NF}' | head -1)
    fi
    if [[ -z "$libpath" ]]; then
        for p in /usr/lib/x86_64-linux-gnu/libstdc++.so.6 \
                 /usr/lib/aarch64-linux-gnu/libstdc++.so.6 \
                 /usr/lib64/libstdc++.so.6 \
                 /usr/lib/libstdc++.so.6; do
            [[ -f "$p" ]] && libpath="$p" && break
        done
    fi
    [[ -z "$libpath" ]] && return 1

    # Use grep -a (text mode) directly on the binary to avoid SIGPIPE under pipefail:
    # strings ... | grep -q exits grep early, causing strings to get SIGPIPE (141),
    # which pipefail would treat as failure even when the string is actually found.
    grep -qa "GLIBCXX_3.4.32" "$libpath" 2>/dev/null
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

get_tx5dr_nginx_conf_path() {
    printf "%s" "/etc/nginx/conf.d/tx5dr.conf"
}

check_nginx_realtime_proxy_config() {
    local conf
    conf=$(get_tx5dr_nginx_conf_path)
    [[ -f "$conf" ]] || return 1

    local content
    content=$(read_file_maybe_sudo "$conf" 2>/dev/null || true)
    [[ -n "$content" ]] || return 1

    local api_block_count compat_block_count livekit_block_count
    api_block_count=$(printf "%s\n" "$content" | grep -c 'location /api/ {')
    compat_block_count=$(printf "%s\n" "$content" | grep -c 'location /api/realtime/ws-compat {')
    livekit_block_count=$(printf "%s\n" "$content" | grep -c 'location /livekit/ {')
    [[ "$api_block_count" -gt 0 ]] || return 1
    [[ "$compat_block_count" -ge "$api_block_count" ]] || return 1
    [[ "$livekit_block_count" -ge "$api_block_count" ]] || return 1

    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Upgrade $http_upgrade;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Connection $connection_upgrade;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Host $http_host;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header X-Forwarded-Host $http_host;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header X-Forwarded-Port $server_port;' || return 1
}

check_tx5dr_service() {
    systemctl is-active --quiet tx5dr 2>/dev/null
}

check_livekit_service() {
    systemctl is-active --quiet tx5dr-livekit 2>/dev/null
}

check_livekit_binary() {
    get_livekit_binary_path >/dev/null 2>&1
}

check_livekit_credentials_exists() {
    [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]] && return 0
    [[ -f "$(get_livekit_credentials_path)" ]]
}

check_livekit_credentials_loaded() {
    [[ -n "${LIVEKIT_API_KEY:-}" && -n "${LIVEKIT_API_SECRET:-}" ]]
}

get_livekit_credential_timestamp() {
    local key="$1"
    local file
    file=$(get_livekit_credentials_path)
    if [[ ! -f "$file" ]]; then
        return 1
    fi
    grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-
}

check_livekit_config_exists() {
    [[ -f "$(get_livekit_config_path)" ]]
}

get_livekit_config_contents() {
    local file
    file=$(get_livekit_config_path)
    read_file_maybe_sudo "$file"
}

_escape_regex() {
    printf '%s' "$1" | sed 's/[][(){}.^$*+?|\/-]/\\&/g'
}

check_livekit_config_consistency() {
    local content
    content=$(get_livekit_config_contents) || return 1
    check_livekit_credentials_loaded || return 1

    local quoted_api_key
    local quoted_api_secret
    local plain_api_key
    local plain_api_secret
    quoted_api_key=$(yaml_single_quote "${LIVEKIT_API_KEY}")
    quoted_api_secret=$(yaml_single_quote "${LIVEKIT_API_SECRET}")
    plain_api_key="${LIVEKIT_API_KEY}"
    plain_api_secret="${LIVEKIT_API_SECRET}"

    echo "$content" | grep -Eq "^port:[[:space:]]*${LIVEKIT_SIGNAL_PORT}[[:space:]]*$" || return 1
    echo "$content" | grep -Eq "^[[:space:]]+tcp_port:[[:space:]]*${LIVEKIT_TCP_PORT}[[:space:]]*$" || return 1
    echo "$content" | grep -Eq "^[[:space:]]+port_range_start:[[:space:]]*${LIVEKIT_UDP_PORT_START}[[:space:]]*$" || return 1
    echo "$content" | grep -Eq "^[[:space:]]+port_range_end:[[:space:]]*${LIVEKIT_UDP_PORT_END}[[:space:]]*$" || return 1

    if printf "%s\n" "$content" | grep -Fqx "  ${quoted_api_key}: ${quoted_api_secret}"; then
        return 0
    fi
    if printf "%s\n" "$content" | grep -Fqx "  ${plain_api_key}: ${plain_api_secret}"; then
        return 0
    fi

    return 1
}

check_livekit_config() {
    check_livekit_config_exists && check_livekit_config_consistency
}

check_livekit_url_consistency() {
    local url_port
    url_port=$(get_url_port "${LIVEKIT_URL}")
    [[ "$url_port" == "${LIVEKIT_SIGNAL_PORT}" ]]
}

check_livekit_tcp_port() {
    is_port_open "${LIVEKIT_TCP_PORT}"
}

describe_livekit_udp_binding() {
    local ports
    ports=$(list_udp_ports_in_range "${LIVEKIT_UDP_PORT_START}" "${LIVEKIT_UDP_PORT_END}" | paste -sd ',' -)
    if [[ -n "$ports" ]]; then
        printf "bound: %s" "$ports"
    else
        printf "idle (no active UDP allocations observed)"
    fi
}

describe_livekit_credentials_state() {
    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
        printf "environment override (%s)" "${LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE:-environment}"
        return 0
    fi
    if ! check_livekit_credentials_exists; then
        printf "missing"
        return 0
    fi
    if ! check_livekit_credentials_loaded; then
        printf "invalid"
        return 0
    fi

    local rotated_at
    rotated_at=$(get_livekit_credential_timestamp "LIVEKIT_CREDENTIALS_ROTATED_AT" 2>/dev/null || true)
    if [[ -n "$rotated_at" ]]; then
        printf "managed (%s)" "$rotated_at"
        return 0
    fi

    printf "managed"
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
find_nginx_ssl_config_files() {
    local path
    for path in /etc/nginx/conf.d/*.conf /etc/nginx/default.d/*.conf /etc/nginx/nginx.conf; do
        [[ -f "$path" ]] && printf "%s\n" "$path"
    done
}

check_ssl() {
    SSL_PORT=""
    local conf content port
    while IFS= read -r conf; do
        content=$(read_file_maybe_sudo "$conf" 2>/dev/null || true)
        [[ -n "$content" ]] || continue
        printf "%s\n" "$content" | grep -Eq '^[[:space:]]*ssl_certificate([[:space:]]|_)' || continue

        port=$(printf "%s\n" "$content" | awk '
            /^[[:space:]]*listen[[:space:]]+/ && /ssl/ {
                for (i = 1; i <= NF; i++) {
                    token = $i
                    gsub(/;/, "", token)
                    if (token ~ /^\[.*\]:[0-9]+$/) {
                        sub(/^.*:/, "", token)
                        print token
                        exit
                    }
                    if (token ~ /^[0-9]+$/) {
                        print token
                        exit
                    }
                }
            }
        ' | head -1 || true)
        if [[ -n "$port" ]]; then
            SSL_PORT="$port"
        else
            SSL_PORT="configured"
        fi
        return 0
    done < <(find_nginx_ssl_config_files)

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
            # Install/upgrade the libstdc++ runtime library only (not the full compiler)
            dnf install -y libstdc++ 2>&1 || yum install -y libstdc++ 2>&1 || true
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

fix_nginx_realtime_proxy_config() {
    local conf
    conf=$(get_tx5dr_nginx_conf_path)
    [[ -f "$conf" ]] || return 1

    local tmp_file
    tmp_file=$(mktemp)

    awk -v api_port="${API_PORT}" -v livekit_host="127.0.0.1:${LIVEKIT_SIGNAL_PORT}" '
        function flush_pending_xff() {
            if (pending_xff == "") {
                return;
            }

            print pending_xff;
            if (!has_forwarded_host_after_xff) {
                print pending_indent "proxy_set_header X-Forwarded-Host $http_host;";
            }
            if (!has_forwarded_port_after_xff) {
                print pending_indent "proxy_set_header X-Forwarded-Port $server_port;";
            }

            pending_xff = "";
            pending_indent = "";
            has_forwarded_host_after_xff = 0;
            has_forwarded_port_after_xff = 0;
        }

        function print_compat_block(block_indent, inner_indent) {
            print block_indent "location /api/realtime/ws-compat {";
            print inner_indent "proxy_pass http://127.0.0.1:" api_port ";";
            print inner_indent "proxy_http_version 1.1;";
            print inner_indent "proxy_set_header Upgrade $http_upgrade;";
            print inner_indent "proxy_set_header Connection $connection_upgrade;";
            print inner_indent "proxy_set_header Host $http_host;";
            print inner_indent "proxy_set_header X-Real-IP $remote_addr;";
            print inner_indent "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;";
            print inner_indent "proxy_set_header X-Forwarded-Host $http_host;";
            print inner_indent "proxy_set_header X-Forwarded-Port $server_port;";
            print inner_indent "proxy_set_header X-Forwarded-Proto $scheme;";
            print "";
            print inner_indent "proxy_connect_timeout 7d;";
            print inner_indent "proxy_send_timeout 7d;";
            print inner_indent "proxy_read_timeout 7d;";
            print block_indent "}";
        }

        function print_livekit_block(block_indent, inner_indent) {
            print block_indent "location /livekit/ {";
            print inner_indent "proxy_pass http://" livekit_host "/;";
            print inner_indent "proxy_http_version 1.1;";
            print inner_indent "proxy_set_header Upgrade $http_upgrade;";
            print inner_indent "proxy_set_header Connection $connection_upgrade;";
            print inner_indent "proxy_set_header Host $http_host;";
            print inner_indent "proxy_set_header X-Real-IP $remote_addr;";
            print inner_indent "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;";
            print inner_indent "proxy_set_header X-Forwarded-Host $http_host;";
            print inner_indent "proxy_set_header X-Forwarded-Port $server_port;";
            print inner_indent "proxy_set_header X-Forwarded-Proto $scheme;";
            print "";
            print inner_indent "proxy_connect_timeout 7d;";
            print inner_indent "proxy_send_timeout 7d;";
            print inner_indent "proxy_read_timeout 7d;";
            print block_indent "}";
        }

        function brace_delta(line, opens, closes, temp) {
            temp = line;
            opens = gsub(/\{/, "{", temp);
            temp = line;
            closes = gsub(/\}/, "}", temp);
            return opens - closes;
        }

        {
            line = $0;
            delta = brace_delta(line);

            if (line ~ /^[[:space:]]*server[[:space:]]*\{[[:space:]]*$/) {
                in_server = 1;
                server_depth = delta;
                has_compat_block = 0;
                has_livekit_block = 0;
                realtime_blocks_inserted = 0;
            }

            gsub(/proxy_set_header Host \$host;/, "proxy_set_header Host $http_host;", line);

            if (in_server && line ~ /^[[:space:]]*location \/api\/realtime\/ws-compat[[:space:]]*\{/) {
                has_compat_block = 1;
            }
            if (in_server && line ~ /^[[:space:]]*location \/livekit\/[[:space:]]*\{/) {
                has_livekit_block = 1;
            }

            if (pending_xff != "") {
                if (line ~ /^[[:space:]]*proxy_set_header X-Forwarded-Host \$http_host;/) {
                    has_forwarded_host_after_xff = 1;
                    server_depth += delta;
                    if (in_server && server_depth == 0) {
                        flush_pending_xff();
                        in_server = 0;
                        has_compat_block = 0;
                        has_livekit_block = 0;
                        realtime_blocks_inserted = 0;
                    }
                    next;
                }
                if (line ~ /^[[:space:]]*proxy_set_header X-Forwarded-Port \$server_port;/) {
                    has_forwarded_port_after_xff = 1;
                    server_depth += delta;
                    if (in_server && server_depth == 0) {
                        flush_pending_xff();
                        in_server = 0;
                        has_compat_block = 0;
                        has_livekit_block = 0;
                        realtime_blocks_inserted = 0;
                    }
                    next;
                }
                flush_pending_xff();
            }

            if (in_server && !realtime_blocks_inserted && line ~ /^[[:space:]]*location \/api\/ \{/) {
                match(line, /^[[:space:]]*/);
                block_indent = substr(line, RSTART, RLENGTH);
                inner_indent = block_indent "    ";
                if (!has_compat_block) {
                    print_compat_block(block_indent, inner_indent);
                    print "";
                }
                if (!has_livekit_block) {
                    print_livekit_block(block_indent, inner_indent);
                    print "";
                }
                realtime_blocks_inserted = 1;
            }

            if (line ~ /^[[:space:]]*proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/) {
                pending_xff = line;
                match(line, /^[[:space:]]*/);
                pending_indent = substr(line, RSTART, RLENGTH);
                server_depth += delta;
                if (in_server && server_depth == 0) {
                    flush_pending_xff();
                    in_server = 0;
                    has_compat_block = 0;
                    has_livekit_block = 0;
                    realtime_blocks_inserted = 0;
                }
                next;
            }

            print line;
            server_depth += delta;

            if (in_server && server_depth == 0) {
                in_server = 0;
                has_compat_block = 0;
                has_livekit_block = 0;
                realtime_blocks_inserted = 0;
            }
        }

        END {
            flush_pending_xff();
        }
    ' "$conf" > "$tmp_file"

    cat "$tmp_file" > "$conf"
    rm -f "$tmp_file"

    if check_nginx_config; then
        systemctl reload nginx 2>/dev/null || true
    fi

    check_nginx_realtime_proxy_config
}

fix_livekit_binary() {
    log_info "Installing LiveKit server"
    curl -sSL https://get.livekit.io | bash 2>&1 || true
    check_livekit_binary
}

random_hex() {
    local bytes="${1:-16}"
    od -An -N"${bytes}" -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}

write_livekit_credentials_file() {
    local target
    target=$(get_livekit_credentials_path)
    local now created_at
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    created_at="$now"

    if [[ -f "$target" ]]; then
        created_at=$(get_livekit_credential_timestamp "LIVEKIT_CREDENTIALS_CREATED_AT" 2>/dev/null || true)
        [[ -n "$created_at" ]] || created_at="$now"
    fi

    mkdir -p "$(dirname "$target")"
    cat > "$target" <<EOF
# Managed by TX-5DR. Rotate via tx5dr livekit-creds rotate.
LIVEKIT_API_KEY=tx5dr-$(random_hex 8)
LIVEKIT_API_SECRET=$(random_hex 24)
LIVEKIT_CREDENTIALS_CREATED_AT=${created_at}
LIVEKIT_CREDENTIALS_ROTATED_AT=${now}
EOF

    chmod 640 "$target"
    if id tx5dr &>/dev/null; then
        chown tx5dr:tx5dr "$target" 2>/dev/null || true
    fi

    load_config
    check_livekit_credentials_loaded
}

fix_livekit_credentials() {
    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
        return 0
    fi
    if check_livekit_credentials_loaded && check_livekit_credentials_exists; then
        return 0
    fi
    write_livekit_credentials_file
}

fix_livekit_config() {
    local template="/usr/share/tx5dr/livekit.yaml.template"
    local target
    target=$(get_livekit_config_path)

    [[ -f "$template" ]] || return 1
    check_livekit_credentials_loaded || return 1
    mkdir -p "$(dirname "$target")"

    local quoted_api_key
    local quoted_api_secret
    quoted_api_key=$(escape_sed_replacement "$(yaml_single_quote "${LIVEKIT_API_KEY}")")
    quoted_api_secret=$(escape_sed_replacement "$(yaml_single_quote "${LIVEKIT_API_SECRET}")")

    sed -e "s|__LIVEKIT_SIGNAL_PORT__|${LIVEKIT_SIGNAL_PORT}|g" \
        -e "s|__LIVEKIT_TCP_PORT__|${LIVEKIT_TCP_PORT}|g" \
        -e "s|__LIVEKIT_UDP_PORT_START__|${LIVEKIT_UDP_PORT_START}|g" \
        -e "s|__LIVEKIT_UDP_PORT_END__|${LIVEKIT_UDP_PORT_END}|g" \
        -e "s|__LIVEKIT_API_KEY__|${quoted_api_key}|g" \
        -e "s|__LIVEKIT_API_SECRET__|${quoted_api_secret}|g" \
        "$template" > "$target"

    chmod 640 "$target"
    if id tx5dr &>/dev/null; then
        chown tx5dr:tx5dr "$target" 2>/dev/null || true
    fi

    check_livekit_config
}

fix_tx5dr_user_groups() {
    if id tx5dr &>/dev/null; then
        usermod -a -G audio,dialout tx5dr 2>/dev/null || true
    fi
}

# Returns 0 if SELinux nginx config is OK (or SELinux not enforcing)
check_selinux_nginx() {
    command -v getenforce &>/dev/null || return 0
    [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]] || return 0
    local http_port="${1:-${HTTP_PORT:-8076}}"

    # Check httpd_can_network_connect boolean
    if command -v getsebool &>/dev/null; then
        getsebool httpd_can_network_connect 2>/dev/null | grep -q "on$" || return 1
    fi

    # Check port is allowed in http_port_t
    if command -v semanage &>/dev/null; then
        semanage port -l 2>/dev/null | grep -w http_port_t | grep -qw "$http_port" || return 1
    fi

    return 0
}

fix_selinux_nginx() {
    local http_port="${1:-${HTTP_PORT:-8076}}"

    # Not needed on non-SELinux or non-enforcing systems
    command -v getenforce &>/dev/null || return 0
    [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]] || return 0

    # Ensure semanage is available
    if ! command -v semanage &>/dev/null; then
        dnf install -y policycoreutils-python-utils >/dev/null 2>&1 || true
    fi

    # Add port to SELinux http_port_t (use -m to modify if already assigned)
    if command -v semanage &>/dev/null; then
        if ! semanage port -l 2>/dev/null | grep -w http_port_t | grep -qw "$http_port"; then
            semanage port -a -t http_port_t -p tcp "$http_port" 2>/dev/null || \
            semanage port -m -t http_port_t -p tcp "$http_port" 2>/dev/null || true
        fi
    fi

    # Allow nginx to proxy to backend
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true

    check_selinux_nginx "$http_port"
}

# ── Composite: run all doctor checks ─────────────────────────────────────────

run_doctor() {
    load_config
    local issues=0
    local livekit_diag_needed=0

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

        if check_nginx_realtime_proxy_config; then
            check_line "$(msg CHECK_NGINX_REALTIME_PROXY)" "ok" "ws-compat + forwarded host/port"
        else
            check_line "$(msg CHECK_NGINX_REALTIME_PROXY)" "fail" "missing ws-compat upgrade or forwarded port preservation"
            echo -e "      ${_DIM}$(msg FIX_NGINX_REALTIME_PROXY)${_NC}"
            issues=$((issues + 1))
        fi
    fi

    # SELinux nginx (RHEL/Fedora only — skip silently if not enforcing)
    if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        if check_selinux_nginx "${HTTP_PORT}"; then
            check_line "SELinux nginx" "ok" "port ${HTTP_PORT} allowed, proxy enabled"
        else
            check_line "SELinux nginx" "fail" "port blocked or proxy disabled"
            echo -e "      ${_DIM}sudo semanage port -a -t http_port_t -p tcp ${HTTP_PORT} && sudo setsebool -P httpd_can_network_connect 1${_NC}"
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

    if check_livekit_binary; then
        check_line "$(msg CHECK_LIVEKIT_BINARY)" "ok" "$(get_livekit_binary_path)"
    else
        check_line "$(msg CHECK_LIVEKIT_BINARY)" "fail" "not found"
        echo -e "      ${_DIM}$(msg FIX_LIVEKIT_BINARY)${_NC}"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" == "1" ]]; then
        check_line "$(msg CHECK_LIVEKIT_CREDENTIAL_FILE)" "ok" "environment override"
    elif check_livekit_credentials_exists; then
        if check_livekit_credentials_loaded; then
            check_line "$(msg CHECK_LIVEKIT_CREDENTIAL_FILE)" "ok" "$(get_livekit_credentials_path)"
        else
            check_line "$(msg CHECK_LIVEKIT_CREDENTIAL_FILE)" "fail" "invalid: $(get_livekit_credentials_path)"
            echo -e "      ${_DIM}$(msg FIX_LIVEKIT_CREDENTIALS)${_NC}"
            issues=$((issues + 1))
            livekit_diag_needed=1
        fi
    else
        check_line "$(msg CHECK_LIVEKIT_CREDENTIAL_FILE)" "fail" "missing: $(get_livekit_credentials_path)"
        echo -e "      ${_DIM}$(msg FIX_LIVEKIT_CREDENTIALS)${_NC}"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    if check_livekit_config_exists; then
        if check_livekit_config_consistency; then
            check_line "$(msg CHECK_LIVEKIT_CONFIG)" "ok" "$(get_livekit_config_path)"
        else
            check_line "$(msg CHECK_LIVEKIT_CONFIG)" "fail" "mismatch with current ports or credential file"
            echo -e "      ${_DIM}$(msg FIX_LIVEKIT_CONFIG)${_NC}"
            issues=$((issues + 1))
            livekit_diag_needed=1
        fi
    else
        check_line "$(msg CHECK_LIVEKIT_CONFIG)" "fail" "missing: $(get_livekit_config_path)"
        echo -e "      ${_DIM}$(msg FIX_LIVEKIT_CONFIG)${_NC}"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    if check_livekit_url_consistency; then
        check_line "$(msg CHECK_LIVEKIT_URL)" "ok" "${LIVEKIT_URL}"
    else
        check_line "$(msg CHECK_LIVEKIT_URL)" "fail" "${LIVEKIT_URL} (expected port ${LIVEKIT_SIGNAL_PORT})"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    if check_livekit_service; then
        check_line "$(msg CHECK_LIVEKIT_SERVICE)" "ok" "$(get_systemd_state tx5dr-livekit)"
    else
        check_line "$(msg CHECK_LIVEKIT_SERVICE)" "fail" "$(get_systemd_state tx5dr-livekit)"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    # Ports
    if is_port_open "${API_PORT}"; then
        check_line "$(msg CHECK_PORT_BACKEND "$API_PORT")" "ok" "open"
    else
        check_line "$(msg CHECK_PORT_BACKEND "$API_PORT")" "fail" "closed"
        issues=$((issues + 1))
    fi

    if is_port_open "${LIVEKIT_SIGNAL_PORT:-7880}"; then
        check_line "$(msg CHECK_LIVEKIT_SIGNAL_PORT "${LIVEKIT_SIGNAL_PORT:-7880}")" "ok" "open"
    else
        check_line "$(msg CHECK_LIVEKIT_SIGNAL_PORT "${LIVEKIT_SIGNAL_PORT:-7880}")" "fail" "closed"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    if check_livekit_tcp_port; then
        check_line "$(msg CHECK_LIVEKIT_TCP_PORT "${LIVEKIT_TCP_PORT}")" "ok" "open"
    else
        check_line "$(msg CHECK_LIVEKIT_TCP_PORT "${LIVEKIT_TCP_PORT}")" "fail" "closed"
        issues=$((issues + 1))
        livekit_diag_needed=1
    fi

    check_line "$(msg CHECK_LIVEKIT_UDP_RANGE "${LIVEKIT_UDP_PORT_START}" "${LIVEKIT_UDP_PORT_END}")" "ok" "$(describe_livekit_udp_binding)"

    local credential_state
    credential_state=$(describe_livekit_credentials_state)
    if [[ "$credential_state" == "missing" || "$credential_state" == "invalid" ]]; then
        check_line "$(msg CHECK_LIVEKIT_CREDENTIALS)" "fail" "$credential_state"
    else
        check_line "$(msg CHECK_LIVEKIT_CREDENTIALS)" "ok" "$credential_state"
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

    if [[ $livekit_diag_needed -eq 1 ]]; then
        echo ""
        log_warn "LiveKit diagnostics"
        echo -e "      ${_DIM}Config: $(get_livekit_config_path)${_NC}"
        echo -e "      ${_DIM}Browser entry: same-origin /livekit${_NC}"
        echo -e "      ${_DIM}Expected ports: internal signaling ${LIVEKIT_SIGNAL_PORT}, tcp ${LIVEKIT_TCP_PORT}, udp ${LIVEKIT_UDP_PORT_START}-${LIVEKIT_UDP_PORT_END}${_NC}"
        echo -e "      ${_DIM}Bridge URL: ${LIVEKIT_URL}${_NC}"
        local recent_logs
        recent_logs=$(sudo journalctl -u tx5dr-livekit -n 8 --no-pager 2>/dev/null || true)
        if [[ -n "$recent_logs" ]]; then
            echo -e "      ${_DIM}Recent tx5dr-livekit logs:${_NC}"
            echo "$recent_logs" | sed 's/^/        /'
        fi
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        log_info "$(msg ALL_CHECKS_PASSED)"
    else
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$issues")"
    fi
    return $issues
}
