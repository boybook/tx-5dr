#!/bin/bash

# TX-5DR Docker Multi-Architecture Build Script
# 支持构建 linux/amd64 和 linux/arm64 架构的Docker镜像

set -e

# 默认配置
DEFAULT_REGISTRY="boybook"
DEFAULT_IMAGE_NAME="tx-5dr"
DEFAULT_TAG="latest"
DEFAULT_PUSH="false"
DEFAULT_UPDATE_README="true"

# 初始化变量
REGISTRY=""
IMAGE_NAME=""
TAG=""
PUSH=""
UPDATE_README=""
README_ONLY="false"
NO_BUILD="false"

# 帮助信息
show_help() {
    cat << EOF
TX-5DR Docker Multi-Architecture Build Script

Usage: $0 [OPTIONS] [REGISTRY] [IMAGE_NAME] [TAG] [PUSH]

Arguments:
  REGISTRY     Docker Hub username/organization (default: $DEFAULT_REGISTRY)
  IMAGE_NAME   Image name (default: $DEFAULT_IMAGE_NAME)
  TAG          Image tag (default: $DEFAULT_TAG)
  PUSH         Push to Docker Hub: true/false (default: $DEFAULT_PUSH)

Options:
  --help              Show this help message
  --readme-only       Only update Docker Hub README, skip building
  --no-readme         Skip README update
  --no-build          Skip building (useful with --readme-only)

Examples:
  # Build and push with default settings
  $0 boybook tx-5dr latest true

  # Only update README
  $0 --readme-only boybook tx-5dr

  # Build without updating README
  $0 --no-readme boybook tx-5dr v1.0.0 true

Environment Variables:
  DOCKER_HUB_TOKEN    Docker Hub access token for README updates
  DOCKER_HUB_USERNAME Docker Hub username (if different from REGISTRY)

EOF
}

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            show_help
            exit 0
            ;;
        --readme-only)
            README_ONLY="true"
            NO_BUILD="true"
            shift
            ;;
        --no-readme)
            UPDATE_README="false"
            shift
            ;;
        --no-build)
            NO_BUILD="true"
            shift
            ;;
        -*)
            echo "Unknown option $1"
            show_help
            exit 1
            ;;
        *)
            if [ -z "$REGISTRY" ]; then
                REGISTRY="$1"
            elif [ -z "$IMAGE_NAME" ]; then
                IMAGE_NAME="$1"
            elif [ -z "$TAG" ]; then
                TAG="$1"
            elif [ -z "$PUSH" ]; then
                PUSH="$1"
            else
                echo "Too many arguments"
                show_help
                exit 1
            fi
            shift
            ;;
    esac
done

# 设置默认值
REGISTRY=${REGISTRY:-$DEFAULT_REGISTRY}
IMAGE_NAME=${IMAGE_NAME:-$DEFAULT_IMAGE_NAME}
TAG=${TAG:-$DEFAULT_TAG}
PUSH=${PUSH:-$DEFAULT_PUSH}
UPDATE_README=${UPDATE_README:-$DEFAULT_UPDATE_README}

# 完整镜像名称
FULL_IMAGE_NAME="${REGISTRY}/${IMAGE_NAME}:${TAG}"

# Docker Hub README更新函数
update_readme() {
    local readme_file="docker/README.md"
    local username=${DOCKER_HUB_USERNAME:-$REGISTRY}
    local token=${DOCKER_HUB_TOKEN}
    
    echo "📝 Updating Docker Hub README..."
    
    # 检查README文件是否存在
    if [ ! -f "$readme_file" ]; then
        echo "❌ README file not found: $readme_file"
        return 1
    fi
    
    # 检查Docker Hub token
    if [ -z "$token" ]; then
        echo "❌ DOCKER_HUB_TOKEN environment variable not set"
        echo "   Please set your Docker Hub access token:"
        echo "   export DOCKER_HUB_TOKEN='your-token-here'"
        echo "   Get your token from: https://hub.docker.com/settings/security"
        return 1
    fi
    
    # 检查jq是否可用
    if ! command -v jq &> /dev/null; then
        echo "❌ jq is required but not installed. Please install jq first."
        echo "   macOS: brew install jq"
        echo "   Ubuntu/Debian: sudo apt-get install jq"
        return 1
    fi
    
    # 读取README内容并转义JSON
    local readme_content=$(cat "$readme_file" | jq -R -s .)
    
    # 准备API请求数据
    local json_data=$(cat <<EOF
{
    "full_description": $readme_content
}
EOF
)
    
    # 发送API请求
    local response=$(curl -s -w "\n%{http_code}" \
        -X PATCH \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$json_data" \
        "https://hub.docker.com/v2/repositories/$username/$IMAGE_NAME/")
    
    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "200" ]; then
        echo "✅ README updated successfully on Docker Hub"
        echo "   View at: https://hub.docker.com/r/$username/$IMAGE_NAME"
        return 0
    else
        echo "❌ Failed to update README. HTTP code: $http_code"
        echo "Response: $body"
        return 1
    fi
}

echo "🚀 TX-5DR Docker Multi-Architecture Build"
echo "=================================================="
echo "Registry: ${REGISTRY}"
echo "Image: ${IMAGE_NAME}"
echo "Tag: ${TAG}"
echo "Full Name: ${FULL_IMAGE_NAME}"
echo "Push: ${PUSH}"
echo "Update README: ${UPDATE_README}"
echo "README Only: ${README_ONLY}"
echo "=================================================="

# 处理README_ONLY模式
if [ "$README_ONLY" = "true" ]; then
    echo "📝 README-only mode: Updating Docker Hub README..."
    update_readme
    exit $?
fi

# 检查Docker是否运行
if [ "$NO_BUILD" = "false" ] && ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop."
    exit 1
fi

# 检查是否已登录Docker Hub（如果需要推送）
if [ "$PUSH" = "true" ] && [ "$NO_BUILD" = "false" ]; then
    echo "🔐 Checking Docker Hub authentication..."
    if ! docker system info | grep -q "Username"; then
        echo "⚠️  Not logged in to Docker Hub. Please run: docker login"
        read -p "Do you want to login now? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker login
        else
            echo "❌ Cannot push without authentication. Exiting."
            exit 1
        fi
    fi
fi

# 跳过构建步骤如果NO_BUILD为true
if [ "$NO_BUILD" = "true" ]; then
    echo "⏭️  Skipping build step (NO_BUILD=true)"
else
    # 创建或使用buildx构建器
    echo "🛠️  Setting up buildx..."
    BUILDER_NAME="tx5dr-builder"

    if docker buildx inspect $BUILDER_NAME > /dev/null 2>&1; then
        echo "✅ Using existing builder: $BUILDER_NAME"
        docker buildx use $BUILDER_NAME
    else
        echo "🆕 Creating new builder: $BUILDER_NAME"
        docker buildx create --name $BUILDER_NAME --use --bootstrap
    fi

    # 确保构建器支持所需的平台
    echo "🔍 Checking supported platforms..."
    docker buildx inspect --bootstrap

    # 预构建步骤：生成ICO文件
    echo "🎨 Generating ICO file..."
    node scripts/generate-ico.js || {
        echo "⚠️  ICO generation failed, continuing without it..."
    }

    # 构建多架构镜像
    echo "🏗️  Building multi-architecture Docker image..."
    PLATFORMS="linux/amd64,linux/arm64"

    BUILD_ARGS=""
    if [ "$PUSH" = "true" ]; then
        BUILD_ARGS="--push"
    else
        BUILD_ARGS="--load"
        echo "⚠️  Note: Multi-arch images can only be loaded locally for a single platform"
        echo "    For testing, we'll build for current platform only"
        PLATFORMS=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
    fi

    # 构建命令
    docker buildx build \
        --platform $PLATFORMS \
        --tag $FULL_IMAGE_NAME \
        --file Dockerfile \
        $BUILD_ARGS \
        . || {
        echo "❌ Build failed!"
        exit 1
    }
fi

# 根据构建状态显示不同的输出
if [ "$NO_BUILD" = "true" ]; then
    echo "⏭️  Build step was skipped"
    if [ "$UPDATE_README" = "true" ]; then
        echo "📝 Updating Docker Hub README..."
        update_readme || {
            echo "⚠️  README update failed"
            exit 1
        }
        echo ""
    fi
    echo "🎉 README update completed successfully!"
elif [ "$PUSH" = "true" ]; then
    echo "✅ Successfully built and pushed multi-architecture image!"
    echo "🐳 Image: $FULL_IMAGE_NAME"
    echo "🏗️  Platforms: $PLATFORMS"
    echo ""
    
    # 更新Docker Hub README
    if [ "$UPDATE_README" = "true" ]; then
        echo "📝 Updating Docker Hub README..."
        update_readme || {
            echo "⚠️  README update failed, but build was successful"
        }
        echo ""
    fi
    
    echo "📋 Usage:"
    echo "  docker run -d -p 8080:80 $FULL_IMAGE_NAME"
    echo "  docker-compose up -d  # (update docker-compose.yml with new image)"
    echo ""
    echo "🎉 Build and push completed successfully!"
else
    echo "✅ Successfully built image for local testing!"
    echo "🐳 Image: $FULL_IMAGE_NAME"
    echo ""
    echo "📋 Test locally:"
    echo "  docker run -d -p 8080:80 $FULL_IMAGE_NAME"
    echo ""
    echo "📤 To push to Docker Hub:"
    echo "  $0 $REGISTRY $IMAGE_NAME $TAG true"
    echo ""
    echo "🎉 Build completed successfully!"
fi 