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

    local api_block_count compat_block_count rtc_data_block_count
    api_block_count=$(printf "%s\n" "$content" | grep -c 'location /api/ {')
    compat_block_count=$(printf "%s\n" "$content" | grep -c 'location /api/realtime/ws-compat {')
    rtc_data_block_count=$(printf "%s\n" "$content" | grep -c 'location /api/realtime/rtc-data-audio {')
    [[ "$api_block_count" -gt 0 ]] || return 1
    [[ "$compat_block_count" -ge "$api_block_count" ]] || return 1
    [[ "$rtc_data_block_count" -ge "$api_block_count" ]] || return 1

    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Upgrade $http_upgrade;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Connection $connection_upgrade;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header Host $http_host;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header X-Forwarded-Host $http_host;' || return 1
    printf "%s\n" "$content" | grep -Fq 'proxy_set_header X-Forwarded-Port $server_port;' || return 1
}

check_tx5dr_service() {
    systemctl is-active --quiet tx5dr 2>/dev/null
}

check_ports() {
    local api_port="${API_PORT:-4000}"
    local http_port="${HTTP_PORT:-8076}"
    is_port_open "$api_port" && is_port_open "$http_port"
}

check_rtc_data_audio_udp_config() {
    local port="${RTC_DATA_AUDIO_UDP_PORT:-50110}"
    [[ "$port" =~ ^[0-9]+$ ]] && [[ "$port" -ge 1 ]] && [[ "$port" -le 65535 ]]
}

fix_rtc_data_audio_firewall() {
    local port="${RTC_DATA_AUDIO_UDP_PORT:-50110}"
    check_rtc_data_audio_udp_config || return 1
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
        ufw allow "${port}/udp" >/dev/null 2>&1 || true
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd --add-port="${port}/udp" --permanent >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
    fi
    check_rtc_data_audio_udp_config
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

# ── SSL certificate checks ──────────────────────────────────────────────────

# Check if managed SSL certificate files exist
check_ssl_cert_files() {
    local ssl_dir="${SSL_DIR:-/etc/tx5dr/ssl}"
    [[ -f "$ssl_dir/server.crt" ]] && [[ -f "$ssl_dir/server.key" ]]
}

# Check if certificate is valid (not expired and not expiring within 30 days)
check_ssl_cert_validity() {
    local cert="${SSL_DIR:-/etc/tx5dr/ssl}/server.crt"
    [[ -f "$cert" ]] || return 1
    openssl x509 -checkend 2592000 -noout -in "$cert" 2>/dev/null
}

# Check if certificate is self-signed (vs user-provided)
check_ssl_cert_is_self_signed() {
    local info_file="${SSL_DIR:-/etc/tx5dr/ssl}/cert-info.env"
    [[ -f "$info_file" ]] || return 1
    grep -q "TX5DR_SSL_MODE=self-signed" "$info_file" 2>/dev/null
}

# Check if the nginx tx5dr config has an HTTPS server block pointing to our cert
check_nginx_ssl_block() {
    local conf
    conf=$(get_tx5dr_nginx_conf_path)
    [[ -f "$conf" ]] || return 1
    local content
    content=$(read_file_maybe_sudo "$conf" 2>/dev/null || true)
    [[ -n "$content" ]] || return 1
    printf "%s\n" "$content" | grep -q 'ssl_certificate[[:space:]]*/etc/tx5dr/ssl/server\.crt' || return 1
    printf "%s\n" "$content" | grep -q 'ssl_certificate_key[[:space:]]*/etc/tx5dr/ssl/server\.key' || return 1
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
    local template="/usr/share/tx5dr/nginx-site.conf"
    local conf
    conf=$(get_tx5dr_nginx_conf_path)
    [[ -f "$template" ]] || return 1
    mkdir -p "$(dirname "$conf")"
    sed -e "s|%%LISTEN_PORT%%|${HTTP_PORT:-8076}|g" \
        -e "s|%%WEB_ROOT%%|/usr/share/tx5dr/web|g" \
        -e "s|%%API_HOST%%|127.0.0.1:${API_PORT:-4000}|g" \
        "$template" > "$conf"
    if check_nginx_config; then
        systemctl reload nginx 2>/dev/null || true
    fi
    check_nginx_realtime_proxy_config
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

# ── SSL certificate generation and nginx patching ───────────────────────────

# Collect all non-loopback IPv4 addresses
get_all_local_ips() {
    ip -4 addr show scope global 2>/dev/null | \
        awk '/inet / {split($2,a,"/"); print a[1]}' | \
        sort -u
}

# Generate self-signed certificate using openssl
generate_self_signed_cert() {
    local ssl_dir="${SSL_DIR:-/etc/tx5dr/ssl}"
    local cert_file="$ssl_dir/server.crt"
    local key_file="$ssl_dir/server.key"
    local info_file="$ssl_dir/cert-info.env"

    # Don't overwrite if user has their own cert
    if [[ -f "$info_file" ]] && ! grep -q "TX5DR_SSL_MODE=self-signed" "$info_file" 2>/dev/null; then
        return 0
    fi

    command -v openssl &>/dev/null || return 1

    mkdir -p "$ssl_dir"

    local hostname
    hostname=$(hostname 2>/dev/null || echo "localhost")

    # Build SAN string
    local san="DNS:localhost"
    [[ "$hostname" != "localhost" ]] && san="${san},DNS:${hostname}"
    san="${san},IP:127.0.0.1"

    local ip
    while IFS= read -r ip; do
        [[ -n "$ip" && "$ip" != "127.0.0.1" ]] && san="${san},IP:${ip}"
    done < <(get_all_local_ips)

    # Generate key + cert
    openssl genrsa -out "$key_file" 2048 2>/dev/null || return 1
    openssl req -new -x509 -key "$key_file" -out "$cert_file" \
        -days 365 -sha256 \
        -subj "/CN=${hostname}/O=TX-5DR" \
        -addext "subjectAltName=${san}" \
        -addext "basicConstraints=CA:FALSE" \
        -addext "keyUsage=digitalSignature,keyEncipherment" \
        -addext "extendedKeyUsage=serverAuth" \
        2>/dev/null || return 1

    # Set permissions (nginx master reads key as root)
    chmod 644 "$cert_file"
    chmod 640 "$key_file"

    # Write metadata
    local now expires fingerprint
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    expires=$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | cut -d= -f2 || true)
    fingerprint=$(openssl x509 -fingerprint -sha256 -noout -in "$cert_file" 2>/dev/null | cut -d= -f2 || true)

    cat > "$info_file" <<CERTEOF
# Managed by TX-5DR. Replace server.crt and server.key with your own certificate.
# After replacing, update TX5DR_SSL_MODE to "custom" and reload nginx:
#   sudo systemctl reload nginx
TX5DR_SSL_MODE=self-signed
TX5DR_SSL_CREATED_AT=${now}
TX5DR_SSL_EXPIRES=${expires}
TX5DR_SSL_FINGERPRINT_SHA256=${fingerprint}
TX5DR_SSL_HOSTNAME=${hostname}
TX5DR_SSL_SAN=${san}
CERTEOF
    chmod 644 "$info_file"
    return 0
}

# Regenerate self-signed cert (only if it is self-signed)
renew_self_signed_cert() {
    local info_file="${SSL_DIR:-/etc/tx5dr/ssl}/cert-info.env"
    if [[ -f "$info_file" ]] && ! grep -q "TX5DR_SSL_MODE=self-signed" "$info_file" 2>/dev/null; then
        return 0
    fi
    generate_self_signed_cert
}

# Patch nginx config to add HTTPS server block
# Uses awk to extract location blocks from the HTTP server and duplicate them in an HTTPS server block
fix_nginx_ssl_config() {
    local conf
    conf=$(get_tx5dr_nginx_conf_path)
    [[ -f "$conf" ]] || return 1

    local ssl_cert="${SSL_DIR:-/etc/tx5dr/ssl}/server.crt"
    local ssl_key="${SSL_DIR:-/etc/tx5dr/ssl}/server.key"
    [[ -f "$ssl_cert" ]] && [[ -f "$ssl_key" ]] || return 1

    # Already has SSL block?
    if check_nginx_ssl_block; then
        return 0
    fi

    local https_port="${HTTPS_PORT:-8443}"

    # Backup before patching
    cp "$conf" "${conf}.bak.ssl" 2>/dev/null || true

    # Use awk to extract the content inside the first server { } block,
    # then append a new HTTPS server block with the same locations
    local tmp_file
    tmp_file=$(mktemp)

    awk -v https_port="$https_port" -v ssl_cert="$ssl_cert" -v ssl_key="$ssl_key" '
        BEGIN {
            in_server = 0
            depth = 0
            lines_count = 0
        }

        # Track server block
        {
            line = $0

            if (!in_server && line ~ /^server[[:space:]]*\{/ ) {
                in_server = 1
                depth = 1
                next
            }

            if (in_server) {
                # Count braces
                n = length(line)
                for (i = 1; i <= n; i++) {
                    c = substr(line, i, 1)
                    if (c == "{") depth++
                    if (c == "}") depth--
                }

                if (depth <= 0) {
                    # End of server block, skip closing brace
                    in_server = 0
                    next
                }

                # Skip listen and server_name directives (we replace them)
                if (line ~ /^[[:space:]]*listen[[:space:]]/) next
                if (line ~ /^[[:space:]]*server_name[[:space:]]/) next

                # Collect location blocks and other directives
                lines_count++
                server_lines[lines_count] = line
            }
        }

        END {
            # Write the HTTPS server block
            print ""
            print "# TX-5DR HTTPS (auto-generated self-signed certificate)"
            print "# Replace " ssl_cert " and " ssl_key " with your own certificate,"
            print "# then reload nginx: sudo systemctl reload nginx"
            print "server {"
            print "    listen " https_port " ssl;"
            print "    listen [::]:" https_port " ssl;"
            print "    server_name _;"
            print ""
            print "    ssl_certificate " ssl_cert ";"
            print "    ssl_certificate_key " ssl_key ";"
            print ""
            print "    ssl_protocols TLSv1.2 TLSv1.3;"
            print "    ssl_ciphers HIGH:!aNULL:!MD5;"
            print "    ssl_prefer_server_ciphers on;"
            print "    ssl_session_cache shared:SSL:10m;"
            print "    ssl_session_timeout 10m;"
            print ""
            for (i = 1; i <= lines_count; i++) {
                print server_lines[i]
            }
            print "}"
        }
    ' "$conf" > "$tmp_file"

    # Append the HTTPS block to the existing config
    cat "$tmp_file" >> "$conf"
    rm -f "$tmp_file"

    if check_nginx_config; then
        systemctl reload nginx 2>/dev/null || true
        return 0
    else
        # Rollback on failure
        if [[ -f "${conf}.bak.ssl" ]]; then
            cp "${conf}.bak.ssl" "$conf"
            systemctl reload nginx 2>/dev/null || true
        fi
        return 1
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

        if check_nginx_realtime_proxy_config; then
            check_line "$(msg CHECK_NGINX_REALTIME_PROXY)" "ok" "rtc-data-audio + ws-compat + forwarded host/port"
        else
            check_line "$(msg CHECK_NGINX_REALTIME_PROXY)" "fail" "missing realtime upgrade route or forwarded port preservation"
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

    if check_rtc_data_audio_udp_config; then
        check_line "$(msg CHECK_RTC_DATA_AUDIO_UDP "${RTC_DATA_AUDIO_UDP_PORT:-50110}")" "ok" "configured"
    else
        check_line "$(msg CHECK_RTC_DATA_AUDIO_UDP "${RTC_DATA_AUDIO_UDP_PORT:-50110}")" "fail" "invalid"
        echo -e "      ${_DIM}$(msg FIX_RTC_DATA_AUDIO_UDP)${_NC}"
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

    # SSL certificate files
    if check_ssl_cert_files; then
        if check_ssl_cert_is_self_signed; then
            check_line "$(msg CHECK_SSL_CERT)" "ok" "self-signed (${SSL_DIR:-/etc/tx5dr/ssl}/)"
        else
            check_line "$(msg CHECK_SSL_CERT)" "ok" "custom (${SSL_DIR:-/etc/tx5dr/ssl}/)"
        fi
    else
        check_line "$(msg CHECK_SSL_CERT)" "fail" "$(msg SSL_CERT_MISSING)"
        echo -e "      ${_DIM}$(msg FIX_SSL)${_NC}"
        issues=$((issues + 1))
    fi

    # SSL certificate validity (only if files exist)
    if check_ssl_cert_files; then
        if check_ssl_cert_validity; then
            local expiry
            expiry=$(openssl x509 -enddate -noout -in "${SSL_DIR:-/etc/tx5dr/ssl}/server.crt" 2>/dev/null | cut -d= -f2 || true)
            check_line "$(msg CHECK_SSL_VALIDITY)" "ok" "expires: ${expiry}"
        else
            check_line "$(msg CHECK_SSL_VALIDITY)" "fail" "$(msg SSL_EXPIRED)"
            echo -e "      ${_DIM}$(msg FIX_SSL)${_NC}"
            issues=$((issues + 1))
        fi
    fi

    # nginx HTTPS block
    if check_ssl_cert_files; then
        if check_nginx_ssl_block; then
            check_line "$(msg CHECK_SSL_NGINX)" "ok" "present (port ${HTTPS_PORT:-8443})"
        else
            check_line "$(msg CHECK_SSL_NGINX)" "fail" "$(msg SSL_NGINX_MISSING)"
            echo -e "      ${_DIM}$(msg FIX_SSL_NGINX)${_NC}"
            issues=$((issues + 1))
        fi
    fi

    # Overall SSL status
    if check_ssl; then
        check_line "$(msg CHECK_SSL)" "ok" "$(printf "$(msg SSL_OK)" "$SSL_PORT")"
    else
        check_line "$(msg CHECK_SSL)" "fail" "$(msg SSL_NOT_CONFIGURED)"
        echo -e "      ${_DIM}$(msg FIX_SSL)${_NC}"
        issues=$((issues + 1))
    fi


    echo ""
    if [[ $issues -eq 0 ]]; then
        log_info "$(msg ALL_CHECKS_PASSED)"
    else
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$issues")"
    fi
    return $issues
}
