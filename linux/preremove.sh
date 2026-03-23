#!/bin/bash
# TX-5DR pre-remove script for deb/rpm packages
# Stops and disables the service, removes nginx config.
# Data directory /var/lib/tx5dr/ is preserved (use purge to remove).

set -e

NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"

# --- Stop and disable service ---
if systemctl is-active --quiet tx5dr 2>/dev/null; then
    systemctl stop tx5dr
    echo "TX-5DR service stopped."
fi

systemctl disable tx5dr 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true

# --- Remove nginx config ---
if [[ -f "$NGINX_CONF" ]]; then
    rm -f "$NGINX_CONF"
    echo "Removed nginx config: $NGINX_CONF"

    # Reload nginx
    if command -v nginx >/dev/null 2>&1; then
        if nginx -t 2>/dev/null; then
            systemctl reload nginx 2>/dev/null || true
        fi
    fi
fi

echo "TX-5DR removed. Data directory /var/lib/tx5dr/ has been preserved."
echo "To remove all data: sudo rm -rf /var/lib/tx5dr"
