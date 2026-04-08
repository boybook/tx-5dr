# TX-5DR Docker Notes

This document is the Docker-facing quick reference for TX-5DR. For the fuller Chinese deployment guide, see `docs/docker-deployment.md`.

## Quick Start

Prefer a phased startup instead of launching the whole stack blindly on first boot.

```bash
mkdir -p data/{config,plugins,logs,cache,realtime}

docker compose pull
# If you build from the local checkout instead of using published images:
# docker compose build --no-cache

docker compose run --rm livekit-init
docker compose up -d livekit
docker compose logs -f livekit

docker compose up -d tx5dr
docker compose logs -f tx5dr

docker exec tx5dr cat /app/data/config/.admin-token
```

Then open `http://localhost:8076`.

## Recommended Compose Notes

- Persist `./data/config`, `./data/plugins`, `./data/logs`, `./data/cache`, and `./data/realtime`
- Keep `/dev/snd` mapped for ALSA audio access
- Map `/dev/bus/usb` for raw USB access
- If CAT control uses host tty devices, also map the concrete tty nodes such as `/dev/ttyUSB0` and `/dev/ttyUSB1`
- Use `group_add: [audio]` when exposing `/dev/snd`

A typical serial-capable section looks like this:

```yaml
services:
  tx5dr:
    devices:
      - /dev/bus/usb:/dev/bus/usb:rwm
      - /dev/ttyUSB0:/dev/ttyUSB0:rwm
      - /dev/ttyUSB1:/dev/ttyUSB1:rwm
      - /dev/snd:/dev/snd:rwm
    volumes:
      - ./data/config:/app/data/config
      - ./data/plugins:/app/data/plugins
      - ./data/logs:/app/data/logs
      - ./data/cache:/app/data/cache
      - ./data/realtime:/app/data/realtime
      - /dev/snd:/dev/snd:rw
    group_add:
      - audio
```

## Hardware Checks Before Startup

Run these on the host or inside the VM before blaming Docker:

```bash
lsusb
aplay -l
arecord -l
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true
ls -l /dev/serial/by-id 2>/dev/null || true
```

Important note:

- Seeing the USB device in `lsusb` does not automatically mean the container can use the matching tty node
- `/dev/bus/usb` alone is usually not enough for Hamlib serial mode

## LiveKit Networking

Browser clients normally enter signaling through the site's same-origin `/livekit` path, so `7880/tcp` does not need to be exposed publicly in the common case.

If you use the LiveKit primary media path, make sure these are reachable from clients:

- `7881/tcp`
- `50000-50100/udp`

## Troubleshooting

### Container keeps restarting

```bash
docker compose logs --tail=200 tx5dr
```

If you see a `supervisord` / `supervisor` parse error, you are likely running an older image or cached local build. Refresh it with:

```bash
docker compose build --no-cache
# or
docker compose pull
```

### Host sees USB, container does not see tty devices

Map the actual tty devices too:

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb:rwm
  - /dev/ttyUSB0:/dev/ttyUSB0:rwm
  - /dev/ttyUSB1:/dev/ttyUSB1:rwm
```

Then verify inside the container:

```bash
docker compose exec tx5dr sh -lc 'ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true'
```

### Audio devices missing inside the container

```bash
docker compose exec tx5dr sh -lc 'ls -l /dev/snd || true'
docker compose exec tx5dr aplay -l
```

If needed, revisit host-side USB passthrough, ALSA visibility, and the compose `group_add` / `devices` settings.

## Related Files

- `docker-compose.yml`
- `docker/supervisord.conf`
- `docker/entrypoint.sh`
- `docs/docker-deployment.md`
