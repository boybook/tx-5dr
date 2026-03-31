#!/bin/bash
# TX-5DR post-install script for deb/rpm packages
# Creates system user, data directories, nginx config, and enables the service.

set -e

# ── Detect language early (before lib is loaded) ─────────────────────────────
_LANG_ID="en"
_lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}"
case "$_lang" in zh_CN*|zh_TW*|zh_HK*|zh.*) _LANG_ID="zh" ;; esac

_msg() {
    local en="$1" zh="$2"
    if [[ "$_LANG_ID" == "zh" ]]; then echo "$zh"; else echo "$en"; fi
}

# ── Config ───────────────────────────────────────────────────────────────────
APP_USER="tx5dr"
APP_GROUP="tx5dr"
DATA_DIR="/var/lib/tx5dr"
NGINX_TEMPLATE="/usr/share/tx5dr/nginx-site.conf"
NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"
CONFIG_ENV="/etc/tx5dr/config.env"
LIVEKIT_TEMPLATE="/usr/share/tx5dr/livekit.yaml.template"
LIVEKIT_CONF="/etc/tx5dr/livekit.yaml"
LIVEKIT_CREDENTIALS_FILE="/etc/tx5dr/livekit-credentials.env"
LIB_DIR="/usr/share/tx5dr/lib"
SHARED_LIB_READY=0

if [[ -f "$CONFIG_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_ENV" 2>/dev/null || true
fi

if [[ -f "$LIB_DIR/common.sh" && -f "$LIB_DIR/checks.sh" ]]; then
    # shellcheck disable=SC1091
    source "$LIB_DIR/common.sh"
    # shellcheck disable=SC1091
    source "$LIB_DIR/checks.sh"
    load_config 2>/dev/null || true
    SHARED_LIB_READY=1
fi

random_hex() {
    local bytes="${1:-16}"
    od -An -N"${bytes}" -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}

LISTEN_PORT="${TX5DR_HTTP_PORT:-8076}"
WEB_ROOT="/usr/share/tx5dr/web"
API_HOST="127.0.0.1:${PORT:-4000}"
POSTINSTALL_ACTION="${1:-}"
POSTINSTALL_PREVIOUS_VERSION="${2:-}"

is_package_upgrade() {
    if [[ "$POSTINSTALL_ACTION" == "configure" && -n "$POSTINSTALL_PREVIOUS_VERSION" ]]; then
        return 0
    fi

    if [[ "$POSTINSTALL_ACTION" =~ ^[0-9]+$ ]] && [[ "$POSTINSTALL_ACTION" -gt 1 ]]; then
        return 0
    fi

    return 1
}

# ── Create system user ──────────────────────────────────────────────────────
if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    groupadd --system "$APP_GROUP"
    _msg "Created group: $APP_GROUP" "已创建用户组: $APP_GROUP"
fi

if ! getent passwd "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
    _msg "Created user: $APP_USER" "已创建用户: $APP_USER"
fi

# audio (sound devices) + dialout (serial ports /dev/ttyS*, /dev/ttyUSB*)
usermod -a -G audio,dialout "$APP_USER" 2>/dev/null || true

# ── Create data directories ─────────────────────────────────────────────────
for dir in "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/logs" "$DATA_DIR/cache"; do
    mkdir -p "$dir"
    chown "$APP_USER:$APP_GROUP" "$dir"
    chmod 755 "$dir"
done

# ── Nginx config ────────────────────────────────────────────────────────────
if [[ -f "$NGINX_TEMPLATE" ]]; then
    if [[ -f "$NGINX_CONF" ]]; then
        echo ""
        echo "  ✓ $(_msg \
            "Nginx config preserved (not overwritten)" \
            "Nginx 配置已保留（未覆盖）")"
        echo "    $(_msg "File:" "文件:") $NGINX_CONF"
        echo "    $(_msg \
            "Your SSL, custom ports, and other changes are safe." \
            "您的 SSL、自定义端口等修改已保留。")"
        echo "    $(_msg \
            "To reset to default: sudo rm $NGINX_CONF && tx5dr doctor" \
            "如需恢复默认: sudo rm $NGINX_CONF && tx5dr doctor")"
        echo ""

        if [[ "$SHARED_LIB_READY" == "1" ]] && ! check_nginx_realtime_proxy_config; then
            if fix_nginx_realtime_proxy_config; then
                _msg "Patched preserved nginx config with realtime ws-compat proxy updates." \
                     "已为保留的 nginx 配置补齐实时语音 ws-compat 代理。"
            else
                _msg "WARNING: failed to patch the preserved nginx realtime ws-compat proxy config." \
                     "警告: 补齐保留 nginx 配置中的实时语音 ws-compat 代理失败。"
            fi
        fi
    else
        sed -e "s|%%LISTEN_PORT%%|${LISTEN_PORT}|g" \
            -e "s|%%WEB_ROOT%%|${WEB_ROOT}|g" \
            -e "s|%%API_HOST%%|${API_HOST}|g" \
            "$NGINX_TEMPLATE" > "$NGINX_CONF"
        _msg "Generated nginx config: $NGINX_CONF (port ${LISTEN_PORT})" \
             "已生成 nginx 配置: $NGINX_CONF (端口 ${LISTEN_PORT})"
    fi

    # Test and reload nginx
    NGINX_BIN=$(command -v nginx 2>/dev/null || echo /usr/sbin/nginx)
    if [[ -x "$NGINX_BIN" ]]; then
        if $NGINX_BIN -t 2>/dev/null; then
            systemctl reload nginx 2>/dev/null || true
            _msg "Nginx configuration reloaded." "Nginx 配置已重载。"
        else
            _msg "WARNING: nginx config test failed. Please check $NGINX_CONF" \
                 "警告: nginx 配置测试失败。请检查 $NGINX_CONF"
        fi
    fi
fi

# ── LiveKit config ──────────────────────────────────────────────────────────
if [[ -f "$LIVEKIT_TEMPLATE" ]]; then
    if [[ -z "${LIVEKIT_API_KEY:-}" || -z "${LIVEKIT_API_SECRET:-}" ]] && [[ ! -f "$LIVEKIT_CREDENTIALS_FILE" ]]; then
        mkdir -p "$(dirname "$LIVEKIT_CREDENTIALS_FILE")"
        _now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        cat > "$LIVEKIT_CREDENTIALS_FILE" <<EOF
# Managed by TX-5DR. Rotate via tx5dr livekit-creds rotate.
LIVEKIT_API_KEY=tx5dr-$(random_hex 8)
LIVEKIT_API_SECRET=$(random_hex 24)
LIVEKIT_CREDENTIALS_CREATED_AT=${_now}
LIVEKIT_CREDENTIALS_ROTATED_AT=${_now}
EOF
        chmod 640 "$LIVEKIT_CREDENTIALS_FILE"
        chown "$APP_USER:$APP_GROUP" "$LIVEKIT_CREDENTIALS_FILE" 2>/dev/null || true
        _msg "Generated LiveKit credentials: $LIVEKIT_CREDENTIALS_FILE" \
             "已生成 LiveKit 凭据: $LIVEKIT_CREDENTIALS_FILE"
    fi

    if [[ -z "${LIVEKIT_API_KEY:-}" || -z "${LIVEKIT_API_SECRET:-}" ]]; then
        # shellcheck disable=SC1090
        source "$LIVEKIT_CREDENTIALS_FILE" 2>/dev/null || true
    fi

    sed -e "s|%%LIVEKIT_SIGNAL_PORT%%|${LIVEKIT_SIGNAL_PORT:-7880}|g" \
        -e "s|%%LIVEKIT_TCP_PORT%%|${LIVEKIT_TCP_PORT:-7881}|g" \
        -e "s|%%LIVEKIT_UDP_PORT_START%%|${LIVEKIT_UDP_PORT_START:-50000}|g" \
        -e "s|%%LIVEKIT_UDP_PORT_END%%|${LIVEKIT_UDP_PORT_END:-50100}|g" \
        -e "s|%%LIVEKIT_API_KEY%%|${LIVEKIT_API_KEY}|g" \
        -e "s|%%LIVEKIT_API_SECRET%%|${LIVEKIT_API_SECRET}|g" \
        "$LIVEKIT_TEMPLATE" > "$LIVEKIT_CONF"
    chmod 640 "$LIVEKIT_CONF"
    chown "$APP_USER:$APP_GROUP" "$LIVEKIT_CONF" 2>/dev/null || true
    _msg "Generated LiveKit config: $LIVEKIT_CONF" \
         "已生成 LiveKit 配置: $LIVEKIT_CONF"
fi

# ── SELinux (RHEL/Fedora only) ───────────────────────────────────────────────
if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    # Ensure semanage is available
    if ! command -v semanage &>/dev/null; then
        dnf install -y policycoreutils-python-utils >/dev/null 2>&1 || true
    fi
    # Allow nginx to bind to the configured port
    if command -v semanage &>/dev/null; then
        if ! semanage port -l 2>/dev/null | grep -w http_port_t | grep -qw "$LISTEN_PORT"; then
            semanage port -a -t http_port_t -p tcp "$LISTEN_PORT" 2>/dev/null || \
            semanage port -m -t http_port_t -p tcp "$LISTEN_PORT" 2>/dev/null || true
        fi
    fi
    # Allow nginx to proxy to backend
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
    _msg "SELinux: nginx port $LISTEN_PORT allowed, proxy to backend enabled." \
         "SELinux: nginx 端口 $LISTEN_PORT 已放行，反向代理已启用。"
fi

# ── Enable systemd service ──────────────────────────────────────────────────
systemctl daemon-reload 2>/dev/null || true
systemctl enable tx5dr-livekit 2>/dev/null || true
systemctl enable tx5dr 2>/dev/null || true

if systemctl is-active --quiet tx5dr 2>/dev/null; then
    systemctl restart tx5dr 2>/dev/null || true
else
    systemctl start tx5dr 2>/dev/null || true
fi

if systemctl is-active --quiet tx5dr 2>/dev/null; then
    if is_package_upgrade; then
        _msg "TX-5DR services restarted after upgrade." \
             "TX-5DR 服务已在升级后自动重启。"
    else
        _msg "TX-5DR services started." \
             "TX-5DR 服务已启动。"
    fi
else
    _msg "WARNING: TX-5DR service did not start automatically. Check: journalctl -u tx5dr -u tx5dr-livekit -n 50 --no-pager" \
         "警告: TX-5DR 服务未能自动启动。请检查: journalctl -u tx5dr -u tx5dr-livekit -n 50 --no-pager"
fi

# ── Environment check (using shared library if available) ────────────────────
if [[ "$SHARED_LIB_READY" == "1" ]]; then
    ISSUES=0
    echo ""

    if ! check_nodejs; then
        log_warn "$(msg FIX_NODEJS)"
        ISSUES=$((ISSUES + 1))
    fi

    if ! check_glibcxx; then
        log_warn "$(msg FIX_GLIBCXX)"
        ISSUES=$((ISSUES + 1))
    fi

    if [[ $ISSUES -gt 0 ]]; then
        echo ""
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
        _msg "Run 'sudo bash /usr/share/tx5dr/install.sh' to auto-fix, or 'tx5dr doctor' for diagnostics." \
             "运行 'sudo bash /usr/share/tx5dr/install.sh' 自动修复，或 'tx5dr doctor' 查看诊断。"
    fi
fi

echo ""
if systemctl is-active --quiet tx5dr 2>/dev/null; then
    _msg "TX-5DR installed and running." \
         "TX-5DR 已安装并正在运行。"
else
    _msg "TX-5DR installed. Run 'tx5dr start' to start the server." \
         "TX-5DR 已安装。运行 'tx5dr start' 启动服务。"
fi
_msg "Web UI will be available at http://localhost:${LISTEN_PORT}" \
     "Web UI 地址: http://localhost:${LISTEN_PORT}"
