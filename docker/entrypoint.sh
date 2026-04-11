#!/bin/bash

# TX-5DR Docker Entrypoint Script
# 自动检测宿主机权限并设置容器内权限

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[TX-5DR]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[TX-5DR WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[TX-5DR ERROR]${NC} $1"
}

# 检查是否以root身份运行
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

log "Starting TX-5DR Docker container initialization..."

export LIVEKIT_CREDENTIALS_FILE="${LIVEKIT_CREDENTIALS_FILE:-/app/data/realtime/livekit-credentials.env}"
export LIVEKIT_CONFIG_PATH="${LIVEKIT_CONFIG_PATH:-/app/data/realtime/livekit.yaml}"
if [[ -f "$LIVEKIT_CREDENTIALS_FILE" ]]; then
    log "Using LiveKit managed credential file: $LIVEKIT_CREDENTIALS_FILE"
fi

# 定义数据目录
DATA_DIRS=(
    "/app/data/config"
    "/app/data/logs"
    "/app/data/cache"
    "/app/data/realtime"
    "/var/log/nginx"
    "/var/log/supervisor"
)

# 创建数据目录（如果不存在）
for dir in "${DATA_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir"
        log "Created directory: $dir"
    fi
done

# 创建 nginx 临时目录
NGINX_TEMP_DIRS=(
    "/var/lib/nginx"
    "/var/lib/nginx/body"
    "/var/lib/nginx/proxy"
    "/var/lib/nginx/fastcgi"
    "/var/lib/nginx/uwsgi"
    "/var/lib/nginx/scgi"
)

for dir in "${NGINX_TEMP_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir"
        log "Created nginx temp directory: $dir"
    fi
    # 设置为 nginx 用户可写
    chown -R www-data:www-data "$dir"
    chmod -R 755 "$dir"
done

# 自动检测宿主机用户权限
# 通过检查挂载卷的所有者来确定宿主机用户
detect_host_user() {
    local mount_point="/app/data"
    local host_uid=1000
    local host_gid=1000
    
    # 如果挂载点存在且不是root拥有，获取其UID和GID
    if [[ -d "$mount_point" ]]; then
        local stat_output=$(stat -c "%u:%g" "$mount_point" 2>/dev/null || echo "1000:1000")
        host_uid=$(echo "$stat_output" | cut -d: -f1)
        host_gid=$(echo "$stat_output" | cut -d: -f2)
        
        # 如果是root用户(0)，使用默认的1000
        if [[ "$host_uid" -eq 0 ]]; then
            host_uid=1000
        fi
        if [[ "$host_gid" -eq 0 ]]; then
            host_gid=1000
        fi
    fi
    
    echo "$host_uid:$host_gid"
}

# 获取宿主机用户信息
USER_INFO=$(detect_host_user)
HOST_UID=$(echo "$USER_INFO" | cut -d: -f1)
HOST_GID=$(echo "$USER_INFO" | cut -d: -f2)

log "Detected host user: UID=$HOST_UID, GID=$HOST_GID"

# 创建对应的用户和组
APP_USER="tx5dr"
APP_GROUP="tx5dr"

# 检查组是否存在，如果不存在则创建
if ! getent group "$HOST_GID" > /dev/null 2>&1; then
    groupadd -g "$HOST_GID" "$APP_GROUP"
    log "Created group: $APP_GROUP (GID: $HOST_GID)"
else
    # 如果组已存在，获取组名
    APP_GROUP=$(getent group "$HOST_GID" | cut -d: -f1)
    log "Using existing group: $APP_GROUP (GID: $HOST_GID)"
fi

# 检查用户是否存在，如果不存在则创建
if ! getent passwd "$HOST_UID" > /dev/null 2>&1; then
    useradd -u "$HOST_UID" -g "$HOST_GID" -m -s /bin/bash "$APP_USER"
    log "Created user: $APP_USER (UID: $HOST_UID, GID: $HOST_GID)"
else
    # 如果用户已存在，获取用户名
    APP_USER=$(getent passwd "$HOST_UID" | cut -d: -f1)
    log "Using existing user: $APP_USER (UID: $HOST_UID, GID: $HOST_GID)"
fi

# 将应用用户添加到必要的组（逐个添加，避免某个组不存在导致整条命令失败）
for grp in audio dialout pulse-access; do
    getent group "$grp" > /dev/null 2>&1 && usermod -a -G "$grp" "$APP_USER" 2>/dev/null || true
done

# 设置目录权限
log "Setting directory permissions..."
for dir in "${DATA_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
        chown -R "$HOST_UID:$HOST_GID" "$dir"
        chmod -R 755 "$dir"
        log "Set permissions for: $dir"
    fi
done

# 设置应用目录权限
chown -R "$HOST_UID:$HOST_GID" /app/data
chmod -R 755 /app/data

# 创建PID文件目录
mkdir -p /var/run/tx5dr
chown "$HOST_UID:$HOST_GID" /var/run/tx5dr

# 修改supervisor配置文件中的用户设置
if [[ -f "/etc/supervisor/conf.d/supervisord.conf" ]]; then
    # 备份原始配置
    cp /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf.bak

    # 仅替换 tx5dr-server 进程配置中的 user，避免误改 nginx 配置
    awk -v app_user="$APP_USER" '
        /^\[program:tx5dr-server\]$/ { in_server=1 }
        /^\[/ && $0 != "[program:tx5dr-server]" { in_server=0 }
        in_server && /^user=/ { $0="user=" app_user }
        { print }
    ' /etc/supervisor/conf.d/supervisord.conf > /etc/supervisor/conf.d/supervisord.conf.tmp
    mv /etc/supervisor/conf.d/supervisord.conf.tmp /etc/supervisor/conf.d/supervisord.conf
    log "Updated supervisor configuration for tx5dr-server user: $APP_USER"
fi

# nginx 配置保持不变，使用 www-data 用户
# nginx 自身以 root 运行，但 worker 进程使用 www-data 用户
if [[ -f "/etc/nginx/nginx.conf" ]]; then
    log "Nginx configuration using www-data user for worker processes"
fi

# 创建日志文件并设置权限
touch /var/log/supervisor/supervisord.log
chown "$HOST_UID:$HOST_GID" /var/log/supervisor/supervisord.log

# ── SSL certificate (self-signed) ───────────────────────────────────────────
SSL_DIR="/app/data/ssl"
SSL_CERT="$SSL_DIR/server.crt"
SSL_KEY="$SSL_DIR/server.key"
SSL_INFO="$SSL_DIR/cert-info.env"

mkdir -p "$SSL_DIR"

if [[ ! -f "$SSL_CERT" ]] || [[ ! -f "$SSL_KEY" ]]; then
    log "Generating self-signed SSL certificate..."

    local_hostname=$(hostname 2>/dev/null || echo "localhost")

    # Build SAN string
    san="DNS:localhost"
    [[ "$local_hostname" != "localhost" ]] && san="${san},DNS:${local_hostname}"
    san="${san},IP:127.0.0.1"

    # Add all LAN IPs
    for ip in $(ip -4 addr show scope global 2>/dev/null | awk '/inet / {split($2,a,"/"); print a[1]}' | sort -u); do
        [[ -n "$ip" && "$ip" != "127.0.0.1" ]] && san="${san},IP:${ip}"
    done

    openssl genrsa -out "$SSL_KEY" 2048 2>/dev/null && \
    openssl req -new -x509 -key "$SSL_KEY" -out "$SSL_CERT" \
        -days 365 -sha256 \
        -subj "/CN=${local_hostname}/O=TX-5DR" \
        -addext "subjectAltName=${san}" \
        -addext "basicConstraints=CA:FALSE" \
        -addext "keyUsage=digitalSignature,keyEncipherment" \
        -addext "extKeyUsage=serverAuth" \
        2>/dev/null

    if [[ -f "$SSL_CERT" ]] && [[ -f "$SSL_KEY" ]]; then
        chmod 644 "$SSL_CERT"
        chmod 640 "$SSL_KEY"
        # Write metadata
        now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        expires=$(openssl x509 -enddate -noout -in "$SSL_CERT" 2>/dev/null | cut -d= -f2 || true)
        fingerprint=$(openssl x509 -fingerprint -sha256 -noout -in "$SSL_CERT" 2>/dev/null | cut -d= -f2 || true)
        cat > "$SSL_INFO" <<CERTEOF
# Managed by TX-5DR. Replace server.crt and server.key with your own certificate.
# After replacing, update TX5DR_SSL_MODE to "custom" and restart the container.
TX5DR_SSL_MODE=self-signed
TX5DR_SSL_CREATED_AT=${now}
TX5DR_SSL_EXPIRES=${expires}
TX5DR_SSL_FINGERPRINT_SHA256=${fingerprint}
TX5DR_SSL_HOSTNAME=${local_hostname}
TX5DR_SSL_SAN=${san}
CERTEOF
        chmod 644 "$SSL_INFO"
        log "Self-signed SSL certificate generated: $SSL_DIR"
    else
        warn "Failed to generate self-signed SSL certificate"
    fi
else
    log "Using existing SSL certificate: $SSL_DIR"
fi

# Patch nginx config with HTTPS server block if certificate exists and HTTPS block is missing
NGINX_CONF="/etc/nginx/conf.d/tx5dr.conf"
if [[ -f "$SSL_CERT" ]] && [[ -f "$SSL_KEY" ]] && [[ -f "$NGINX_CONF" ]]; then
    if ! grep -q 'ssl_certificate[[:space:]]*/app/data/ssl/server\.crt' "$NGINX_CONF" 2>/dev/null; then
        log "Adding HTTPS server block to nginx config..."

        # Extract location blocks from existing server block using awk
        awk -v ssl_cert="$SSL_CERT" -v ssl_key="$SSL_KEY" '
            BEGIN {
                in_server = 0
                depth = 0
                lines_count = 0
            }
            {
                line = $0
                if (!in_server && line ~ /^server[[:space:]]*\{/ ) {
                    in_server = 1
                    depth = 1
                    next
                }
                if (in_server) {
                    n = length(line)
                    for (i = 1; i <= n; i++) {
                        c = substr(line, i, 1)
                        if (c == "{") depth++
                        if (c == "}") depth--
                    }
                    if (depth <= 0) {
                        in_server = 0
                        next
                    }
                    if (line ~ /^[[:space:]]*listen[[:space:]]/) next
                    if (line ~ /^[[:space:]]*server_name[[:space:]]/) next
                    lines_count++
                    server_lines[lines_count] = line
                }
            }
            END {
                print ""
                print "# TX-5DR HTTPS (auto-generated self-signed certificate)"
                print "server {"
                print "    listen 443 ssl;"
                print "    listen [::]:443 ssl;"
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
        ' "$NGINX_CONF" >> "$NGINX_CONF"

        log "HTTPS server block added to nginx config (port 443, host: 8443)"
    fi
fi

# Set SSL directory permissions to match host user
if [[ -d "$SSL_DIR" ]]; then
    chown -R "$HOST_UID:$HOST_GID" "$SSL_DIR"
fi

# 如果传入了命令参数，执行相应命令
if [[ $# -gt 0 ]]; then
    log "Executing command: $*"
    if [[ "$1" == "supervisord" || "$1" == "/usr/bin/supervisord" ]]; then
        # 启动supervisor
        log "Starting supervisor daemon..."
        exec "$@"
    else
        # 切换到应用用户执行其他命令
        exec gosu "$APP_USER" "$@"
    fi
else
    # 默认启动supervisor
    log "Starting TX-5DR services with supervisor..."
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
fi
