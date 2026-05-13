#!/bin/bash
# systemd ExecStartPre guard for the TX-5DR Linux server runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
# shellcheck source=checks.sh
source "$SCRIPT_DIR/checks.sh"

if check_nodejs; then
    exit 0
fi

echo "TX-5DR requires Node.js >= ${TX5DR_MIN_NODE_MAJOR}." >&2
echo "Current Node.js: $(nodejs_requirement_detail)" >&2
echo "Run: sudo tx5dr doctor --fix" >&2
exit 1
