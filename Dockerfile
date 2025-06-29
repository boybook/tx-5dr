# TX-5DR Docker Image
FROM node:22-bookworm

# 设置环境变量
ENV YARN_VERSION=4.9.1
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    libasound2-dev \
    libpulse-dev \
    libx11-dev \
    libxrandr-dev \
    libxinerama-dev \
    libxcursor-dev \
    libjack-jackd2-dev \
    portaudio19-dev \
    libxi-dev \
    libxext-dev \
    nginx \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# 启用Corepack并安装Yarn
RUN corepack enable && \
    corepack prepare yarn@${YARN_VERSION} --activate

# 创建应用目录
WORKDIR /app

# 复制所有源代码（.dockerignore会过滤不需要的文件）
COPY . .

# 安装依赖
RUN yarn install --immutable --network-timeout 300000

# 运行naudiodon修复脚本
RUN node scripts/fix-naudiodon.js

# 生成ICO文件（如果需要）
RUN node scripts/generate-ico.js || true

# 构建应用
RUN yarn build

# 复制nginx配置
COPY docker/nginx.conf /etc/nginx/nginx.conf

# 复制supervisor配置
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 创建数据目录
RUN mkdir -p /app/data/config /app/data/logs /app/data/cache

# 设置权限
RUN chown -R www-data:www-data /app/data && \
    chmod -R 755 /app/data

# 暴露端口
EXPOSE 80

# 启动supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"] 