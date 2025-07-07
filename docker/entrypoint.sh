#!/bin/bash

# 设置错误处理
set -e

# 获取主机用户ID和组ID
HOST_UID=${HOST_UID:-1000}
HOST_GID=${HOST_GID:-1000}

echo "Setting up user permissions..."
echo "Host UID: $HOST_UID"
echo "Host GID: $HOST_GID"

# 创建与主机用户ID匹配的用户
if ! id -u appuser > /dev/null 2>&1; then
    groupadd -g $HOST_GID appuser || true
    useradd -u $HOST_UID -g $HOST_GID -d /app -s /bin/bash appuser || true
    usermod -a -G audio appuser || true
fi

# 创建数据目录
mkdir -p /app/data/config /app/data/logs /app/data/cache
mkdir -p /var/log/supervisor /var/log/nginx

# 设置数据目录权限
chown -R $HOST_UID:$HOST_GID /app/data
chmod -R 755 /app/data

# 设置应用目录权限
chown -R $HOST_UID:$HOST_GID /app/packages
chmod -R 755 /app/packages

# 设置日志目录权限
chown -R $HOST_UID:$HOST_GID /var/log/supervisor
chown -R $HOST_UID:$HOST_GID /var/log/nginx

# 启动supervisor
echo "Starting supervisor..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf 