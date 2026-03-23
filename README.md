# TX-5DR

**Digital radio station for amateur radio operators.** FT8 and other digital modes via a web browser — deploy on a desktop, a headless Linux server, or Docker.

[中文文档 (Chinese)](./README.zh-CN.md)

---

## Deployment Options

| Option | Best for | How |
|--------|---------|-----|
| **Desktop App** (Electron) | Windows / macOS / Linux with GUI | Download from [Releases (nightly-app)](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) |
| **Linux Server** (deb/rpm) | Headless servers, low-cost hardware | `tx5dr start` — see [Server Install](#linux-server) |
| **Docker** | Containers, quick setup | `docker-compose up -d` — see [Docker](#docker) |

---

## Desktop App

Download the installer for your platform from [nightly-app releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app):

- **Windows**: `.msi` installer or `.7z` portable
- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Linux**: `.deb` / `.rpm` (includes Electron GUI)

---

## Linux Server

Server-only deployment — no desktop environment required. Access via web browser.

### Quick Install

```bash
# Download the latest server package (replace amd64 with arm64 for ARM servers)
curl -fSL -o tx5dr.deb \
  https://github.com/boybook/tx-5dr/releases/download/nightly-server/TX-5DR-nightly-server-linux-amd64.deb

# Install (auto-fixes Node.js, GLIBCXX, nginx)
sudo bash tx5dr.deb   # or use the install script:
sudo dpkg -i --force-depends tx5dr.deb
sudo bash /usr/share/tx5dr/install.sh
```

### Commands

| Command | Description |
|---------|-------------|
| `tx5dr start` | Start server, show Web UI URL with auth token |
| `tx5dr stop` | Stop server |
| `tx5dr restart` | Restart server |
| `tx5dr status` | Status dashboard (server, nginx, ports, SSL) |
| `tx5dr token` | Show admin token and login URL |
| `tx5dr update` | Download and install latest nightly |
| `tx5dr doctor` | Full environment diagnostics |
| `tx5dr logs` | Follow server logs (`--nginx` for nginx) |

### System Requirements

- **Debian 12+** (recommended) or **Ubuntu 22.04+**
- **Node.js 20+** (auto-installed by `install.sh`)
- **nginx** (auto-installed)
- For voice features: **HTTPS** (configure SSL in `/etc/nginx/conf.d/tx5dr.conf`)

---

## Docker

### Quick Start

```bash
docker run -d -p 8076:80 --name tx5dr boybook/tx-5dr:latest

# View admin token
docker exec tx5dr cat /app/data/config/.admin-token
```

### Docker Compose (recommended)

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
# Access: http://localhost:8076
```

See [nightly-docker releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-docker) for image details.

---

## Development

### Prerequisites

- Node.js 22+, Yarn 4+ (Berry), Git
- Platform-specific build tools (see below)

### Setup

```bash
git clone https://github.com/boybook/tx-5dr.git
cd tx-5dr
yarn install
```

### Run

```bash
# Browser mode (server + web)
yarn dev
# → http://localhost:5173

# Electron mode
yarn dev:electron
```

### Build

```bash
yarn build           # Build all packages
yarn build:package   # Electron package
yarn package:deb     # Server deb package (requires fpm)
```

### Platform Dependencies

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

Install Visual Studio 2022 with MSVC toolchain. For native modules, MSYS2/MinGW-w64 may be required.
</details>

---

## Project Structure

```
tx-5dr/
├── packages/
│   ├── contracts/       # Zod schemas and TypeScript types
│   ├── core/            # Runtime-agnostic utilities and API client
│   ├── server/          # Fastify backend + digital radio engine
│   ├── web/             # React frontend (Vite)
│   ├── electron-main/   # Electron main process
│   └── electron-preload/# Electron preload (sandbox)
├── linux/               # Server deployment (systemd, nginx, install script)
├── docker/              # Docker config (nginx, supervisor, entrypoint)
├── scripts/             # Build and packaging scripts
└── .github/workflows/   # CI: electron-release, server-release, docker-release
```

## Tech Stack

- **Backend**: Fastify, WebSocket, XState v5, Piscina worker pool
- **Frontend**: React 18, HeroUI, WebGL, i18next
- **Audio**: Audify (RtAudio), WSJTX-lib (FT8/FT4)
- **Radio**: Hamlib (CAT control), ICOM WLAN, SerialPort
- **Build**: Turborepo, Yarn 4 workspaces, Electron Forge

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
