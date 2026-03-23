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

# Add to audio group for sound device access
usermod -a -G audio "$APP_USER" 2>/dev/null || true

# --- Create data directories ---
for dir in "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/logs" "$DATA_DIR/cache"; do
    mkdir -p "$dir"
    chown "$APP_USER:$APP_GROUP" "$dir"
    chmod 755 "$dir"
done

# --- Generate nginx site config from template ---
if [[ -f "$NGINX_TEMPLATE" ]]; then
    sed -e "s|%%LISTEN_PORT%%|${LISTEN_PORT}|g" \
        -e "s|%%WEB_ROOT%%|${WEB_ROOT}|g" \
        -e "s|%%API_HOST%%|${API_HOST}|g" \
        "$NGINX_TEMPLATE" > "$NGINX_CONF"
    echo "Generated nginx config: $NGINX_CONF (port ${LISTEN_PORT})"

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

# --- Enable and start systemd service ---
systemctl daemon-reload
systemctl enable tx5dr 2>/dev/null || true
echo "TX-5DR service enabled. Run 'tx5dr start' to start the server."
echo "Web UI will be available at http://localhost:${LISTEN_PORT}"
