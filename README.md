# TX-5DR

**A modern digital radio station for amateur radio operators.** Operate FT8, FT4, and voice modes from any web browser — anywhere, anytime.

[中文文档 (Chinese)](./README.zh-CN.md)

---

## Why TX-5DR?

### Beautifully crafted, powerfully simple

TX-5DR features a polished, modern UI with real-time WebGL spectrum waterfall, intuitive controls, and responsive layouts that work beautifully on desktop and mobile. Every interaction — from one-click auto-CQ to drag-and-drop frequency tuning — is designed to feel natural. Complex capabilities like multi-operator parallel TX, OpenWebRX SDR integration, and remote voice QSO are seamlessly integrated behind a clean interface, so you get professional-grade power without the learning curve.

### Access from anywhere — no client installation needed

TX-5DR uses a modern client-server architecture. Once the server is running (on a desktop, a Linux box, or Docker), you operate your radio from **any web browser** — laptop, tablet, phone, across your LAN or over the internet. No software to install on the client side.

Even the **desktop app (Electron) runs a full server inside**, so you can always connect remotely via browser while the app is running.

### Share your radio — multiple operators at once

A complete role-based permission system (Admin / Operator / Viewer) lets you share your station with others. Multiple operators can **use the same radio simultaneously** — each with their own callsign, frequency, and automation settings, transmitting FT8 in parallel with automatic audio mixing.

### OpenWebRX Integration — Full-duplex & Dual-cycle TX

TX-5DR can connect to [OpenWebRX](https://www.openwebrx.de/) SDR receivers as an auxiliary RX source. By routing a remote SDR's audio into the local decode pipeline, you get:

- **Full-duplex operation** — transmit on your local radio while simultaneously receiving on the SDR, eliminating the TX/RX gap
- **Dual-cycle transmission** — decode both even and odd slots in real-time, enabling TX in every slot instead of alternating
- **Superior RX performance** — leverage high-quality, low-noise-floor SDR stations (e.g. a remote KiwiSDR or WebSDR site) for decoding, while your local radio handles TX only

This turns a single half-duplex transceiver into an effectively full-duplex FT8/FT4 station.

### Key Features

- **Digital Modes**: FT8 (15s), FT4 (7.5s), Voice (SSB/FM/AM), with Fox/Hound DXpedition support
- **Real-time Spectrum**: GPU-accelerated WebGL waterfall display with zoom/pan
- **Radio Control**: Hamlib (network/serial), ICOM WLAN (IC-705 WiFi direct), or no-radio monitor mode
- **OpenWebRX SDR RX**: Connect to remote OpenWebRX receivers for full-duplex decode and dual-cycle TX
- **Multi-operator**: Independent callsign, grid, frequency, and TX strategy per operator — auto-CQ, auto-reply, parallel encoding with audio mixing
- **Remote Voice QSO**: Transmit and receive voice (SSB/FM) remotely through the browser — your microphone audio is streamed to the server and transmitted via the radio (requires HTTPS)
- **Logbook & Sync**: Built-in ADIF logbook with two-way sync to WaveLog, QRZ.com, and LoTW
- **PSKReporter**: Auto-report decoded signals to the global PSKReporter network
- **Audio Monitoring**: Low-latency browser monitoring over WebRTC DataChannel with WebSocket fallback
- **Multi-language**: Full English and Chinese UI

---

## Deployment Options

| Option | Best for | How |
|--------|---------|-----|
| **Desktop App** (Electron) | Windows / macOS / Linux with GUI | Download from [GitHub Releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app) |
| **Linux Server** (deb/rpm) | Headless servers, low-cost hardware | `tx5dr start` — see [Server Install](#linux-server) |
| **Docker** | Containers, quick setup | `docker-compose up -d` — see [Docker](#docker) |

---

## Desktop App

Download the installer for your platform from [GitHub Releases](https://github.com/boybook/tx-5dr/releases/tag/nightly-app). Mainland China builds are also published to the OSS mirror during release workflows:

- **Windows**: `.msi` installer or `.7z` portable
- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Linux**: `.deb` / `.rpm` (includes Electron GUI)

---

## Linux Server

Server-only deployment — no desktop environment required. Access via web browser.

### Quick Install

Release pages:
- GitHub: <https://github.com/boybook/tx-5dr/releases/tag/nightly-server>

The one-click online installer and `tx5dr update` now use OSS only when geolocation detects mainland China, and use GitHub everywhere else. If the OSS mirror is unavailable, they fall back to GitHub automatically.

```bash
# One-click install (auto-detects arch, resolves latest package metadata, fixes dependencies)
curl -fsSL https://github.com/boybook/tx-5dr/releases/download/nightly-server/install-online.sh | sudo bash
```

Or manually:
```bash
# Download TX-5DR-nightly-server-linux-amd64.deb from GitHub Releases or the OSS mirror first
sudo dpkg -i --force-depends ./TX-5DR-nightly-server-linux-amd64.deb
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
| `tx5dr doctor --fix` | Run diagnostics and apply safe environment fixes |

### Service Layout

Linux Server is not a single standalone process. The installer sets up and wires together:

- `tx5dr`: the backend application, Web API, and embedded `rtc-data-audio` WebRTC DataChannel endpoint
- `nginx`: the public reverse proxy and HTTPS entrypoint

`install.sh` and the `tx5dr` CLI handle installation, configuration, diagnostics, firewall checks, and coordinated restarts across these components. Realtime voice defaults to `rtc-data-audio` on UDP `50110`, with `ws-compat` as the automatic TCP fallback.

### System Requirements

- **Debian 12+** (recommended) or **Ubuntu 22.04+**
- **Node.js 20+** (auto-installed by `install.sh`)
- **nginx** (auto-installed)
- **Realtime voice UDP**: allow `50110/udp` by default, or set `RTC_DATA_AUDIO_UDP_PORT` in `/etc/tx5dr/config.env`
- For voice features: **HTTPS** (configure SSL in `/etc/nginx/conf.d/tx5dr.conf`)
- For FRP/static NAT: map one public UDP port to the server UDP port, then set the public host/IP and UDP port in "System Settings > Realtime Audio > WebRTC Data Audio external UDP address"
- Download source override: set `TX5DR_DOWNLOAD_SOURCE=github|oss|auto` in `/etc/tx5dr/config.env` if you need to force a specific source
- Server-only CPU profile capture is available from `System Settings > Performance Diagnostics`, or by setting `TX5DR_SERVER_CPU_PROFILE=1` in `/etc/tx5dr/config.env` for a manual override. This never enables profiling for nginx, Electron main, or other child processes
- CPU profile files are flushed only when the backend server exits cleanly. Use a normal restart such as `sudo tx5dr restart` or `docker restart tx5dr`, not a force kill
- Generated files are stored under `logs/diagnostics/cpu` in the managed runtime root. Linux service installs use `/var/lib/tx5dr/logs/diagnostics/cpu`; official Docker uses `/app/data/logs/diagnostics/cpu` in-container and `./data/logs/diagnostics/cpu` on the host

---

## Docker

Image: `boybook/tx-5dr:latest` ([Docker Hub](https://hub.docker.com/r/boybook/tx-5dr))

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}
docker compose pull
docker compose up -d
# Access: http://localhost:8076
docker exec tx5dr cat /app/data/config/.admin-token
```

This starts TX-5DR with `rtc-data-audio` enabled by default and `ws-compat` as fallback. The default compose file exposes `8076/tcp`, `8443/tcp`, and `50110/udp`. For FRP/static NAT, forward one UDP port to `50110/udp` and configure the public endpoint in the realtime settings page.

For the full deployment guide — including device mapping, serial port setup, audio configuration, and troubleshooting — see **[docker/README.md](docker/README.md)**.

Image release details: [GitHub nightly-docker](https://github.com/boybook/tx-5dr/releases/tag/nightly-docker).

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
# → http://localhost:8076 (or the next free port)

# Electron mode
yarn dev:electron
```

- `yarn dev` / `yarn dev:electron` start the embedded server realtime stack directly; signaling is same-origin at `/api/realtime/rtc-data-audio`
- Development uses fixed UDP `50110` by default (`RTC_DATA_AUDIO_UDP_PORT` can override it)
- If `node-datachannel` cannot load on the current platform, the backend still starts and offers `ws-compat` only

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

### Core Native Node.js Extensions

TX-5DR relies on several native Node.js addons for real-time radio operation. Most are maintained as part of this project:

| Package | Description | Repository |
|---------|-------------|------------|
| [wsjtx-lib](https://www.npmjs.com/package/wsjtx-lib) | FT8/FT4 encoder & decoder (WSJT-X Fortran core) | [boybook/wsjtx-lib-nodejs](https://github.com/boybook/wsjtx-lib-nodejs) |
| [hamlib](https://www.npmjs.com/package/hamlib) | Node.js bindings for Hamlib (CAT radio control) | [boybook/node-hamlib](https://github.com/boybook/node-hamlib) |
| [icom-wlan-node](https://www.npmjs.com/package/icom-wlan-node) | ICOM WLAN (IC-705 WiFi) control protocol | [boybook/icom-wlan-node](https://github.com/boybook/icom-wlan-node) |
| [rubato-fft-node](https://www.npmjs.com/package/rubato-fft-node) | High-performance FFT + sample-rate conversion | [boybook/rubato-fft-node](https://github.com/boybook/rubato-fft-node) |
| [@openwebrx-js/api](https://www.npmjs.com/package/@openwebrx-js/api) | OpenWebRX client API for SDR receiver integration | [boybook/openwebrx-js](https://github.com/boybook/openwebrx-js) |
| [audify](https://www.npmjs.com/package/audify) | RtAudio bindings for low-latency audio I/O | [almoghamdani/audify](https://github.com/almoghamdani/audify) |

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
