# TX-5DR Docker Deployment Guide / Docker 部署指南

[English](#english) | [中文](#中文)

---

## English

### Quick Start

Image: `boybook/tx-5dr:latest` ([Docker Hub](https://hub.docker.com/r/boybook/tx-5dr))

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}

docker compose pull

# 1) Generate LiveKit credentials (first run only, reused on restarts)
docker compose run --rm livekit-init

# 2) Start LiveKit sidecar
docker compose up -d livekit
docker compose logs -f livekit    # verify it started cleanly, then Ctrl-C

# 3) Start TX-5DR
docker compose up -d tx5dr
docker compose logs -f tx5dr      # verify nginx + tx5dr-server are RUNNING

# 4) Get admin token
docker exec tx5dr cat /app/data/config/.admin-token
```

Open `http://<host>:8076` and log in with the admin token.

### Compose Configuration

The repository root [`docker-compose.yml`](../docker-compose.yml) is the single source of truth. It defines three services:

| Service | Purpose |
|---------|---------|
| `livekit-init` | One-shot init container: generates LiveKit credentials and config into `./data/realtime/` |
| `livekit` | LiveKit signaling + media server |
| `tx5dr` | Main application (nginx + tx5dr-server via supervisor) |

Edit `docker-compose.yml` to match your hardware before starting.

### Device Mapping (Critical)

#### Serial Ports (CAT Control)

**`/dev/bus/usb` alone is NOT enough for serial CAT control.** You must also map the actual tty device nodes created by the host.

Check available devices on the host first:

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
ls -l /dev/serial/by-id/ 2>/dev/null
```

Common device types:

| Device | Typical Hardware | Example |
|--------|-----------------|---------|
| `/dev/ttyUSB*` | CP2102, CH340, FTDI USB-Serial adapters | Yaesu FT-710, Elecraft K3 |
| `/dev/ttyACM*` | USB CDC ACM (native USB) | ICOM IC-705, IC-7300 |

Add the matching entries to the `devices:` section:

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/snd:/dev/snd:rwm
  # Uncomment and adjust for your hardware:
  - /dev/ttyUSB0:/dev/ttyUSB0:rwm
  - /dev/ttyUSB1:/dev/ttyUSB1:rwm
  # or for ICOM / CDC ACM devices:
  - /dev/ttyACM0:/dev/ttyACM0:rwm
  - /dev/ttyACM1:/dev/ttyACM1:rwm
```

#### Audio Devices

The compose file maps `/dev/snd` for ALSA access. Verify on the host:

```bash
aplay -l    # playback devices
arecord -l  # capture devices
```

Both volume and device mappings are needed:

```yaml
volumes:
  - /dev/snd:/dev/snd:rw
devices:
  - /dev/snd:/dev/snd:rwm
```

#### Permission Groups

Two groups must be declared in `group_add:` for the container process to access hardware:

```yaml
group_add:
  - audio     # /dev/snd access
  - dialout   # /dev/ttyUSB*, /dev/ttyACM* access
```

Both are required. Missing `audio` causes the audio device list to show only "Default"; missing `dialout` causes "Permission denied" when connecting to the radio.

### LiveKit Networking

| Port | Protocol | Purpose |
|------|----------|---------|
| 7881 | TCP | RTC media transport |
| 50000-50100 | UDP | Media port range |

Browser clients connect via the site's same-origin `/livekit` path for signaling, so `7880/tcp` does not need to be exposed publicly. If your reverse proxy or domain setup prevents this, configure a custom realtime voice entrypoint in System Settings.

### Updating

```bash
# Pull latest images
docker compose pull
docker compose up -d

# Or rebuild from local source
git pull
docker compose build --no-cache
docker compose up -d
```

Do not delete `./data/` when redeploying — it contains your config, admin token, LiveKit credentials, and logs.

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/api/radio/serial-ports` returns 500 | `udevadm` missing in image | Upgrade to latest image, or `apt-get install udev` inside container |
| Serial port "Permission denied" | Process lacks `dialout` group | Add `dialout` to `group_add:` in compose, rebuild container |
| Audio devices show only "Default" | Process lacks `audio` group | Add `audio` to `group_add:` in compose, rebuild container |
| Container keeps restarting | `supervisord` config error | `docker compose build --no-cache` or `docker compose pull` |
| Host sees USB but container has no tty | Only `/dev/bus/usb` mapped | Map concrete `/dev/ttyUSB*` or `/dev/ttyACM*` nodes in `devices:` |
| Radio CAT connects but no audio | USB sound card not mapped | Check `aplay -l` on host, map `/dev/snd` in both `volumes:` and `devices:` |

### Related Documentation

- [`docker-compose.yml`](../docker-compose.yml) — Compose baseline configuration
- [`docs/docker-deployment.md`](../docs/docker-deployment.md) — Advanced guide (VM passthrough, CI/CD, manual builds)
- [Docker Hub](https://hub.docker.com/r/boybook/tx-5dr)

---

## 中文

### 快速开始

镜像：`boybook/tx-5dr:latest`（[Docker Hub](https://hub.docker.com/r/boybook/tx-5dr)）

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}

docker compose pull

# 1) 生成 LiveKit 凭据（仅首次运行，后续自动复用）
docker compose run --rm livekit-init

# 2) 启动 LiveKit 侧车
docker compose up -d livekit
docker compose logs -f livekit    # 确认正常启动后 Ctrl-C

# 3) 启动 TX-5DR 主容器
docker compose up -d tx5dr
docker compose logs -f tx5dr      # 确认 nginx + tx5dr-server 均为 RUNNING

# 4) 获取管理员令牌
docker exec tx5dr cat /app/data/config/.admin-token
```

浏览器访问 `http://<host>:8076`，使用管理员令牌登录。

### Compose 配置说明

仓库根目录的 [`docker-compose.yml`](../docker-compose.yml) 是唯一配置源，定义了三个服务：

| 服务 | 作用 |
|------|------|
| `livekit-init` | 一次性初始化容器：生成 LiveKit 凭据和配置到 `./data/realtime/` |
| `livekit` | LiveKit 信令 + 媒体服务器 |
| `tx5dr` | 主应用（nginx + tx5dr-server，通过 supervisor 管理） |

启动前请根据你的硬件编辑 `docker-compose.yml`。

### 设备映射（关键）

#### 串口设备（CAT 控制）

**仅映射 `/dev/bus/usb` 不够！** 必须同时映射宿主机创建的实际 tty 设备节点。

先在宿主机上确认可用设备：

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
ls -l /dev/serial/by-id/ 2>/dev/null
```

常见设备类型：

| 设备 | 典型硬件 | 举例 |
|------|---------|------|
| `/dev/ttyUSB*` | CP2102、CH340、FTDI 等 USB 转串口芯片 | Yaesu FT-710、Elecraft K3 |
| `/dev/ttyACM*` | USB CDC ACM（原生 USB） | ICOM IC-705、IC-7300 |

在 `devices:` 段添加对应条目：

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/snd:/dev/snd:rwm
  # 根据实际硬件取消注释并修改：
  - /dev/ttyUSB0:/dev/ttyUSB0:rwm
  - /dev/ttyUSB1:/dev/ttyUSB1:rwm
  # 或 ICOM / CDC ACM 类设备：
  - /dev/ttyACM0:/dev/ttyACM0:rwm
  - /dev/ttyACM1:/dev/ttyACM1:rwm
```

#### 音频设备

Compose 文件通过映射 `/dev/snd` 提供 ALSA 访问。先在宿主机确认：

```bash
aplay -l    # 播放设备
arecord -l  # 录音设备
```

需要同时挂载 volume 和 device：

```yaml
volumes:
  - /dev/snd:/dev/snd:rw
devices:
  - /dev/snd:/dev/snd:rwm
```

#### 权限组

容器进程必须在 `group_add:` 中声明以下两个组才能访问硬件：

```yaml
group_add:
  - audio     # 访问 /dev/snd
  - dialout   # 访问 /dev/ttyUSB*、/dev/ttyACM*
```

二者缺一不可。缺少 `audio` 会导致音频设备列表只显示 "Default"；缺少 `dialout` 会在连接电台时报 "Permission denied"。

### LiveKit 网络

| 端口 | 协议 | 用途 |
|------|------|------|
| 7881 | TCP | RTC 媒体传输 |
| 50000-50100 | UDP | 媒体端口范围 |

浏览器通过当前站点的同源 `/livekit` 路径接入信令，因此通常不需要公网暴露 `7880/tcp`。如果反向代理或域名配置导致该路径不可达，请在系统设置中配置自定义实时语音入口。

### 更新

```bash
# 拉取最新镜像
docker compose pull
docker compose up -d

# 或从本地源码重新构建
git pull
docker compose build --no-cache
docker compose up -d
```

重新部署时不要删除 `./data/` 目录——其中包含配置、管理员令牌、LiveKit 凭据和日志。

### 故障排查

| 现象 | 原因 | 解决方法 |
|------|------|---------|
| `/api/radio/serial-ports` 返回 500 | 镜像缺少 `udevadm` | 升级到最新镜像，或在容器内 `apt-get install udev` |
| 串口 "Permission denied" | 进程缺少 `dialout` 组 | 在 compose 的 `group_add:` 中添加 `dialout`，重建容器 |
| 音频设备只显示 "Default" | 进程缺少 `audio` 组 | 在 compose 的 `group_add:` 中添加 `audio`，重建容器 |
| 容器不断重启 | `supervisord` 配置解析错误 | `docker compose build --no-cache` 或 `docker compose pull` |
| 宿主机有 USB 但容器无 tty | 只映射了 `/dev/bus/usb` | 在 `devices:` 中映射具体的 `/dev/ttyUSB*` 或 `/dev/ttyACM*` 节点 |
| 电台 CAT 连接正常但无音频 | USB 声卡未映射 | 宿主机 `aplay -l` 确认，在 `volumes:` 和 `devices:` 中映射 `/dev/snd` |

### 相关文档

- [`docker-compose.yml`](../docker-compose.yml) — Compose 基线配置
- [`docs/docker-deployment.md`](../docs/docker-deployment.md) — 进阶指南（VM 直通、CI/CD、手动构建）
- [Docker Hub](https://hub.docker.com/r/boybook/tx-5dr)
