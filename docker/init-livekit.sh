#!/bin/bash

set -euo pipefail

RUNTIME_DIR="${LIVEKIT_RUNTIME_DIR:-/var/lib/tx5dr-runtime}"
SIGNAL_PORT="${LIVEKIT_SIGNAL_PORT:-7880}"
TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
UDP_PORT_START="${LIVEKIT_UDP_PORT_START:-50000}"
UDP_PORT_END="${LIVEKIT_UDP_PORT_END:-50100}"
CREDENTIAL_FILE="${LIVEKIT_CREDENTIALS_FILE:-${RUNTIME_DIR}/livekit-credentials.env}"
CONFIG_FILE="${LIVEKIT_CONFIG_PATH:-${RUNTIME_DIR}/livekit.resolved.yaml}"
APP_CONFIG_FILE="${TX5DR_APP_CONFIG_FILE:-/app/data/config/config.json}"
RENDER_CLI="${TX5DR_LIVEKIT_RENDER_CLI:-/app/packages/server/dist/realtime/livekit-config-cli.js}"

random_hex() {
  local bytes="${1:-16}"
  od -An -N"${bytes}" -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}

mkdir -p "$(dirname "$CREDENTIAL_FILE")" "$(dirname "$CONFIG_FILE")"

if [[ ! -f "$CREDENTIAL_FILE" ]]; then
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "$CREDENTIAL_FILE" <<EOF
# Managed by TX-5DR Docker init.
LIVEKIT_API_KEY=tx5dr-$(random_hex 8)
LIVEKIT_API_SECRET=$(random_hex 24)
LIVEKIT_CREDENTIALS_CREATED_AT=${now}
LIVEKIT_CREDENTIALS_ROTATED_AT=${now}
EOF
fi

if [[ ! -f "$RENDER_CLI" ]]; then
  echo "[livekit-init] Missing render CLI: ${RENDER_CLI}" >&2
  exit 1
fi

node "$RENDER_CLI" \
  --app-config "$APP_CONFIG_FILE" \
  --credential-file "$CREDENTIAL_FILE" \
  --output "$CONFIG_FILE" \
  --signal-port "$SIGNAL_PORT" \
  --tcp-port "$TCP_PORT" \
  --udp-start "$UDP_PORT_START" \
  --udp-end "$UDP_PORT_END"

chmod 640 "$CREDENTIAL_FILE" "$CONFIG_FILE"
echo "[livekit-init] Prepared credentials: ${CREDENTIAL_FILE}"
echo "[livekit-init] Prepared config: ${CONFIG_FILE}"
