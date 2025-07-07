#!/bin/bash

# TX-5DR Quick Docker Build Script
# 快速构建本地Docker镜像（当前架构）

set -e

# 默认配置
DEFAULT_TAG="tx-5dr:latest"
TAG=${1:-$DEFAULT_TAG}

echo "🚀 TX-5DR Quick Docker Build"
echo "================================"
echo "Building image: $TAG"
echo "Platform: $(uname -m)"
echo "================================"

# 检查Docker是否运行
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop."
    exit 1
fi

# 生成ICO文件
echo "🎨 Generating ICO file..."
node scripts/generate-ico.js || {
    echo "⚠️  ICO generation failed, continuing..."
}

# 构建Docker镜像
echo "🏗️  Building Docker image..."
docker build -t $TAG . || {
    echo "❌ Build failed!"
    exit 1
}

# 显示镜像大小信息
echo ""
echo "📊 Image size information:"
docker images $TAG --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

echo ""
echo "✅ Build completed successfully!"
echo "🐳 Image: $TAG"
echo ""
echo "📋 Run the container:"
echo "  docker run -d -p 8080:80 --name tx-5dr $TAG"
echo ""
echo "📋 Stop and remove:"
echo "  docker stop tx-5dr && docker rm tx-5dr"
echo ""
echo "📋 View logs:"
echo "  docker logs tx-5dr" 