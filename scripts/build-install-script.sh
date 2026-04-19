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
DEFAULT_DOWNLOAD_BASE_URL="https://tx5dr.oss-cn-hangzhou.aliyuncs.com"
DOWNLOAD_BASE_URL="${TX5DR_DOWNLOAD_BASE_URL:-$DEFAULT_DOWNLOAD_BASE_URL}"

python3 - "$COMMON" "$CHECKS" "$INSTALL" "$OUTPUT" "$REPO" "$DOWNLOAD_BASE_URL" << 'PYEOF'
import sys, re

common_path, checks_path, install_path, output_path, repo, download_base_url = sys.argv[1:7]

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
download_block = f'''    # Auto-download latest nightly from OSS metadata (fallback to GitHub)
        log_info "Resolving latest nightly package..."
        _dl_family=$(os_family)
        _fallback_tag="nightly-server"
        if [[ "$_dl_family" == "rhel" ]]; then
            _asset_name="TX-5DR-nightly-server-linux-${{ARCH}}.rpm"
        else
            _asset_name="TX-5DR-nightly-server-linux-${{ARCH}}.deb"
        fi
        _fallback_url="$(get_github_release_asset_url "$_fallback_tag" "$_asset_name")"
        PKG_FILE="/tmp/${{_asset_name}}"
        _resolved_url=""
        _resolved_sha=""
        _preferred_source="github"
        if should_prefer_oss_download; then
            _preferred_source="oss"
            log_info "Detected mainland China or OSS override. Preferring OSS mirror."
        fi
        if _manifest_json=$(fetch_server_manifest_from_source "oss" 2>/dev/null); then
            _resolved_url=$(get_server_manifest_package_url_for_source "$_manifest_json" "${{ARCH}}" "${{_asset_name##*.}}" "$_preferred_source" 2>/dev/null || true)
            _resolved_sha=$(get_server_manifest_package_sha256 "$_manifest_json" "${{ARCH}}" "${{_asset_name##*.}}" 2>/dev/null || true)
            if [[ -z "$_resolved_url" ]]; then
                if [[ "$_preferred_source" == "oss" ]]; then
                    _resolved_url=$(get_server_manifest_package_url_for_source "$_manifest_json" "${{ARCH}}" "${{_asset_name##*.}}" "github" 2>/dev/null || true)
                else
                    _resolved_url=$(get_server_manifest_package_url_for_source "$_manifest_json" "${{ARCH}}" "${{_asset_name##*.}}" "oss" 2>/dev/null || true)
                fi
            fi
        else
            log_warn "OSS manifest unavailable, falling back to GitHub release asset..."
        fi
        [[ -n "$_resolved_url" ]] || _resolved_url="$_fallback_url"
        if curl -fSL --progress-bar -o "$PKG_FILE" "$_resolved_url"; then
            if [[ -n "$_resolved_sha" ]] && command -v sha256sum &>/dev/null; then
                if ! printf "%s  %s\\n" "$_resolved_sha" "$PKG_FILE" | sha256sum -c - >/dev/null 2>&1; then
                    log_warn "OSS package checksum mismatch, falling back to GitHub..."
                    rm -f "$PKG_FILE"
                    curl -fSL --progress-bar -o "$PKG_FILE" "$_fallback_url"
                fi
            fi
            log_ok "Downloaded: $PKG_FILE"
            if $IS_UPGRADE; then
                systemctl stop tx5dr 2>/dev/null || true
            fi
            if [[ "$_dl_family" == "rhel" ]]; then
                # Use reinstall when the same version is already installed (e.g. nightly always 1.0.0)
                # so that postinstall scripts run and files are updated.
                if rpm -q tx5dr &>/dev/null; then
                    dnf reinstall -y "$PKG_FILE" 2>&1 || rpm -Uvh --force "$PKG_FILE" 2>&1 || true
                else
                    dnf install -y "$PKG_FILE" 2>&1 || rpm -ivh --force "$PKG_FILE" 2>&1 || true
                fi
            else
                dpkg -i --force-depends "$PKG_FILE" 2>&1 || true
                apt-get install -f -y 2>&1 || true
            fi
            rm -f "$PKG_FILE"
        else
            log_error "Download failed: $_resolved_url"
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

download_base_assignment = ''
if download_base_url:
    escaped = download_base_url.replace('\\', '\\\\').replace('"', '\\"')
    download_base_assignment = f'TX5DR_DOWNLOAD_BASE_URL="${{TX5DR_DOWNLOAD_BASE_URL:-{escaped}}}"\n'

header = f'''#!/bin/bash
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
{download_base_assignment}'''

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
