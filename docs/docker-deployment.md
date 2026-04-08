# Docker 部署与镜像构建指南

本文档说明如何在 Linux / Debian / 虚拟机环境中更稳健地部署 TX-5DR，并补充 Docker 镜像的构建与发布说明。

## 目录

- [适用场景](#适用场景)
- [推荐启动流程](#推荐启动流程)
- [部署前检查](#部署前检查)
- [推荐的 Compose 配置要点](#推荐的-compose-配置要点)
- [分阶段启动步骤](#分阶段启动步骤)
- [更新与重建](#更新与重建)
- [故障排查](#故障排查)
- [镜像自动构建与发布](#镜像自动构建与发布)
- [手动构建](#手动构建)

## 适用场景

本文档特别适用于以下部署方式：

- 宿主机为 Debian 12+ / Ubuntu 22.04+
- 运行在 PVE / ESXi / VMware 等虚拟机中
- 使用 `docker compose` 部署
- 通过 USB 直通连接电台（USB 声卡 + USB 串口 / CAT）
- 需要浏览器访问 Web UI，并启用 LiveKit 实时音频能力

如果你只需要最短路径，请直接阅读“推荐启动流程”和“故障排查”两节。

## 推荐启动流程

推荐使用“先检查宿主机设备，再分阶段启动容器”的方式，而不是第一次就直接 `docker compose up -d`。

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}

# 发布镜像方式

docker compose pull

# 如果你是基于当前仓库本地构建，请在更新代码后重建
# docker compose build --no-cache

# 1) 先生成 / 校验 LiveKit 凭据和配置

docker compose run --rm livekit-init

# 2) 再启动 livekit 侧车并观察日志

docker compose up -d livekit
docker compose logs -f livekit

# 3) 最后启动主应用

docker compose up -d tx5dr
docker compose logs -f tx5dr

# 4) 获取管理员令牌

docker exec tx5dr cat /app/data/config/.admin-token
```

这样做的好处：

- `livekit-init` 失败时，不会把问题和主应用混在一起
- `livekit` 端口 / 配置异常可以单独定位
- `tx5dr` 主容器启动失败时，更容易从 `supervisor`、音频设备、串口设备三个方向快速排查

## 部署前检查

### 1. 确认宿主机已经识别到 USB 设备

在虚拟机或物理宿主机内执行：

```bash
lsusb
aplay -l
arecord -l
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true
ls -l /dev/serial/by-id 2>/dev/null || true
```

重点判断：

- 是否能看到 USB 声卡（例如 C-Media）
- 是否出现串口节点（如 `/dev/ttyUSB0`、`/dev/ttyUSB1`）
- 如果只看到了 `lsusb`，但没有 `/dev/ttyUSB*`，说明 USB 总线可见，但串口驱动或设备节点还没有准备好

### 2. 确认 Docker 版本满足 Compose V2

```bash
docker --version
docker compose version
```

建议使用：

- Docker Engine 24+
- `docker compose` 插件版本 2.20+

### 3. 确认部署目录权限

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}
ls -ld data data/*
```

建议确保当前执行 `docker compose` 的用户对 `./data` 有读写权限。

### 4. 如果使用 PulseAudio，先确认是否真的需要

TX-5DR 在 Docker 内优先建议使用 ALSA / `/dev/snd`。PulseAudio 映射属于可选项：

- 本机桌面 Linux 需要复用宿主机用户会话音频时，可以保留
- 无头服务器、PVE 虚拟机、纯 USB 声卡场景，通常可以先不启用 PulseAudio 映射，避免把无关变量带进排障流程

## 推荐的 Compose 配置要点

仓库根目录的 `docker-compose.yml` 已包含一个可用基线。下面是和稳健启动关系最强的几点说明。

### 1. 持久化目录

至少保留下列挂载：

- `./data/config:/app/data/config`
- `./data/plugins:/app/data/plugins`
- `./data/logs:/app/data/logs`
- `./data/cache:/app/data/cache`
- `./data/realtime:/app/data/realtime`

这样可以避免：

- 重启后管理员令牌丢失
- LiveKit 凭据每次重新生成
- 日志丢失导致无法回溯问题

### 2. USB 总线不等于串口节点

这是 Docker 部署中最常见的误区之一。

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
```

这只能保证容器看见原始 USB 总线；如果电台 CAT 控制依赖宿主机生成的 `/dev/ttyUSB0`、`/dev/ttyUSB1`，你通常还需要额外映射具体串口设备：

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/ttyUSB0:/dev/ttyUSB0:rwm
  - /dev/ttyUSB1:/dev/ttyUSB1:rwm
```

对像 Yaesu FT-710 这类通过 CP2105 暴露双串口的电台，实际使用前建议先在宿主机确认哪个 `ttyUSB` 对应 CAT 控制。

### 3. `/dev/serial/by-id` 适合做“稳定命名”，但不是替代品

如果你希望在容器内也看到稳定的设备名称，可以额外挂载：

```yaml
volumes:
  - /dev/serial/by-id:/dev/serial/by-id:ro
```

但请注意：

- 这通常只是符号链接目录
- 它不能替代 `/dev/ttyUSB0` 等实际字符设备映射
- 如果目标 tty 节点本身没有映射进容器，符号链接仍然不可用

### 4. 音频设备建议保留 `/dev/snd`

```yaml
volumes:
  - /dev/snd:/dev/snd:rw

devices:
  - /dev/snd:/dev/snd:rwm

group_add:
  - audio
```

如果容器启动后仍然看不到声卡，请优先检查：

```bash
docker compose exec tx5dr ls -l /dev/snd
docker compose exec tx5dr aplay -l
```

### 5. LiveKit 端口开放原则

默认浏览器通过当前站点的同源 `/livekit` 路径进入 signaling，因此通常不需要直接暴露 `7880/tcp` 到公网。

但如果启用 LiveKit 主链路，仍需确保以下端口可达：

- `7881/tcp`
- `50000-50100/udp`

公网部署时，还要确认上层防火墙 / 安全组 / PVE 防火墙没有拦截这些端口。

## 分阶段启动步骤

### 第 1 步：准备目录

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}
```

### 第 2 步：更新镜像或重建本地镜像

```bash
# 使用发布镜像

docker compose pull

# 或：使用当前仓库本地构建
# docker compose build --no-cache
```

如果你此前构建过旧镜像，更新代码后建议至少重建一次，避免把旧的 `supervisor` 配置问题带进新部署。

### 第 3 步：先运行初始化容器

```bash
docker compose run --rm livekit-init
```

成功后可在宿主机确认：

```bash
ls -l data/realtime
```

通常会看到：

- `livekit-credentials.env`
- `livekit.yaml`

### 第 4 步：单独启动 LiveKit

```bash
docker compose up -d livekit
docker compose logs -f livekit
```

重点关注是否存在：

- 配置文件读取失败
- 端口占用
- UDP 端口绑定失败

### 第 5 步：再启动 TX-5DR 主容器

```bash
docker compose up -d tx5dr
docker compose logs -f tx5dr
```

首次排查时，重点看以下三类日志：

- `supervisord` / `supervisor` 配置解析错误
- `nginx` 启动失败
- Node.js 服务是否成功进入监听状态

### 第 6 步：进入容器验证设备

```bash
docker compose exec tx5dr sh -lc 'ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true'
docker compose exec tx5dr sh -lc 'ls -l /dev/snd || true'
docker compose exec tx5dr sh -lc 'cat /app/data/config/.admin-token 2>/dev/null || true'
```

如果 Web UI 能访问，但电台无法连接，通常已经不是容器启动问题，而是设备映射、串口权限或 Hamlib 配置问题。

## 更新与重建

### 更新发布镜像

```bash
docker compose pull
docker compose up -d
```

### 更新本地源码构建镜像

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

### 清理旧容器后重新部署

```bash
docker compose down
docker compose up -d
```

如果只是重新部署，不建议删除 `./data`，否则会丢失：

- 管理员令牌
- 配置文件
- 日志
- LiveKit 托管凭据

## 故障排查

### 问题 1：容器不断重启，Web 页面无法访问

先看日志：

```bash
docker compose logs --tail=200 tx5dr
```

如果看到 `supervisord` / `supervisor` 配置解析错误：

```text
Unexpected end of key/value pairs
```

通常说明你使用的是旧镜像或旧构建缓存。解决方式：

```bash
docker compose build --no-cache
# 或者

docker compose pull
```

然后重新启动。

### 问题 2：宿主机能 `lsusb`，但容器里没有 CAT 串口

现象：

- 宿主机能看到 USB 设备
- 容器内没有 `/dev/ttyUSB0`
- Web UI 启动正常，但电台 CAT 无法连接

原因：

- `/dev/bus/usb` 只暴露 USB 总线，不自动暴露宿主机创建的 tty 设备节点

解决方法：

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/ttyUSB0:/dev/ttyUSB0:rwm
  - /dev/ttyUSB1:/dev/ttyUSB1:rwm
```

然后重启容器并再次验证：

```bash
docker compose exec tx5dr sh -lc 'ls -l /dev/ttyUSB*'
```

### 问题 3：容器里能看到 `/dev/ttyUSB*`，但应用仍连接失败

请继续检查：

- 是否映射了正确的 CAT 端口，而不是调试 / 辅助端口
- 波特率、数据位、停止位、流控是否与电台设置一致
- 宿主机是否有其他进程占用了该串口
- Hamlib 机型与连接参数是否正确

宿主机上可先做基础验证：

```bash
ls -l /dev/serial/by-id
```

### 问题 4：容器启动了，但没有音频设备

```bash
docker compose exec tx5dr sh -lc 'ls -l /dev/snd || true'
docker compose exec tx5dr aplay -l
```

如果失败，检查：

- 虚拟机内部是否已经识别到声卡
- compose 是否保留了 `/dev/snd` 的 `volumes` 和 `devices` 映射
- 是否加入了 `audio` 组
- PVE / VM 直通后设备是否在重启后发生变化

### 问题 5：LiveKit 正常，主应用正常，但浏览器语音仍不可用

请依次确认：

- 浏览器访问的入口域名是否能同源代理 `/livekit`
- `7881/tcp` 与 `50000-50100/udp` 是否对客户端可达
- 若有反向代理 / CDN / TLS 终止，是否正确转发 WebSocket 与媒体流
- 若当前拓扑无法保证同源 `/livekit`，请在系统设置中配置“自定义实时语音入口”

### 问题 6：首次启动正常，重启后权限异常

这通常与宿主机挂载目录归属或设备节点变化有关。建议检查：

```bash
ls -ld data data/*
docker compose exec tx5dr id
docker compose exec tx5dr sh -lc 'ls -l /dev/ttyUSB* /dev/snd 2>/dev/null || true'
```

## 镜像自动构建与发布

项目已配置 GitHub Actions 自动构建 Docker 镜像，支持：

- 多架构：`linux/amd64`、`linux/arm64`、`linux/arm/v8`
- 自动推送到 Docker Hub
- 构建缓存优化
- 自动更新 Docker Hub 描述
- 手动触发构建

### 需要配置的 GitHub Secrets

| Secret 名称 | 说明 |
|------------|------|
| `DOCKER_HUB_USERNAME` | Docker Hub 用户名 |
| `DOCKER_HUB_TOKEN` | Docker Hub Access Token |

### 自动构建触发条件

- 推送到 `main` 分支
- 在 GitHub Actions 页面手动触发 workflow

### 镜像标签策略

| 标签类型 | 示例 | 说明 |
|---------|------|------|
| `latest` | `boybook/tx-5dr:latest` | 主分支最新构建 |
| Git SHA | `boybook/tx-5dr:a1b2c3d` | 对应提交版本 |
| 自定义标签 | `boybook/tx-5dr:v1.0.0` | 手动触发时指定 |

## 手动构建

### 本地快速构建（单架构）

```bash
yarn docker:build

# 或指定标签
./scripts/docker-quick-build.sh my-custom-tag
```

### 本地多架构构建

```bash
yarn docker:build-and-push

# 或使用脚本
./scripts/build-docker.sh boybook tx-5dr v1.0.0 true

# 只更新 Docker Hub README
./scripts/build-docker.sh --readme-only boybook tx-5dr
```

## 相关文档

- [项目 README（中文）](../README.zh-CN.md)
- [项目 README（英文）](../README.md)
- [Docker Hub 仓库](https://hub.docker.com/r/boybook/tx-5dr)
- [根目录 Compose 文件](../docker-compose.yml)
