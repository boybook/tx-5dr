#!/bin/bash

set -euo pipefail

SSL_NAME="frp.boybook.top"
SRC_SSL_DIR="${HOME}/coding/wavelog/ssl"
SRC_CERT="${SRC_SSL_DIR}/${SSL_NAME}.pem"
SRC_KEY="${SRC_SSL_DIR}/${SSL_NAME}.key"

TARGET_SSL_DIR="/etc/nginx/ssl"
TARGET_CERT="${TARGET_SSL_DIR}/${SSL_NAME}.pem"
TARGET_KEY="${TARGET_SSL_DIR}/${SSL_NAME}.key"
NGINX_CONF="/etc/nginx/conf.d/tx5dr-ssl.conf"

if [[ $EUID -ne 0 ]]; then
    exec sudo bash "$0" "$@"
fi

if [[ ! -f "$SRC_CERT" ]]; then
    echo "Missing certificate: $SRC_CERT" >&2
    exit 1
fi

if [[ ! -f "$SRC_KEY" ]]; then
    echo "Missing private key: $SRC_KEY" >&2
    exit 1
fi

mkdir -p "$TARGET_SSL_DIR"
cp "$SRC_CERT" "$TARGET_CERT"
cp "$SRC_KEY" "$TARGET_KEY"
chown root:root "$TARGET_CERT" "$TARGET_KEY"
chmod 644 "$TARGET_CERT"
chmod 600 "$TARGET_KEY"

if command -v restorecon >/dev/null 2>&1; then
    restorecon -Rv "$TARGET_SSL_DIR" >/dev/null 2>&1 || true
fi

cat > "$NGINX_CONF" <<'EOF'
map $http_upgrade $tx5dr_ssl_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    http2 on;
    server_name frp.boybook.top www.frp.boybook.top;

    ssl_certificate /etc/nginx/ssl/frp.boybook.top.pem;
    ssl_certificate_key /etc/nginx/ssl/frp.boybook.top.key;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers PROFILE=SYSTEM;
    ssl_prefer_server_ciphers off;

    location / {
        root /usr/share/tx5dr/web;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /usr/share/tx5dr/web;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api/realtime/ws-compat {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $tx5dr_ssl_connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    location /livekit/ {
        proxy_pass http://127.0.0.1:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $tx5dr_ssl_connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /api/ws {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $tx5dr_ssl_connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
EOF

nginx -t
systemctl reload nginx

echo
echo "HTTPS is configured on port 8443."
echo "Test with:"
echo "  curl -Ik https://frp.boybook.top:8443"
echo "  ss -tln | grep 8443"
