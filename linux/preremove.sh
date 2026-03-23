#!/bin/bash
# TX-5DR pre-remove script for deb/rpm packages
# Stops and disables the service, removes nginx config (only on full remove).
# Data directory /var/lib/tx5dr/ is always preserved (use purge to remove).

set -e

# Detect language
_LANG_ID="en"
_lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}"
case "$_lang" in zh_CN*|zh_TW*|zh_HK*|zh.*) _LANG_ID="zh" ;; esac
_msg() { if [[ "$_LANG_ID" == "zh" ]]; then echo "$2"; else echo "$1"; fi; }

NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"

# dpkg passes $1 = "remove" for uninstall, "upgrade" for upgrade
ACTION="${1:-remove}"

# --- Stop service (both remove and upgrade) ---
if systemctl is-active --quiet tx5dr 2>/dev/null; then
    systemctl stop tx5dr
    _msg "TX-5DR service stopped." "TX-5DR 服务已停止。"
fi

# --- Only on full remove (not upgrade) ---
if [[ "$ACTION" == "remove" ]]; then
    systemctl disable tx5dr 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true

    # Remove nginx config
    if [[ -f "$NGINX_CONF" ]]; then
        rm -f "$NGINX_CONF"
        _msg "Removed nginx config: $NGINX_CONF" "已移除 nginx 配置: $NGINX_CONF"

        NGINX_BIN=$(command -v nginx 2>/dev/null || echo /usr/sbin/nginx)
        if [[ -x "$NGINX_BIN" ]]; then
            if $NGINX_BIN -t 2>/dev/null; then
                systemctl reload nginx 2>/dev/null || true
            fi
        fi
    fi

    _msg "TX-5DR removed. Data directory /var/lib/tx5dr/ has been preserved." \
         "TX-5DR 已移除。数据目录 /var/lib/tx5dr/ 已保留。"
    _msg "To remove all data: sudo rm -rf /var/lib/tx5dr" \
         "如需删除所有数据: sudo rm -rf /var/lib/tx5dr"
else
    _msg "TX-5DR upgrading — nginx config and data preserved." \
         "TX-5DR 升级中 — nginx 配置和数据已保留。"
fi
