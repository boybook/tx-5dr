# TX-5DR Docker / Docker 部署

[English](#english) | [中文](#中文)

Full documentation / 完整文档: **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**

---

## English

### Quick Start

Image: `boybook/tx-5dr:latest` ([Docker Hub](https://hub.docker.com/r/boybook/tx-5dr))

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}
docker compose pull
docker compose up -d
docker exec tx5dr cat /app/data/config/.admin-token
```

Open `http://<host>:8076` and log in with the admin token.

> This starts TX-5DR in **standalone mode** using WebSocket audio (ws-compat). All features work — FT8 decoding, radio control, voice transmit and monitoring are fully functional. For lower-latency voice via LiveKit/WebRTC, see [Adding LiveKit](#adding-livekit-optional) below.

#### Adding LiveKit (optional)

LiveKit provides lower-latency voice transport over WebRTC (typically 20–50 ms vs 50–100 ms for ws-compat). To enable it alongside the main application:

```bash
docker compose --profile livekit -f docker-compose.yml -f docker-compose.livekit.yml up -d
```

On first run, `livekit-init` will auto-generate credentials into `./data/realtime/`. The main application detects LiveKit availability at startup and switches automatically.

### Services

| Service | Profile | Purpose |
|---------|---------|---------|
| `tx5dr` | *(always)* | Main application (nginx + tx5dr-server via supervisor) |
| `livekit-init` | `livekit` | One-shot: generates LiveKit credentials into `./data/realtime/` |
| `livekit` | `livekit` | LiveKit signaling + media server |

### Key Configuration

**Device mapping** — edit `docker-compose.yml` `devices:` to match your hardware:

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/snd:/dev/snd:rwm
  - /dev/ttyACM0:/dev/ttyACM0:rwm    # ICOM IC-705, etc.
  # - /dev/ttyUSB0:/dev/ttyUSB0:rwm  # CP2102/CH340, etc.
```

**Permission groups** — both required:

```yaml
group_add:
  - audio      # /dev/snd
  - dialout    # /dev/ttyUSB*, /dev/ttyACM*
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Serial ports 500 error | Upgrade to latest image (needs `udev`) |
| Serial "Permission denied" | Add `dialout` to `group_add`, recreate container |
| Audio shows only "Default" | Add `audio` to `group_add`, recreate container |
| Host has USB, container has no tty | Map `/dev/ttyUSB*` or `/dev/ttyACM*` in `devices` |

For detailed setup, device mapping, and LiveKit networking, see **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**.

---

## 中文

### 快速开始

镜像：`boybook/tx-5dr:latest`（[Docker Hub](https://hub.docker.com/r/boybook/tx-5dr)）

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}
docker compose pull
docker compose up -d
docker exec tx5dr cat /app/data/config/.admin-token
```

浏览器访问 `http://<host>:8076`，使用管理员令牌登录。

> 以上命令以**独立模式**启动 TX-5DR，使用 WebSocket 音频传输（ws-compat）。所有功能均可正常使用 — FT8 解码、电台控制、语音发射与监听完全可用。如需更低延迟的 LiveKit/WebRTC 语音，请参阅下方 [启用 LiveKit](#启用-livekit可选)。

#### 启用 LiveKit（可选）

LiveKit 通过 WebRTC 提供更低延迟的语音传输（通常 20–50 ms，ws-compat 为 50–100 ms）。如需在主应用旁启用：

```bash
docker compose --profile livekit -f docker-compose.yml -f docker-compose.livekit.yml up -d
```

首次运行时，`livekit-init` 会自动生成凭据到 `./data/realtime/`。主应用启动时会自动检测 LiveKit 可用性并切换。

### 服务说明

| 服务 | Profile | 作用 |
|------|---------|------|
| `tx5dr` | *（始终启动）* | 主应用（nginx + tx5dr-server，supervisor 管理） |
| `livekit-init` | `livekit` | 一次性运行：生成 LiveKit 凭据到 `./data/realtime/` |
| `livekit` | `livekit` | LiveKit 信令 + 媒体服务器 |

### 关键配置

**设备映射** — 编辑 `docker-compose.yml` 的 `devices:` 匹配你的硬件：

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/snd:/dev/snd:rwm
  - /dev/ttyACM0:/dev/ttyACM0:rwm    # ICOM IC-705 等
  # - /dev/ttyUSB0:/dev/ttyUSB0:rwm  # CP2102/CH340 等
```

**权限组** — 二者缺一不可：

```yaml
group_add:
  - audio      # /dev/snd
  - dialout    # /dev/ttyUSB*、/dev/ttyACM*
```

### 故障排查

| 现象 | 解决方法 |
|------|---------|
| 串口列表 500 错误 | 升级到最新镜像（需要 `udev`） |
| 串口 "Permission denied" | `group_add` 中添加 `dialout`，重建容器 |
| 音频只显示 "Default" | `group_add` 中添加 `audio`，重建容器 |
| 宿主机有 USB 容器无 tty | 在 `devices` 中映射 `/dev/ttyUSB*` 或 `/dev/ttyACM*` |

详细配置、设备映射和 LiveKit 网络说明，请参阅 **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**。
