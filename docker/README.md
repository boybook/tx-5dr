# TX-5DR Docker / Docker 部署

[English](#english) | [中文](#中文)

Full documentation / 完整文档: **[tx5dr.com/guide/docker](https://tx5dr.com/guide/docker)**

---

## English

### Quick Start (Standalone)

Image: `boybook/tx-5dr:latest` ([Docker Hub](https://hub.docker.com/r/boybook/tx-5dr))

```bash
mkdir -p data
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

Configure the LiveKit topology from the app's "System Settings > Realtime Audio" page. The container now persists the whole `./data` root and generates a managed `livekit.resolved.yaml`; do not hand-edit the generated YAML.

#### Server-only CPU profile capture

The Web UI now provides a guided capture flow at `System Settings > Performance Diagnostics`. It arms the next backend `server` start only, and never injects `--cpu-prof` into nginx or other companion processes.

If you need a manual override, set `TX5DR_SERVER_CPU_PROFILE=1` on the `tx5dr-server` process environment. Do not use container-wide `NODE_OPTIONS`.

The `.cpuprofile` file is written only after a clean backend stop or restart. Use `docker restart tx5dr` to finish the capture, then collect the result from:

- Container path: `/app/data/logs/diagnostics/cpu`
- Host path: `./data/logs/diagnostics/cpu`

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
mkdir -p data
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

LiveKit 的网络拓扑现在统一从应用内“系统设置 > 实时音频”配置。容器会持久化整个 `./data` 根目录，并生成托管的 `livekit.resolved.yaml`；不要再手工修改生成后的 YAML。

#### 仅 `server` 子进程的 CPU Profile

现在 Web UI 在“系统设置 > 性能诊断”里提供一次性引导采样，只会作用在后端 `server` 进程，不会把 `--cpu-prof` 注入 nginx 或其他伴随进程。

如需手动覆盖，可为 `tx5dr-server` 进程设置 `TX5DR_SERVER_CPU_PROFILE=1`。不要通过容器级 `NODE_OPTIONS` 全局注入。

`.cpuprofile` 文件只有在后端正常停止或重启后才会写出。完成采样时请使用 `docker restart tx5dr`，然后到以下位置取文件：

- 容器内路径：`/app/data/logs/diagnostics/cpu`
- 宿主机路径：`./data/logs/diagnostics/cpu`

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
