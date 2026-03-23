# TX-5DR

**A modern digital radio station for amateur radio operators.** Operate FT8, FT4, and voice modes from any web browser — anywhere, anytime.

[中文文档 (Chinese)](./README.zh-CN.md)

---

## Why TX-5DR?

### Access from anywhere — no client installation needed

TX-5DR uses a modern client-server architecture. Once the server is running (on a desktop, a Linux box, or Docker), you operate your radio from **any web browser** — laptop, tablet, phone, across your LAN or over the internet. No software to install on the client side.

Even the **desktop app (Electron) runs a full server inside**, so you can always connect remotely via browser while the app is running.

### Share your radio — multiple operators at once

A complete role-based permission system (Admin / Operator / Viewer) lets you share your station with others. Multiple operators can **use the same radio simultaneously** — each with their own callsign, frequency, and automation settings, transmitting FT8 in parallel with automatic audio mixing.

### Key Features

- **Digital Modes**: FT8 (15s), FT4 (7.5s), Voice (SSB/FM/AM), with Fox/Hound DXpedition support
- **Real-time Spectrum**: GPU-accelerated WebGL waterfall display with zoom/pan
- **Radio Control**: Hamlib (network/serial), ICOM WLAN (IC-705 WiFi direct), or no-radio monitor mode
- **Multi-operator**: Independent callsign, grid, frequency, and TX strategy per operator — auto-CQ, auto-reply, parallel encoding with audio mixing
- **Remote Voice QSO**: Transmit and receive voice (SSB/FM) remotely through the browser — your microphone audio is streamed to the server and transmitted via the radio (requires HTTPS)
- **Logbook & Sync**: Built-in ADIF logbook with two-way sync to WaveLog, QRZ.com, and LoTW
- **PSKReporter**: Auto-report decoded signals to the global PSKReporter network
- **Audio Monitoring**: Real-time audio stream (Opus/PCM) to the browser
- **Multi-language**: Full English and Chinese UI

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
# One-click install (auto-detects arch, downloads package, fixes dependencies)
curl -fsSL https://github.com/boybook/tx-5dr/releases/download/nightly-server/install-online.sh | sudo bash
```

Or manually:
```bash
curl -fSL -o tx5dr.deb https://github.com/boybook/tx-5dr/releases/download/nightly-server/TX-5DR-nightly-server-linux-amd64.deb
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

Built on Node.js with performance-critical components running as **native C/C++/Fortran binaries** — FT8 encoding/decoding (WSJT-X), audio I/O (RtAudio), radio control (Hamlib), and FFT processing are all native, not JavaScript.

- **Backend**: Fastify, WebSocket, XState v5 state machines, Piscina worker pool (parallel FT8 encode/decode)
- **Frontend**: React 18, HeroUI, WebGL (spectrum), i18next
- **Native Binaries**: WSJTX-lib (FT8/FT4 codec), Audify (RtAudio), Hamlib (CAT), SerialPort
- **Build**: Turborepo, Yarn 4 workspaces, Electron Forge

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
