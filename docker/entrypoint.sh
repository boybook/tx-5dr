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

# 定义数据目录
DATA_DIRS=(
    "/app/data/config"
    "/app/data/logs"
    "/app/data/cache"
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

# 将应用用户添加到必要的组
usermod -a -G audio,pulse-access "$APP_USER" 2>/dev/null || true

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
    
    # 更新配置文件中的用户设置
    sed -i "s/user=www-data/user=$APP_USER/g" /etc/supervisor/conf.d/supervisord.conf
    log "Updated supervisor configuration with user: $APP_USER"
fi

# 修改nginx配置文件中的用户设置
if [[ -f "/etc/nginx/nginx.conf" ]]; then
    # 备份原始配置
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
    
    # 更新nginx用户设置
    sed -i "s/user www-data;/user $APP_USER;/g" /etc/nginx/nginx.conf
    log "Updated nginx configuration with user: $APP_USER"
fi

# 创建日志文件并设置权限
touch /var/log/supervisor/supervisord.log
chown "$HOST_UID:$HOST_GID" /var/log/supervisor/supervisord.log

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