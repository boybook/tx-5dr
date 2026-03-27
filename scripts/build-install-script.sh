#!/bin/bash
# Build a self-contained install-online.sh by inlining lib/common.sh and lib/checks.sh
# into install.sh, and adding online download capability.
#
# Usage: scripts/build-install-script.sh
# Output: dist/install-online.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/dist"
OUTPUT="$OUTPUT_DIR/install-online.sh"

mkdir -p "$OUTPUT_DIR"

COMMON="$PROJECT_ROOT/linux/lib/common.sh"
CHECKS="$PROJECT_ROOT/linux/lib/checks.sh"
INSTALL="$PROJECT_ROOT/linux/install.sh"

for f in "$COMMON" "$CHECKS" "$INSTALL"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: $f not found" >&2; exit 1
    fi
done

REPO="boybook/tx-5dr"

python3 - "$COMMON" "$CHECKS" "$INSTALL" "$OUTPUT" "$REPO" << 'PYEOF'
import sys, re

common_path, checks_path, install_path, output_path, repo = sys.argv[1:6]

def read_strip_shebang(path):
    with open(path) as f:
        lines = f.readlines()
    if lines and lines[0].startswith('#!'):
        lines = lines[1:]
    return ''.join(lines)

common = read_strip_shebang(common_path)
checks = read_strip_shebang(checks_path)
install_src = read_strip_shebang(install_path)

# Remove the lib-loading block from install.sh (from SCRIPT_DIR= to source checks.sh)
install_src = re.sub(
    r'SCRIPT_DIR=.*?source "\$LIB_DIR/checks\.sh"\n',
    '',
    install_src,
    flags=re.DOTALL
)

# Replace the "No .deb file provided" error block with auto-download logic
download_block = f'''    # Auto-download latest nightly from GitHub
        log_info "Downloading latest nightly from GitHub..."
        _dl_family=$(os_family)
        if [[ "$_dl_family" == "rhel" ]]; then
            DL_URL="https://github.com/{repo}/releases/download/nightly-server/TX-5DR-nightly-server-linux-${{ARCH}}.rpm"
            PKG_FILE="/tmp/tx5dr-nightly-${{ARCH}}.rpm"
        else
            DL_URL="https://github.com/{repo}/releases/download/nightly-server/TX-5DR-nightly-server-linux-${{ARCH}}.deb"
            PKG_FILE="/tmp/tx5dr-nightly-${{ARCH}}.deb"
        fi
        if curl -fSL --progress-bar -o "$PKG_FILE" "$DL_URL"; then
            log_ok "Downloaded: $PKG_FILE"
            if $IS_UPGRADE; then
                systemctl stop tx5dr 2>/dev/null || true
            fi
            if [[ "$_dl_family" == "rhel" ]]; then
                dnf install -y "$PKG_FILE" 2>&1 || rpm -ivh --force "$PKG_FILE" 2>&1 || true
            else
                dpkg -i --force-depends "$PKG_FILE" 2>&1 || true
                apt-get install -f -y 2>&1 || true
            fi
            rm -f "$PKG_FILE"
        else
            log_error "Download failed: $DL_URL"
            log_error "You can manually download and pass the package path as argument."
            exit 1
        fi'''

install_src = install_src.replace(
    '''    log_error "No .deb file provided and TX-5DR is not installed."
        log_error "Usage: sudo bash install.sh path/to/tx5dr.deb"
        exit 1''',
    download_block
)

# Also replace the upgrade "no package file" block
install_src = install_src.replace(
    '        log_ok "TX-5DR already installed (no package file provided, keeping current version)"',
    download_block.replace('log_info "Downloading latest', 'log_info "Downloading latest update from GitHub...\n        # Downloading')
)

header = '''#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  TX-5DR Server — One-Click Install Script (self-contained)      ║
# ║  Auto-generated — do not edit. Source: linux/install.sh          ║
# ║                                                                  ║
# ║  Usage:                                                          ║
# ║    curl -fsSL <url>/install-online.sh | sudo bash                ║
# ║    sudo bash install-online.sh [path-to-local.deb]               ║
# ║    sudo bash install-online.sh --check-only                      ║
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail
'''

with open(output_path, 'w') as f:
    f.write(header)
    f.write('\n# ── lib/common.sh (inlined) ──────────────────────────────────────\n')
    f.write(common)
    f.write('\n# ── lib/checks.sh (inlined) ──────────────────────────────────────\n')
    f.write(checks)
    f.write('\n# ── install.sh (inlined) ─────────────────────────────────────────\n')
    f.write(install_src)

print(f"Generated: {output_path}")
PYEOF

chmod +x "$OUTPUT"
LINES=$(wc -l < "$OUTPUT")
SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "  $LINES lines, $SIZE"
