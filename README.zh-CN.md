# TX-5DR

**业余无线电数字电台。** 通过浏览器操作 FT8 等数字模式 —— 可部署在桌面、Linux 服务器或 Docker 中。

[English](./README.md)

---

## 部署方式

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| **桌面应用**（Electron） | Windows / macOS / Linux 图形界面 | 从 [Releases (nightly-app)](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) 下载 |
| **Linux 服务器**（deb/rpm） | 无头服务器、低成本硬件 | `tx5dr start` — 见 [服务器安装](#linux-服务器) |
| **Docker** | 容器化部署、快速体验 | `docker-compose up -d` — 见 [Docker](#docker) |

---

## 桌面应用

从 [nightly-app releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) 下载对应平台的安装包：

- **Windows**：`.msi` 安装包 或 `.7z` 便携版
- **macOS**：`.dmg`（Apple Silicon 和 Intel）
- **Linux**：`.deb` / `.rpm`（含 Electron 图形界面）

---

## Linux 服务器

纯服务器部署 —— 无需桌面环境，通过浏览器访问。

### 一键安装

```bash
# 下载最新服务器包（ARM 服务器请将 amd64 替换为 arm64）
curl -fSL -o tx5dr.deb \
  https://github.com/boybook/tx-5dr/releases/download/nightly-server/TX-5DR-nightly-server-linux-amd64.deb

# 安装（自动处理 Node.js、GLIBCXX、nginx 等依赖）
sudo dpkg -i --force-depends tx5dr.deb
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
- 语音通联功能需要 **HTTPS**（在 `/etc/nginx/conf.d/tx5dr.conf` 中配置 SSL）

---

## Docker

### 快速启动

```bash
docker run -d -p 8076:80 --name tx5dr boybook/tx-5dr:latest

# 查看管理员令牌
docker exec tx5dr cat /app/data/config/.admin-token
```

### Docker Compose（推荐）

```yaml
version: '3.8'
services:
  tx5dr:
    image: boybook/tx-5dr:latest
    container_name: tx5dr
    restart: unless-stopped
    ports:
      - "8076:80"
    volumes:
      - ./data/config:/app/data/config
      - ./data/logs:/app/data/logs
      - /dev/snd:/dev/snd:rw
    devices:
      - /dev/bus/usb:/dev/bus/usb:rwm
    group_add:
      - audio
```

```bash
docker-compose up -d
# 访问：http://localhost:8076
```

详见 [nightly-docker releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-docker)。

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

- **后端**：Fastify、WebSocket、XState v5、Piscina 工作池
- **前端**：React 18、HeroUI、WebGL、i18next
- **音频**：Audify (RtAudio)、WSJTX-lib (FT8/FT4)
- **电台**：Hamlib (CAT 控制)、ICOM WLAN、SerialPort
- **构建**：Turborepo、Yarn 4 工作区、Electron Forge

## 许可证

GNU General Public License v3.0 —— 详见 [LICENSE](LICENSE)。
