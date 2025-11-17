# Docker 自动构建和部署指南

本文档说明如何配置 TX-5DR 项目的 Docker 镜像自动构建和部署功能。

## 📋 目录

- [概述](#概述)
- [配置 GitHub Secrets](#配置-github-secrets)
- [自动构建触发条件](#自动构建触发条件)
- [镜像标签策略](#镜像标签策略)
- [使用 Docker 镜像](#使用-docker-镜像)
- [手动构建](#手动构建)
- [故障排除](#故障排除)

## 概述

TX-5DR 项目已配置 GitHub Actions 自动构建 Docker 镜像，支持以下特性：

- ✅ 多架构支持：`linux/amd64`、`linux/arm64`、`linux/arm/v8` (树莓派)
- ✅ 自动发布到 Docker Hub
- ✅ 构建缓存优化，提升构建速度
- ✅ 自动更新 Docker Hub 仓库描述
- ✅ 支持手动触发构建
- ✅ 完全容器化构建，避免原生依赖问题

## 配置 GitHub Secrets

要启用自动构建和发布，需要在 GitHub 仓库中配置以下 Secrets：

### 1. 获取 Docker Hub 访问令牌

1. 登录 [Docker Hub](https://hub.docker.com/)
2. 进入 [Security Settings](https://hub.docker.com/settings/security)
3. 点击 **New Access Token**
4. 输入令牌描述（例如：`TX-5DR GitHub Actions`）
5. 选择权限：**Read, Write, Delete**
6. 复制生成的访问令牌（只显示一次！）

### 2. 在 GitHub 仓库中添加 Secrets

1. 进入 GitHub 仓库页面
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret** 添加以下两个 secrets：

| Secret 名称 | 值 | 说明 |
|------------|-----|------|
| `DOCKER_HUB_USERNAME` | 你的 Docker Hub 用户名 | 例如：`boybook` |
| `DOCKER_HUB_TOKEN` | 在第1步获取的访问令牌 | 完整的令牌字符串 |

### 3. 验证配置

配置完成后，推送代码到 `main` 分支，GitHub Actions 将自动开始构建。你可以在仓库的 **Actions** 标签页查看构建进度。

## 自动构建触发条件

Docker 镜像会在以下情况下自动构建：

### 1. 推送到 main 分支

```bash
git push origin main
```

每次代码合并到 `main` 分支时，会自动触发构建并推送以下标签：
- `latest` - 主分支的最新版本
- `<commit-sha>` - Git 提交的短 SHA（前7位）

### 2. 手动触发

在 GitHub 仓库页面：
1. 点击 **Actions** 标签
2. 选择 **Build and Push Docker Image** workflow
3. 点击 **Run workflow**
4. 可选：输入自定义标签（如 `v1.0.0`）
5. 点击 **Run workflow** 确认

## 镜像标签策略

| 标签类型 | 示例 | 说明 |
|---------|------|------|
| `latest` | `boybook/tx-5dr:latest` | main 分支的最新构建 |
| Git SHA | `boybook/tx-5dr:a1b2c3d` | 对应 Git 提交的镜像 |
| 自定义标签 | `boybook/tx-5dr:v1.0.0` | 手动触发时指定的标签 |

## 使用 Docker 镜像

### 方式一：docker run（快速启动）

```bash
# 拉取最新镜像
docker pull boybook/tx-5dr:latest

# 运行容器
docker run -d \
  -p 8076:80 \
  --name tx-5dr \
  -v $(pwd)/data:/app/data \
  --device /dev/snd:/dev/snd \
  boybook/tx-5dr:latest
```

### 方式二：docker-compose（推荐）

更新 `docker-compose.yml` 中的镜像名称：

```yaml
services:
  tx5dr:
    image: boybook/tx-5dr:latest  # 使用发布的镜像，而不是本地构建
    # ... 其他配置保持不变
```

然后启动：

```bash
# 拉取最新镜像并启动
docker-compose pull
docker-compose up -d

# 查看日志
docker-compose logs -f
```

### 访问应用

启动后，在浏览器访问：
- **本地**: http://localhost:8076
- **局域网**: http://[你的IP地址]:8076

## 手动构建

### 本地快速构建（单架构）

```bash
# 使用快速构建脚本（构建当前架构）
yarn docker:build

# 或指定标签
./scripts/docker-quick-build.sh my-custom-tag
```

### 本地多架构构建

```bash
# 构建并推送多架构镜像
yarn docker:build-and-push

# 或使用脚本
./scripts/build-docker.sh boybook tx-5dr v1.0.0 true

# 只更新 Docker Hub README
./scripts/build-docker.sh --readme-only boybook tx-5dr
```

## 故障排除

### 问题 1：GitHub Actions 构建失败 - 认证错误

**错误信息**：
```
Error: denied: requested access to the resource is denied
```

**解决方法**：
1. 检查 `DOCKER_HUB_USERNAME` 和 `DOCKER_HUB_TOKEN` 是否正确设置
2. 确认 Docker Hub 令牌权限包含 **Read, Write, Delete**
3. 验证 Docker Hub 仓库已创建（首次需要手动创建仓库）

### 问题 2：多架构构建时间过长

**说明**：多架构构建（amd64 + arm64）通常需要 30-60 分钟，这是正常的。

**优化方法**：
- GitHub Actions 已配置构建缓存，后续构建会更快
- 避免频繁修改依赖项，复用缓存层

**技术说明**：
- 所有依赖安装和应用构建都在 Docker 容器内完成
- GitHub Actions 不需要安装 Node.js 或其他系统依赖
- Dockerfile 内部处理所有原生模块（如 naudiodon2）的编译

### 问题 3：树莓派上拉取镜像失败 - 平台不匹配

**错误信息**：
```
no matching manifest for linux/arm/v8 in the manifest list entries
```

**原因**：
树莓派的 Docker 期望 `linux/arm/v8` 平台标识，但旧版本镜像只包含 `linux/arm64`。

**解决方法**：
1. **使用最新镜像**（推荐）：最新版本已包含 `linux/arm/v8` 支持
   ```bash
   docker pull boybook/tx-5dr:latest
   ```

2. **手动指定平台**（临时方案）：
   ```bash
   docker pull --platform linux/arm64 boybook/tx-5dr:latest
   ```

3. **验证支持的平台**：
   ```bash
   docker manifest inspect boybook/tx-5dr:latest | grep -A 5 platform
   ```

### 问题 4：本地无法拉取镜像 - 权限问题

**错误信息**：
```
Error response from daemon: pull access denied
```

**解决方法**：
1. 确认镜像已成功推送到 Docker Hub
2. 检查镜像名称和标签是否正确
3. 对于私有仓库，需要先登录：
   ```bash
   docker login
   ```

### 问题 5：容器启动失败 - 音频设备

**错误信息**：
```
ALSA: Cannot open audio device
```

**解决方法**：
```bash
# Linux 系统需要添加音频设备权限
docker run -d \
  -p 8076:80 \
  --name tx-5dr \
  --device /dev/snd:/dev/snd \
  --group-add audio \
  boybook/tx-5dr:latest
```

### 问题 6：README 更新失败

**说明**：README 更新失败不影响镜像构建，workflow 会继续执行。

**可能原因**：
- Docker Hub API 限制
- 权限不足

**解决方法**：
- 使用手动脚本更新：
  ```bash
  export DOCKER_HUB_TOKEN="your-token"
  ./scripts/build-docker.sh --readme-only boybook tx-5dr
  ```

## 相关文档

- [Docker Hub 仓库](https://hub.docker.com/r/boybook/tx-5dr)
- [项目 README](../README.md)
- [开发指南](../CLAUDE.md)

## 技术细节

### Dockerfile 说明

- **多阶段构建**：builder 阶段编译，runtime 阶段运行，减小镜像大小
- **依赖项**：包含音频处理库（ALSA, PulseAudio, PortAudio）和 hamlib
- **服务管理**：使用 supervisor 管理 Node.js 后端和 nginx 前端

### 架构支持

| 架构 | 说明 | 适用设备 |
|------|------|---------|
| `linux/amd64` | x86-64 | 大多数服务器、台式机、笔记本 |
| `linux/arm64` | ARM 64位 | Apple Silicon Mac、ARM 服务器 |
| `linux/arm/v8` | ARM v8 64位 | 树莓派 4/5、其他 ARMv8 设备 |

**注意**：`linux/arm64` 和 `linux/arm/v8` 在技术上是相同的架构，但 Docker 在不同设备上可能使用不同的平台标识。TX-5DR 镜像同时支持两种标识，确保在所有 ARM64 设备上都能正常拉取。

### 构建缓存策略

GitHub Actions 使用 Docker registry 缓存：
- **缓存标签**：`buildcache`
- **缓存模式**：`mode=max`（缓存所有层）
- **自动失效**：代码变更时相关缓存层自动重建

## 需要帮助？

如果遇到问题，请：
1. 查看 [GitHub Actions 运行日志](../../actions)
2. 检查 [Docker Hub 仓库页面](https://hub.docker.com/r/boybook/tx-5dr)
3. 在项目仓库提交 Issue
