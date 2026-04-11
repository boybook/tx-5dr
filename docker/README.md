# TX-5DR Docker / Docker 部署

[English](#english) | [中文](#中文)

Full documentation / 完整文档: **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**

---

## English

### Quick Start (Standalone)

Image: `boybook/tx-5dr:latest` ([Docker Hub](https://hub.docker.com/r/boybook/tx-5dr))

```bash
mkdir -p data/{config,plugins,logs,cache,realtime,ssl}
docker compose pull
docker compose up -d
docker exec tx5dr cat /app/data/config/.admin-token
```

Open `http://<host>:8076` (or `https://<host>:8443`) and log in with the admin token.

All features work in standalone mode — FT8, radio control, voice transmit and monitoring.

#### Adding LiveKit (optional, lower-latency voice)

Use the separate LiveKit compose file instead:

```bash
docker compose -f docker-compose.livekit.yml up -d
```

### Two Compose Files

| File | Mode | Command |
|------|------|---------|
| `docker-compose.yml` | Standalone (WebSocket audio) | `docker compose up -d` |
| `docker-compose.livekit.yml` | LiveKit (WebRTC, lower latency) | `docker compose -f docker-compose.livekit.yml up -d` |

### Key Configuration

**Device mapping** — edit the compose file `devices:` to match your hardware:

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

For detailed setup, see **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**.

---

## 中文

### 快速开始（独立模式）

镜像：`boybook/tx-5dr:latest`（[Docker Hub](https://hub.docker.com/r/boybook/tx-5dr)）

```bash
mkdir -p data/{config,plugins,logs,cache,realtime,ssl}
docker compose pull
docker compose up -d
docker exec tx5dr cat /app/data/config/.admin-token
```

浏览器访问 `http://<host>:8076`（或 `https://<host>:8443`），使用管理员令牌登录。

独立模式下所有功能完全可用——FT8 解码、电台控制、语音发射与监听。

#### 启用 LiveKit（可选，更低延迟语音）

使用单独的 LiveKit compose 文件：

```bash
docker compose -f docker-compose.livekit.yml up -d
```

### 两个 Compose 文件

| 文件 | 模式 | 命令 |
|------|------|------|
| `docker-compose.yml` | 独立模式（WebSocket 音频） | `docker compose up -d` |
| `docker-compose.livekit.yml` | LiveKit 模式（WebRTC，更低延迟） | `docker compose -f docker-compose.livekit.yml up -d` |

### 关键配置

**设备映射** — 编辑 compose 文件的 `devices:` 匹配你的硬件：

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

详细配置请参阅 **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**。
