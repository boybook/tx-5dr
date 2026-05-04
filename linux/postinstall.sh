#!/bin/bash
# TX-5DR post-install script for deb/rpm packages.

set -e

_LANG_ID="en"
_lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}"
case "$_lang" in zh_CN*|zh_TW*|zh_HK*|zh.*) _LANG_ID="zh" ;; esac
_msg() {
    local en="$1" zh="$2"
    if [[ "$_LANG_ID" == "zh" ]]; then echo "$zh"; else echo "$en"; fi
}

APP_USER="tx5dr"
APP_GROUP="tx5dr"
DATA_DIR="/var/lib/tx5dr"
NGINX_TEMPLATE="/usr/share/tx5dr/nginx-site.conf"
NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"
CONFIG_ENV="/etc/tx5dr/config.env"
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

LISTEN_PORT="${TX5DR_HTTP_PORT:-8076}"
WEB_ROOT="/usr/share/tx5dr/web"
API_HOST="127.0.0.1:${PORT:-4000}"
HTTPS_PORT="${TX5DR_HTTPS_PORT:-8443}"
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

if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    groupadd --system "$APP_GROUP"
    _msg "Created group: $APP_GROUP" "已创建用户组: $APP_GROUP"
fi

if ! getent passwd "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
    _msg "Created user: $APP_USER" "已创建用户: $APP_USER"
fi

usermod -a -G audio,dialout "$APP_USER" 2>/dev/null || true

for dir in "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/logs" "$DATA_DIR/cache" "$DATA_DIR/realtime"; do
    mkdir -p "$dir"
    chown "$APP_USER:$APP_GROUP" "$dir"
    chmod 755 "$dir"
done

if [[ -f "$NGINX_TEMPLATE" ]]; then
    if [[ -f "$NGINX_CONF" ]]; then
        echo ""
        echo "  ✓ $(_msg "Nginx config preserved (not overwritten)" "Nginx 配置已保留（未覆盖）")"
        echo "    $(_msg "File:" "文件:") $NGINX_CONF"
        if [[ "$SHARED_LIB_READY" == "1" ]] && ! check_nginx_realtime_proxy_config; then
            if fix_nginx_realtime_proxy_config; then
                _msg "Patched preserved nginx config with realtime proxy updates." \
                     "已为保留的 nginx 配置补齐实时语音反向代理。"
            else
                _msg "WARNING: failed to patch the preserved nginx realtime proxy config." \
                     "警告: 补齐保留 nginx 配置中的实时语音反向代理失败。"
            fi
        fi
    else
        mkdir -p "$(dirname "$NGINX_CONF")"
        sed -e "s|%%LISTEN_PORT%%|${LISTEN_PORT}|g" \
            -e "s|%%WEB_ROOT%%|${WEB_ROOT}|g" \
            -e "s|%%API_HOST%%|${API_HOST}|g" \
            "$NGINX_TEMPLATE" > "$NGINX_CONF"
        _msg "Generated nginx config: $NGINX_CONF (port ${LISTEN_PORT})" \
             "已生成 nginx 配置: $NGINX_CONF (端口 ${LISTEN_PORT})"
    fi

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

if [[ "$SHARED_LIB_READY" == "1" ]]; then
    SSL_DIR="${TX5DR_SSL_DIR:-/etc/tx5dr/ssl}"
    SSL_CERT="$SSL_DIR/server.crt"
    SSL_KEY="$SSL_DIR/server.key"

    if [[ ! -f "$SSL_CERT" ]] || [[ ! -f "$SSL_KEY" ]]; then
        if generate_self_signed_cert; then
            _msg "Generated self-signed SSL certificate: $SSL_DIR" \
                 "已生成自签名 SSL 证书: $SSL_DIR"
        else
            _msg "WARNING: failed to generate self-signed SSL certificate." \
                 "警告: 自签名 SSL 证书生成失败。"
        fi
    fi

    if [[ -f "$NGINX_CONF" && -f "$SSL_CERT" && -f "$SSL_KEY" ]]; then
        if ! check_nginx_ssl_block 2>/dev/null; then
            if fix_nginx_ssl_config; then
                _msg "Added HTTPS server block to nginx config (port $HTTPS_PORT)" \
                     "已在 nginx 配置中添加 HTTPS 服务块（端口 $HTTPS_PORT）"
            else
                _msg "WARNING: failed to add HTTPS server block to nginx config." \
                     "警告: 向 nginx 配置添加 HTTPS 服务块失败。"
            fi
        fi
    fi
fi

if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    if ! command -v semanage &>/dev/null; then
        dnf install -y policycoreutils-python-utils >/dev/null 2>&1 || true
    fi
    if command -v semanage &>/dev/null; then
        for _port in "$LISTEN_PORT" "$HTTPS_PORT"; do
            if ! semanage port -l 2>/dev/null | grep -w http_port_t | grep -qw "$_port"; then
                semanage port -a -t http_port_t -p tcp "$_port" 2>/dev/null || \
                semanage port -m -t http_port_t -p tcp "$_port" 2>/dev/null || true
            fi
        done
    fi
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
fi

legacy_suffix="$(printf '%s%s' 'live' 'kit')"
legacy_service="tx5dr-${legacy_suffix}"
legacy_credential="/etc/tx5dr/${legacy_suffix}-credentials.env"
legacy_config="/var/lib/tx5dr/realtime/${legacy_suffix}.resolved.yaml"
legacy_service_file="/lib/systemd/system/${legacy_service}.service"

systemctl disable --now "$legacy_service" 2>/dev/null || true
for legacy_file in "$legacy_credential" "$legacy_config"; do
    if [[ -f "$legacy_file" ]] && grep -q 'Managed by TX-5DR' "$legacy_file" 2>/dev/null; then
        rm -f "$legacy_file"
        _msg "Removed old managed realtime file: $legacy_file" \
             "已删除旧版托管实时语音文件: $legacy_file"
    fi
done
rm -f "$legacy_service_file" 2>/dev/null || true

# Ensure /etc/tx5dr/config.env exists before starting the service
CONFIG_ENV_TEMPLATE="/usr/share/tx5dr/config.env.default"
if [[ ! -f "$CONFIG_ENV" ]]; then
    if [[ -f "$CONFIG_ENV_TEMPLATE" ]]; then
        cp "$CONFIG_ENV_TEMPLATE" "$CONFIG_ENV"
        chmod 644 "$CONFIG_ENV"
        _msg "config.env was missing, restored from default template." \
             "config.env 缺失，已从默认模板恢复。"
    else
        _msg "WARNING: config.env and its template are both missing. The server may use incorrect paths." \
             "警告：config.env 及其模板均缺失，服务器可能使用错误的配置路径。"
    fi
fi

systemctl daemon-reload 2>/dev/null || true
systemctl enable tx5dr 2>/dev/null || true

if systemctl is-active --quiet tx5dr 2>/dev/null; then
    systemctl restart tx5dr 2>/dev/null || true
else
    systemctl start tx5dr 2>/dev/null || true
fi

if systemctl is-active --quiet tx5dr 2>/dev/null; then
    if is_package_upgrade; then
        _msg "TX-5DR service restarted after upgrade." \
             "TX-5DR 服务已在升级后自动重启。"
    else
        _msg "TX-5DR service started." \
             "TX-5DR 服务已启动。"
    fi
else
    _msg "WARNING: TX-5DR service did not start automatically. Check: journalctl -u tx5dr -u nginx -n 50 --no-pager" \
         "警告: TX-5DR 服务未能自动启动。请检查: journalctl -u tx5dr -u nginx -n 50 --no-pager"
fi

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
    if ! check_rtc_data_audio_udp_config; then
        log_warn "$(msg FIX_RTC_DATA_AUDIO_UDP)"
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
         "TX-5DR 已安装。运行 'tx5dr start' 启动服务器。"
fi
