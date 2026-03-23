#!/bin/bash
# TX-5DR post-install script for deb/rpm packages
# Creates system user, data directories, nginx config, and enables the service.

set -e

APP_USER="tx5dr"
APP_GROUP="tx5dr"
DATA_DIR="/var/lib/tx5dr"
NGINX_TEMPLATE="/usr/share/tx5dr/nginx-site.conf"
NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"
CONFIG_ENV="/etc/tx5dr/config.env"

# Load config for port settings
if [[ -f "$CONFIG_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_ENV" 2>/dev/null || true
fi

LISTEN_PORT="${TX5DR_HTTP_PORT:-8076}"
WEB_ROOT="/usr/share/tx5dr/web"
API_HOST="127.0.0.1:${PORT:-4000}"

# --- Create system user ---
if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    groupadd --system "$APP_GROUP"
    echo "Created group: $APP_GROUP"
fi

if ! getent passwd "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
    echo "Created user: $APP_USER"
fi

# Add to audio (sound devices) and dialout (serial ports /dev/ttyS*, /dev/ttyUSB*) groups
usermod -a -G audio,dialout "$APP_USER" 2>/dev/null || true

# --- Create data directories ---
for dir in "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/logs" "$DATA_DIR/cache"; do
    mkdir -p "$dir"
    chown "$APP_USER:$APP_GROUP" "$dir"
    chmod 755 "$dir"
done

# --- Generate nginx site config from template ---
if [[ -f "$NGINX_TEMPLATE" ]]; then
    if [[ -f "$NGINX_CONF" ]]; then
        # Preserve user-modified config (SSL, custom ports, etc.)
        echo ""
        echo "  ✓ Nginx config preserved (not overwritten)"
        echo "    保留了现有的 Nginx 配置（未覆盖）"
        echo "    File 文件: $NGINX_CONF"
        echo "    Your SSL, custom ports, and other changes are safe."
        echo "    您的 SSL、自定义端口等修改已保留。"
        echo "    To reset to default 如需恢复默认: sudo rm $NGINX_CONF && tx5dr doctor"
        echo ""
    else
        sed -e "s|%%LISTEN_PORT%%|${LISTEN_PORT}|g" \
            -e "s|%%WEB_ROOT%%|${WEB_ROOT}|g" \
            -e "s|%%API_HOST%%|${API_HOST}|g" \
            "$NGINX_TEMPLATE" > "$NGINX_CONF"
        echo "Generated nginx config: $NGINX_CONF (port ${LISTEN_PORT})"
    fi

    # Test and reload nginx
    if command -v nginx >/dev/null 2>&1; then
        if nginx -t 2>/dev/null; then
            systemctl reload nginx 2>/dev/null || true
            echo "Nginx configuration reloaded."
        else
            echo "WARNING: nginx config test failed. Please check $NGINX_CONF"
        fi
    fi
fi

# --- Enable systemd service ---
systemctl daemon-reload
systemctl enable tx5dr 2>/dev/null || true

# --- Environment check (using shared library if available) ---
LIB_DIR="/usr/share/tx5dr/lib"
if [[ -f "$LIB_DIR/common.sh" && -f "$LIB_DIR/checks.sh" ]]; then
    source "$LIB_DIR/common.sh"
    source "$LIB_DIR/checks.sh"

    ISSUES=0
    echo ""

    if ! check_nodejs; then
        log_warn "Node.js >= 20 not found. $(msg FIX_NODEJS)"
        ISSUES=$((ISSUES + 1))
    fi

    if ! check_glibcxx; then
        log_warn "GLIBCXX_3.4.32 not found. Audio subsystem (audify) may fail."
        log_warn "$(msg FIX_GLIBCXX)"
        ISSUES=$((ISSUES + 1))
    fi

    if [[ $ISSUES -gt 0 ]]; then
        echo ""
        log_warn "$(printf "$(msg ISSUES_FOUND)" "$ISSUES")"
        log_warn "Run 'sudo bash /usr/share/tx5dr/install.sh' to auto-fix."
        log_warn "Or run 'tx5dr doctor' for detailed diagnostics."
    fi
fi

echo ""
echo "TX-5DR installed. Run 'tx5dr start' to start the server."
echo "Web UI will be available at http://localhost:${LISTEN_PORT}"
