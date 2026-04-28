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

Realtime voice defaults to `rtc-data-audio` and automatically falls back to `ws-compat` if UDP/DataChannel cannot connect. For external access through FRP, map the TCP web ports and the UDP `50110` port, then set the public host/IP and UDP port in `System Settings > Realtime Audio`.

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

实时语音默认使用 `rtc-data-audio`，如果 UDP/DataChannel 无法连通，会自动回退到 `ws-compat`。通过 FRP 外网访问时，请同时映射 Web TCP 端口和 UDP `50110`，然后在“系统设置 > 实时音频”中填写公网主机/IP 与 UDP 端口。

如果 UDP 被拦截或映射错误，客户端仍会通过 `ws-compat` 工作，只是无法使用更低延迟的 UDP-like 链路。
