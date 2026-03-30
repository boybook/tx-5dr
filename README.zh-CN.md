# TX-5DR

**现代化的业余无线电数字电台。** 随时随地通过浏览器操作 FT8、FT4 和语音模式。

[English](./README.md)

---

## 为什么选择 TX-5DR？

### 精美设计，化繁为简

TX-5DR 拥有精心打磨的现代化界面 —— 实时 WebGL 频谱瀑布图、直觉化的操作控件、桌面和移动端自适应布局。从一键自动 CQ 到拖拽调频，每一处交互都力求自然流畅。多操作员并行发射、OpenWebRX SDR 集成、远程语音通联等专业级能力，被无缝整合在简洁的界面之下，让你无需学习成本即可上手。

### 随时随地访问 —— 无需安装客户端

TX-5DR 采用现代前后端分离架构。服务端启动后（桌面、Linux 服务器或 Docker），通过**任意浏览器**即可操作电台 —— 笔记本、平板、手机，局域网或互联网均可。客户端零安装。

即便是**桌面应用（Electron）也内置了完整的服务端**，应用运行时随时可以通过浏览器远程连接。

### 共享电台 —— 多人同时操作

完整的角色权限系统（管理员 / 操作员 / 观察者），支持电台共享。多个操作员可以**同时使用同一部电台** —— 各自独立的呼号、频率和自动化配置，并行发射 FT8，系统自动完成音频混音。

### OpenWebRX 集成 —— 双全工与双周期发射

TX-5DR 可以连接 [OpenWebRX](https://www.openwebrx.de/) SDR 接收机作为辅助接收源。将远端 SDR 的音频接入本地解码管线后，你将获得：

- **双全工操作** —— 本地电台发射的同时，SDR 持续接收，消除收发切换间隙
- **双周期发射** —— 奇偶时隙均可实时解码，每个时隙都能发射，不再需要交替等待
- **优质接收性能** —— 充分利用远端高品质、低底噪的 SDR 接收站（如 KiwiSDR、WebSDR）进行解码，本地电台仅负责发射

一部半双工电台，即可实现等效全双工的 FT8/FT4 操作。

### 核心功能

- **数字模式**：FT8（15秒）、FT4（7.5秒）、语音（SSB/FM/AM），支持 Fox/Hound DXpedition 模式
- **实时频谱**：GPU 加速 WebGL 瀑布图，支持缩放和平移
- **电台控制**：Hamlib（网络/串口）、ICOM WLAN（IC-705 WiFi 直连）、无电台监听模式
- **OpenWebRX SDR 接收**：连接远端 OpenWebRX 接收机，实现双全工解码与双周期发射
- **多操作员**：每人独立呼号、网格、频率和发射策略 —— 自动 CQ、自动应答、并行编码与音频混音
- **远程语音通联**：通过浏览器远程进行语音通联（SSB/FM）—— 麦克风音频实时传输到服务端并通过电台发射（需要 HTTPS）
- **通联日志与同步**：内置 ADIF 日志本，与 WaveLog、QRZ.com、LoTW 双向同步
- **PSKReporter**：自动将解码信号上报至全球 PSKReporter 网络
- **音频监控**：通过 LiveKit/WebRTC 将实时音频推送到浏览器
- **多语言**：完整的中文和英文界面

---

## 部署方式

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| **桌面应用**（Electron） | Windows / macOS / Linux 图形界面 | 从 [GitHub Releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) / [Gitee Releases](https://gitee.com/boybook/tx-5dr/releases/tag/nightly-app) 下载 |
| **Linux 服务器**（deb/rpm） | 无头服务器、低成本硬件 | `tx5dr start` — 见 [服务器安装](#linux-服务器) |
| **Docker** | 容器化部署、快速体验 | `docker-compose up -d` — 见 [Docker](#docker) |

---

## 桌面应用

从 [GitHub Releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) 或 [Gitee Releases](https://gitee.com/boybook/tx-5dr/releases/tag/nightly-app) 下载对应平台的安装包。中国大陆用户通常优先使用 Gitee：

- **Windows**：`.msi` 安装包 或 `.7z` 便携版
- **macOS**：`.dmg`（Apple Silicon 和 Intel）
- **Linux**：`.deb` / `.rpm`（含 Electron 图形界面）

---

## Linux 服务器

纯服务器部署 —— 无需桌面环境，通过浏览器访问。

### 一键安装

Release 页面：
- GitHub：<https://github.com/boybook/tx-5dr/releases/tag/nightly-server>
- Gitee：<https://gitee.com/boybook/tx-5dr/releases/tag/nightly-server>

下面这一键在线安装脚本内部仍以内置 GitHub 源拉取安装包。中国大陆环境更建议先从 Gitee Release 页面下载软件包，再执行本地安装。

```bash
# 自动检测架构、下载安装包、修复所有依赖
# 在线安装脚本当前内部仍会从 GitHub 拉包
curl -fsSL https://github.com/boybook/tx-5dr/releases/download/nightly-server/install-online.sh | sudo bash
```

或手动安装：
```bash
# 先从 GitHub Releases 或 Gitee Releases 下载 TX-5DR-nightly-server-linux-amd64.deb
sudo dpkg -i --force-depends ./TX-5DR-nightly-server-linux-amd64.deb
sudo bash /usr/share/tx5dr/install.sh
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `tx5dr start` | 启动服务，显示带认证令牌的 Web UI 地址 |
| `tx5dr stop` | 停止服务 |
| `tx5dr restart` | 重启服务 |
| `tx5dr status` | 状态面板（服务器、nginx、端口、SSL） |
| `tx5dr token` | 显示管理员令牌和登录 URL |
| `tx5dr update` | 下载并安装最新 nightly 版本 |
| `tx5dr doctor` | 全面环境诊断 |
| `tx5dr logs` | 跟踪服务日志（`--nginx` 查看 nginx 日志） |

### 系统要求

- **Debian 12+**（推荐）或 **Ubuntu 22.04+**
- **Node.js 20+**（安装脚本自动安装）
- **nginx**（自动安装）
- **LiveKit 服务**：Linux 安装包会内置 `livekit-server`，路径为 `/usr/share/tx5dr/bin/livekit-server`
- 语音通联功能需要 **HTTPS**（在 `/etc/nginx/conf.d/tx5dr.conf` 中配置 SSL）
- 公网部署语音 / OpenWebRX 试听时，需额外放通 `7880/tcp`、`7881/tcp` 和 `50000-50100/udp`
- 浏览器会直连 LiveKit；默认按当前访问主机自动推导为 `ws(s)://<当前主机>:7880`。如存在公网映射、独立域名或不同端口，请在“系统设置”中填写 LiveKit 公网地址，配置会持久化到 `/var/lib/tx5dr/config/config.json`

---

## Docker

### Docker Compose（推荐）

```yaml
version: '3.8'
services:
  tx5dr:
    image: boybook/tx-5dr:latest
    container_name: tx5dr
    restart: unless-stopped
    depends_on:
      - livekit
    ports:
      - "8076:80"
    volumes:
      - ./data/config:/app/data/config
      - ./data/logs:/app/data/logs
      - ./data/cache:/app/data/cache
      - /dev/snd:/dev/snd:rw
    devices:
      - /dev/bus/usb:/dev/bus/usb:rwm
    group_add:
      - audio
    environment:
      - LIVEKIT_URL=ws://livekit:7880
      - LIVEKIT_API_KEY=tx5dr
      - LIVEKIT_API_SECRET=tx5dr-change-me-0123456789abcdef

  livekit:
    image: livekit/livekit-server:latest
    container_name: tx5dr-livekit
    restart: unless-stopped
    command: --config /etc/livekit.yaml
    ports:
      - "7880:7880/tcp"
      - "7881:7881/tcp"
      - "50000-50100:50000-50100/udp"
    volumes:
      - ./docker/livekit.yaml:/etc/livekit.yaml:ro
```

```bash
docker compose up -d
# 访问：http://localhost:8076

# 查看管理员令牌
docker exec tx5dr cat /app/data/config/.admin-token
```

- 浏览器会直连 LiveKit signaling 地址，公网地址覆盖请在系统设置中配置，值会写入 `/app/data/config/config.json`
- 如果外部域名、TLS 终止或端口映射与容器内部地址不一致，必须在设置页填写对外可达的 LiveKit WebSocket 地址

详见 [GitHub nightly-docker](https://github.com/boybook/tx-5dr/releases/tag/nightly-docker) 或 [Gitee nightly-docker](https://gitee.com/boybook/tx-5dr/releases/tag/nightly-docker)。

---

## 开发

### 前置要求

- Node.js 22+、Yarn 4+（Berry）、Git
- 各平台构建工具（见下方）

### 安装

```bash
git clone https://github.com/boybook/tx-5dr.git
cd tx-5dr
yarn install
```

### 运行

```bash
# 浏览器模式（server + web）
yarn dev
# → http://localhost:5173

# Electron 模式
yarn dev:electron
```

### 构建

```bash
yarn build           # 构建所有包
yarn build:package   # Electron 打包
yarn package:deb     # 服务器 deb 包（需要 fpm）
```

### 平台依赖

<details>
<summary>Linux (Ubuntu/Debian)</summary>

```bash
sudo apt-get install -y \
  libasound2-dev libpulse-dev libhamlib-dev \
  build-essential python3-dev pkg-config \
  libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libxi-dev libxext-dev
```
</details>

<details>
<summary>macOS</summary>

```bash
brew install cmake fftw boost gcc pkg-config
```
</details>

<details>
<summary>Windows</summary>

安装 Visual Studio 2022（含 MSVC 工具链）。Native 模块可能需要 MSYS2/MinGW-w64。
</details>

---

## 项目结构

```
tx-5dr/
├── packages/
│   ├── contracts/       # Zod Schema 和 TypeScript 类型
│   ├── core/            # 运行时无关的工具函数和 API 客户端
│   ├── server/          # Fastify 后端 + 数字电台引擎
│   ├── web/             # React 前端（Vite）
│   ├── electron-main/   # Electron 主进程
│   └── electron-preload/# Electron 预加载脚本（沙箱）
├── linux/               # 服务器部署（systemd、nginx、安装脚本）
├── docker/              # Docker 配置（nginx、supervisor、入口脚本）
├── scripts/             # 构建和打包脚本
└── .github/workflows/   # CI：electron-release、server-release、docker-release
```

## 技术栈

基于 Node.js 构建，性能关键部分以**原生 C/C++/Fortran 二进制**运行 —— FT8 编解码（WSJT-X）、音频 I/O（RtAudio）、电台控制（Hamlib）、FFT 处理均为原生代码，非 JavaScript。

- **后端**：Fastify、WebSocket、XState v5 状态机、Piscina 工作池（并行 FT8 编解码）
- **前端**：React 18、HeroUI、WebGL（频谱）、i18next
- **原生二进制**：WSJTX-lib（FT8/FT4 编解码）、Audify（RtAudio）、Hamlib（CAT 控制）、SerialPort
- **构建**：Turborepo、Yarn 4 工作区、Electron Forge

### 核心原生 Node.js 扩展

TX-5DR 依赖多个原生 Node.js 扩展实现实时电台操作，其中大部分作为本项目的配套组件维护：

| 包名 | 说明 | 仓库 |
|------|------|------|
| [wsjtx-lib](https://www.npmjs.com/package/wsjtx-lib) | FT8/FT4 编解码器（WSJT-X Fortran 核心） | [boybook/wsjtx-lib-nodejs](https://github.com/boybook/wsjtx-lib-nodejs) |
| [hamlib](https://www.npmjs.com/package/hamlib) | Hamlib Node.js 绑定（CAT 电台控制） | [boybook/node-hamlib](https://github.com/boybook/node-hamlib) |
| [icom-wlan-node](https://www.npmjs.com/package/icom-wlan-node) | ICOM WLAN（IC-705 WiFi）控制协议 | [boybook/icom-wlan-node](https://github.com/boybook/icom-wlan-node) |
| [rubato-fft-node](https://www.npmjs.com/package/rubato-fft-node) | 高性能 FFT + 采样率转换 | [boybook/rubato-fft-node](https://github.com/boybook/rubato-fft-node) |
| [@openwebrx-js/api](https://www.npmjs.com/package/@openwebrx-js/api) | OpenWebRX 客户端 API（SDR 接收机集成） | [boybook/openwebrx-js](https://github.com/boybook/openwebrx-js) |
| [audify](https://www.npmjs.com/package/audify) | RtAudio 绑定（低延迟音频 I/O） | [almoghamdani/audify](https://github.com/almoghamdani/audify) |

## 许可证

GNU General Public License v3.0 —— 详见 [LICENSE](LICENSE)。
