# TX-5DR - Ham Radio FT8 Digital Mode Application

[![Docker Image Size](https://img.shields.io/docker/image-size/boybook/tx-5dr/latest)](https://hub.docker.com/r/boybook/tx-5dr)
[![Docker Pulls](https://img.shields.io/docker/pulls/boybook/tx-5dr)](https://hub.docker.com/r/boybook/tx-5dr)
[![Multi-Architecture](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-blue)](https://hub.docker.com/r/boybook/tx-5dr)

TX-5DR is a modern, web-based amateur radio application designed for FT8 digital mode communication and automatic station control. Built with Node.js, React, and Electron, it provides a comprehensive solution for digital amateur radio operations.

## 🚀 Quick Start

### Run with Docker

```bash
# Run the application
docker run -d -p 8076:80 --name tx-5dr boybook/tx-5dr:latest

# Access the web interface
# Open http://localhost:8076 in your browser
```

### Run with Docker Compose

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
      - ./data/cache:/app/data/cache
      # nginx
      - ./data/logs/nginx:/var/log/nginx
      # supervisor
      - ./data/logs/supervisor:/var/log/supervisor
      # devices
      - /dev/snd:/dev/snd:rw
      - /dev/shm:/dev/shm:rw
      # PulseAudio
      - /run/user/1000/pulse:/run/user/1000/pulse:ro
      - /var/lib/pulse:/var/lib/pulse:ro
    devices:
      # USB devices
      - /dev/bus/usb:/dev/bus/usb:rwm
      # Audio devices
      - /dev/snd:/dev/snd:rwm
    environment:
      - NODE_ENV=production
      - PORT=4000
      - TX5DR_CONFIG_DIR=/app/data/config
      - TX5DR_DATA_DIR=/app/data
      - TX5DR_LOGS_DIR=/app/data/logs
      - TX5DR_CACHE_DIR=/app/data/cache
      - PULSE_RUNTIME_PATH=/run/user/1000/pulse
      - PULSE_STATE_PATH=/var/lib/pulse
    group_add:
      - audio
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
      - SYS_NICE
      - SYS_RESOURCE
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=100m
```

## ✨ Features

- **🎵 Audio Processing**: Real-time audio encoding/decoding using WSJT-X library
- **📡 FT8 Protocol**: Full support for FT8 digital mode communication
- **🔧 Radio Control**: CAT control for various amateur radio transceivers
- **🌐 Web Interface**: Modern, responsive web-based user interface
- **🖥️ Multi-Platform**: Available as web app, Docker container, and Electron desktop app
- **⚡ Real-time**: WebSocket-based real-time communication
- **📊 Spectrum Analysis**: Built-in waterfall and spectrum analyzer
- **📝 Logging**: Integrated logging with ADIF support

## 🏗️ Architecture

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Fastify + TypeScript
- **Audio**: naudiodon2 + WSJT-X library integration
- **Radio Control**: Hamlib integration
- **Desktop**: Electron wrapper for native experience

## 📋 System Requirements

### Minimum Requirements
- **CPU**: 1 GHz dual-core processor
- **RAM**: 512 MB available memory
- **Storage**: 2 GB available space
- **Audio**: USB audio interface or sound card

### Recommended Requirements
- **CPU**: 2 GHz quad-core processor
- **RAM**: 2 GB available memory
- **Storage**: 4 GB available space
- **Audio**: Dedicated USB audio interface

## 🐳 Supported Architectures

This Docker image supports multiple architectures:

- `linux/amd64` - Intel/AMD 64-bit
- `linux/arm64` - ARM 64-bit (Apple Silicon, Raspberry Pi 4+)

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Application environment |
| `PORT` | `4000` | Backend server port |
| `TX5DR_CONFIG_DIR` | `/app/data/config` | Configuration directory |
| `TX5DR_DATA_DIR` | `/app/data` | Data directory |
| `TX5DR_LOGS_DIR` | `/app/data/logs` | Logs directory |
| `TX5DR_CACHE_DIR` | `/app/data/cache` | Cache directory |

### Volume Mounts

- `/app/data/config` - Application configuration files
- `/app/data/logs` - Application and system logs
- `/app/data/cache` - Temporary cache files

### Device Access

For audio device access, you may need to:

```bash
# Add user to audio group (on host)
sudo usermod -a -G audio $USER

# Run with privileged mode for full hardware access
docker run --privileged ...
```

## 🎯 Usage Examples

### Basic FT8 Operation

1. **Start the container**: `docker run -d -p 8076:80 boybook/tx-5dr:latest`
2. **Access web interface**: Open `http://localhost:8076`
3. **Configure audio devices**: Select input/output devices in settings
4. **Configure radio**: Set up CAT control for your transceiver
5. **Start operating**: Begin FT8 communication

### With External Audio Interface

```bash
docker run -d \
  -p 8076:80 \
  --device=/dev/snd \
  --group-add audio \
  boybook/tx-5dr:latest
```

### Development Mode

```bash
docker run -d \
  -p 8076:80 \
  -v $(pwd)/config:/app/data/config \
  -e NODE_ENV=development \
  boybook/tx-5dr:latest
```

## 🔍 Troubleshooting

### Common Issues

**Audio Device Not Found**
- Ensure audio devices are properly connected
- Check device permissions and group membership
- Try running with `--privileged` flag

**Radio Control Issues**
- Verify CAT control settings in your radio
- Check USB/Serial port permissions
- Ensure correct baud rate and protocol settings

**Web Interface Not Loading**
- Check if port 8076 is available
- Verify container is running: `docker ps`
- Check container logs: `docker logs tx-5dr`

### Getting Help

- **Documentation**: [GitHub Repository](https://github.com/boybook/tx-5dr)
- **Issues**: [GitHub Issues](https://github.com/boybook/tx-5dr/issues)
- **Discussions**: [GitHub Discussions](https://github.com/boybook/tx-5dr/discussions)

## 📊 Performance

### Optimized Docker Image

- **Base Image**: `node:22-slim` (minimal Debian)
- **Multi-stage Build**: Optimized for production deployment
- **Size**: ~1.4GB (down from 3.4GB original)
- **Startup Time**: < 10 seconds on modern hardware

### Resource Usage

- **CPU**: Low to moderate usage during operation
- **Memory**: ~200-500MB depending on activity
- **Network**: Minimal bandwidth requirements
- **Storage**: Logs and configuration data only

## 🏷️ Tags

- `latest` - Latest stable release
- `v1.x.x` - Specific version releases
- `develop` - Development branch (unstable)

## 🔒 Security

- Runs as non-root user (`www-data`)
- Minimal attack surface with slim base image
- Regular security updates
- No unnecessary services or packages

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/boybook/tx-5dr/blob/main/LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

**Note**: This application is designed for amateur radio operators. Ensure you comply with your local amateur radio regulations and licensing requirements when using this software.

For more information, visit the [TX-5DR GitHub Repository](https://github.com/boybook/tx-5dr). 