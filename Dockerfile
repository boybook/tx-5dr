# TX-5DR Docker Image - Multi-Architecture Support
# 使用多阶段构建来减小最终镜像大小
FROM node:22-slim AS builder

# 设置环境变量
ENV YARN_VERSION=4.9.1
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# 显示构建信息
RUN echo "Building for platform: $(uname -m)" && \
    echo "Node version: $(node --version)" && \
    echo "NPM version: $(npm --version)"

# 安装构建依赖
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-dev \
    pkg-config \
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
    libhamlib-dev \
    libhamlib4 \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# 启用Corepack并安装Yarn
RUN corepack enable && \
    corepack prepare yarn@${YARN_VERSION} --activate && \
    yarn --version

# 创建应用目录
WORKDIR /app

# 复制包管理文件以利用Docker缓存
COPY package.json yarn.lock turbo.json ./

# 复制Yarn配置和patch文件
COPY .yarnrc.yml ./
COPY .yarn/patches ./.yarn/patches/

# 复制scripts目录（postinstall脚本需要）
COPY scripts ./scripts/

# 创建packages目录结构并复制package.json文件
RUN mkdir -p packages/contracts packages/core packages/electron-main packages/electron-preload packages/server packages/shared-config packages/web
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/core/package.json ./packages/core/
COPY packages/electron-main/package.json ./packages/electron-main/
COPY packages/electron-preload/package.json ./packages/electron-preload/
COPY packages/server/package.json ./packages/server/
COPY packages/shared-config/package.json ./packages/shared-config/
COPY packages/web/package.json ./packages/web/

# 安装依赖（多架构优化）
RUN echo "Installing dependencies for $(uname -m)..." && \
    yarn install --immutable --network-timeout 300000 || { \
        echo "Immutable install failed, trying fallback..." && \
        yarn install --network-timeout 300000; \
    }

# 复制源代码
COPY . .

# 运行naudiodon修复脚本
RUN node scripts/fix-naudiodon.js

# 生成ICO文件（如果需要）
RUN node scripts/generate-ico.js || true

# 构建应用
RUN echo "Building application for $(uname -m)..." && \
    yarn build

# 清理不必要的文件但保留生产依赖
RUN yarn cache clean && \
    rm -rf .yarn/cache .yarn/unplugged && \
    rm -rf packages/*/src packages/*/test && \
    rm -rf scripts/generate-ico.js scripts/fix-naudiodon.js && \
    rm -rf node_modules/.cache \
    packages/*/node_modules/.cache

# 运行时镜像
FROM node:22-slim

# 设置环境变量
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# 安装运行时依赖
RUN apt-get update && apt-get install -y \
    libasound2 \
    libpulse0 \
    libx11-6 \
    libxrandr2 \
    libxinerama1 \
    libxcursor1 \
    libjack-jackd2-0 \
    libportaudio2 \
    libxi6 \
    libxext6 \
    libhamlib4 \
    nginx \
    supervisor \
    gosu \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && apt-get autoremove -y

# 创建应用目录
WORKDIR /app

# 从构建阶段复制构建产物和必要文件
COPY --from=builder /app/packages ./packages/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/yarn.lock ./yarn.lock
COPY --from=builder /app/turbo.json ./turbo.json

# 复制配置文件
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 复制entrypoint脚本
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 创建数据目录
RUN mkdir -p /app/data/config /app/data/logs /app/data/cache

# 设置权限
RUN chown -R www-data:www-data /app/data && \
    chmod -R 755 /app/data

# 暴露端口
EXPOSE 80

# 设置entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# 默认启动supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"] 