# TX-5DR TFT35A / LCD35-show Bring-up

This guide records the real Raspberry Pi path for the 3.5 inch ILI9486 + XPT2046/ADS7846 panel that is supported by the vendor `LCD-show/LCD35-show` script.

## Verified Hardware State

On `boybook@192.168.31.234`, after running `~/coding/LCD-show/LCD35-show`, Linux exposes:

```text
/proc/fb:
0 BCM2708 FB
1 fb_ili9486

/dev/fb1: fb_ili9486, 480x320, 16bpp RGB565
/dev/input/event0: ADS7846 Touchscreen
/dev/input/by-path/platform-fe204000.spi-cs-1-event -> ../event0
spi0.0 -> fb_ili9486
spi0.1 -> ads7846
```

The vendor script works by installing `tft35a.dtbo`, adding `dtoverlay=tft35a:rotate=90`, and configuring X11/fbturbo/fbcp to mirror the desktop. TX-5DR does not use that desktop mirroring path in product mode; it uses the same kernel fbdev/evdev devices directly.

## Product Mode Boot Config

TX-5DR product mode is portrait `320x480` and expects device-ui to own `/dev/fb1`. Use the vendor overlay, but change the display rotation from the desktop default `90` to `0`:

```ini
dtparam=spi=on
dtoverlay=tft35a:rotate=0
hdmi_force_hotplug=1
hdmi_group=2
hdmi_mode=87
hdmi_cvt 320 480 60 6 0 0 0
hdmi_drive=2
```

After reboot, verify:

```bash
cat /proc/fb
fbset -fb /dev/fb1
cat /proc/bus/input/devices | grep -A5 'ADS7846 Touchscreen'
ls -l /dev/input/by-path/platform-fe204000.spi-cs-1-event
```

Expected framebuffer geometry is `320x480` at `16bpp`. If it remains `480x320`, keep the device-ui service stopped and fix the overlay/rotation first.

## Touch Calibration

LCD-show ships calibration files. For portrait rotate `0`, use the values from:

```text
~/coding/LCD-show/usr/99-calibration.conf-35-0
Calibration: 268 3880 227 3936
SwapAxes: 0
```

TX-5DR uses its own JSON calibration instead of Xorg config:

```json
{
  "rawMinX": 268,
  "rawMaxX": 3880,
  "rawMinY": 227,
  "rawMaxY": 3936,
  "swapXY": false,
  "invertX": false,
  "invertY": false,
  "rotation": 0
}
```

Install it as `/var/lib/tx5dr/device-ui/calibration.json`.

## Device UI Environment

Use `/etc/tx5dr/device-ui.env`:

```bash
TX5DR_DEVICE_UI_PROFILE=tft-ili9486-320x480-touch
TX5DR_DEVICE_UI_RENDERER=native
TX5DR_DEVICE_UI_FB=/dev/fb1
TX5DR_DEVICE_UI_INPUT=/dev/input/by-path/platform-fe204000.spi-cs-1-event
TX5DR_DEVICE_UI_SOCKET=/run/tx5dr/device-ui-panel.sock
TX5DR_DEVICE_UI_CALIBRATION=/var/lib/tx5dr/device-ui/calibration.json
TX5DR_NETWORK_HELPER_SOCKET=/run/tx5dr/network-helper.sock
TX5DR_SERVER_URL=http://127.0.0.1:8076
TX5DR_CONFIG_DIR=/var/lib/tx5dr/config
```

The `tx5dr` service user must be in `video` and `input` groups. The network helper remains a separate root service and only accepts allowlisted operations over its Unix socket.

The network helper service runs as `User=root` with `Group=tx5dr` and creates `/run/tx5dr/network-helper.sock` as `0660`, so the unprivileged `tx5dr-device-ui.service` can request allowlisted `nmcli` operations without using `sudo`.

Device API authentication is separate from normal browser users. The daemon reads `/var/lib/tx5dr/config/.device-ui-token`, sends it as `X-TX5DR-Device-Token` to `POST /api/device-ui/session`, then uses the returned device JWT for `/api/device-ui/bootstrap`, `/api/device-ui/pairing-code`, and `/api/device-ui/ws`. The device websocket is not counted as a normal browser client.

## Manual Smoke Commands

Before enabling systemd, run a fixture daemon and renderer manually:

```bash
SOCK=/tmp/tx5dr-device-ui-panel.sock
rm -f "$SOCK"
yarn node packages/device-ui/dist/fixtures/preview.js \
  --fixture=access-wifi-ready \
  --renderer=mock \
  --profile=tft-ili9486-320x480-touch \
  --socket="$SOCK" \
  --watch
```

In another shell:

```bash
packages/device-ui/native/build/tx5dr-panel-lvgl/tx5dr-panel-lvgl \
  --backend=fbdev \
  --profile=tft-ili9486-320x480-touch \
  --fb=/dev/fb1 \
  --input=/dev/input/by-path/platform-fe204000.spi-cs-1-event \
  --socket=/tmp/tx5dr-device-ui-panel.sock \
  --calibration=/var/lib/tx5dr/device-ui/calibration.json
```

If the command exits with `fbdev-size-mismatch`, the panel is still in the vendor desktop `rotate=90 / 480x320` mode.

## Systemd Smoke

After the panel is in product geometry (`320x480`) and the calibration file exists:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tx5dr-network-helper
sudo systemctl enable --now tx5dr-device-ui
sudo journalctl -u tx5dr-device-ui -u tx5dr-network-helper -n 80 --no-pager
```

Do not enable `tx5dr-device-ui` while `/dev/fb1` is still `480x320`; the renderer intentionally exits with `fbdev-size-mismatch` and the manager will not keep retrying that deterministic configuration error.

## Desktop Recovery

To return to vendor desktop mirroring, rerun `~/coding/LCD-show/LCD35-show` or restore `dtoverlay=tft35a:rotate=90` and the vendor X11 startup files. Product mode intentionally does not depend on `/home/boybook/.bash_profile`, `startx`, `fbturbo`, or `fbcp`.
