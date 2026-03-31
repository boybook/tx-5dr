#!/bin/bash

set -euo pipefail

RUNTIME_DIR="${LIVEKIT_RUNTIME_DIR:-/var/lib/tx5dr-runtime}"
SIGNAL_PORT="${LIVEKIT_SIGNAL_PORT:-7880}"
TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
UDP_PORT_START="${LIVEKIT_UDP_PORT_START:-50000}"
UDP_PORT_END="${LIVEKIT_UDP_PORT_END:-50100}"
CREDENTIAL_FILE="${LIVEKIT_CREDENTIALS_FILE:-${RUNTIME_DIR}/livekit-credentials.env}"
CONFIG_FILE="${LIVEKIT_CONFIG_PATH:-${RUNTIME_DIR}/livekit.yaml}"

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

# shellcheck disable=SC1090
source "$CREDENTIAL_FILE"

cat > "$CONFIG_FILE" <<EOF
port: ${SIGNAL_PORT}
rtc:
  tcp_port: ${TCP_PORT}
  port_range_start: ${UDP_PORT_START}
  port_range_end: ${UDP_PORT_END}
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
logging:
  level: info
EOF

chmod 640 "$CREDENTIAL_FILE" "$CONFIG_FILE"
echo "[livekit-init] Prepared credentials: ${CREDENTIAL_FILE}"
echo "[livekit-init] Prepared config: ${CONFIG_FILE}"
