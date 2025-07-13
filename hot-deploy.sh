#!/bin/bash

# 热部署脚本 - 将本地构建产物复制到容器中
echo "🚀 开始热部署..."

# 检查容器是否运行
if ! docker compose ps | grep -q "tx5dr.*Up"; then
    echo "❌ 容器未运行，请先启动容器："
    echo "   docker compose up -d"
    exit 1
fi

# 确保本地构建是最新的
echo "🔨 构建最新代码..."
yarn build

if [ $? -ne 0 ]; then
    echo "❌ 构建失败"
    exit 1
fi

echo "📦 复制构建产物到容器..."

# 复制server构建产物
echo "  复制 packages/server/dist/ ..."
docker cp packages/server/dist/. tx5dr:/app/packages/server/dist/

# 复制web构建产物  
echo "  复制 packages/web/dist/ ..."
docker cp packages/web/dist/. tx5dr:/app/packages/web/dist/

# 复制其他构建产物
for pkg in contracts core electron-main electron-preload shared-config; do
    if [ -d "packages/$pkg/dist" ]; then
        echo "  复制 packages/$pkg/dist/ ..."
        docker cp packages/$pkg/dist/. tx5dr:/app/packages/$pkg/dist/
    fi
done

echo "🔄 重启容器服务..."
# 重启容器以应用更改
docker compose restart tx5dr

echo "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
if docker compose ps | grep -q "tx5dr.*Up"; then
    echo "✅ 热部署完成！"
    echo "🌐 应用地址: http://localhost:8076"
    echo "📋 查看日志: docker compose logs -f tx5dr"
else
    echo "❌ 服务启动失败，请检查日志:"
    echo "   docker compose logs tx5dr"
fi 