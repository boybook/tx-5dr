# TX-5DR Docker

## English

TX-5DR Docker runs the web UI, API server, nginx, and realtime audio in one container.

### Ports

| Port | Protocol | Purpose |
| --- | --- | --- |
| `8076` | TCP | HTTP web UI |
| `8443` | TCP | HTTPS web UI (recommended for browser microphone access) |
| `50110` | UDP | `rtc-data-audio` WebRTC DataChannel media |
| `4532` | TCP | Optional rigctld-compatible bridge |

Start:

```bash
docker compose up -d
```

Realtime voice defaults to `rtc-data-audio` and automatically falls back to `ws-compat` if UDP/DataChannel cannot connect. Opus is selected automatically when browser WebCodecs and the server native codec are available; otherwise the same connection falls back to PCM. For external access through FRP, map the TCP web ports and the UDP `50110` port, then set the public host/IP and UDP port in `System Settings > Realtime Audio`.

### FRP Example

```toml
[[proxies]]
name = "tx5dr-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 8443

[[proxies]]
name = "tx5dr-rtc-data-audio"
type = "udp"
localIP = "127.0.0.1"
localPort = 50110
remotePort = 50110
```

If UDP is blocked or mapped incorrectly, clients keep working through `ws-compat`; they just lose the lower-latency UDP-like path.

### Local network discovery

Desktop clients can find stations on the local network (DNS-SD `_tx5dr._tcp`). Docker's default bridge network does not carry multicast, so the container does not announce itself by default. To enable it, run the container with `network_mode: host` (remove the `ports` mapping), then set `TX5DR_DISCOVERY=1` and `TX5DR_DISCOVERY_PORT` to the web port browsers use on the host (`80` with the bundled nginx). Without this, add the station in the desktop client by its address. The announcement carries only a version, a random station instance ID and the protocol.

## 中文

TX-5DR Docker 在一个容器内运行 Web UI、API server、nginx 和实时音频。

### 端口

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `8076` | TCP | HTTP Web UI |
| `8443` | TCP | HTTPS Web UI（浏览器麦克风权限推荐） |
| `50110` | UDP | `rtc-data-audio` WebRTC DataChannel 媒体 |
| `4532` | TCP | 可选 rigctld 兼容桥接 |

启动：

```bash
docker compose up -d
```

实时语音默认使用 `rtc-data-audio`，如果 UDP/DataChannel 无法连通，会自动回退到 `ws-compat`。当浏览器 WebCodecs 与服务端原生编解码都可用时会自动选择 Opus，否则同一连接回退到 PCM。通过 FRP 外网访问时，请同时映射 Web TCP 端口和 UDP `50110`，然后在“系统设置 > 实时音频”中填写公网主机/IP 与 UDP 端口。

如果 UDP 被拦截或映射错误，客户端仍会通过 `ws-compat` 工作，只是无法使用更低延迟的 UDP-like 链路。

### 局域网发现

桌面客户端可以自动发现局域网中的电台（DNS-SD `_tx5dr._tcp`）。Docker 默认的 bridge 网络不转发组播，因此容器默认不广播。需要时请以 `network_mode: host` 运行容器（去掉 `ports` 映射），并设置 `TX5DR_DISCOVERY=1` 和 `TX5DR_DISCOVERY_PORT`（主机上浏览器访问的 Web 端口，使用内置 nginx 时为 `80`）。不开启时，在桌面客户端中手动输入电台地址即可。广播内容只有版本号、随机的电台实例 ID 和协议。
