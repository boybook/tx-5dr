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

# The online installer is made reliable by using an explicit hook in install.sh
# instead of replacing a fragile formatted error block.
online_hook = '''
# Auto-download latest nightly package when no local .deb/.rpm was provided.
tx5dr_online_install_missing_package() {
    local _dl_family _fallback_tag _asset_name _pkg_ext _fallback_url
    local _tmp_dir PKG_FILE _resolved_url _resolved_sha _preferred_source
    local _source _manifest_json _install_ok
    local -a _sources

    log_info "Resolving latest nightly package..."
    _dl_family=$(os_family)
    _fallback_tag="nightly-server"
    if [[ "$_dl_family" == "rhel" ]]; then
        _asset_name="TX-5DR-nightly-server-linux-${ARCH}.rpm"
    else
        _asset_name="TX-5DR-nightly-server-linux-${ARCH}.deb"
    fi
    _pkg_ext="${_asset_name##*.}"
    _fallback_url="$(get_github_release_asset_url "$_fallback_tag" "$_asset_name")"
    _resolved_url=""
    _resolved_sha=""
    _preferred_source="github"

    if should_prefer_oss_download; then
        _preferred_source="oss"
        log_info "Detected mainland China or OSS override. Preferring OSS mirror."
    fi

    if [[ "$_preferred_source" == "oss" ]]; then
        _sources=(oss github)
    else
        _sources=(github oss)
    fi

    for _source in "${_sources[@]}"; do
        if _manifest_json=$(fetch_server_manifest_from_source "$_source" 2>/dev/null); then
            _resolved_url=$(get_server_manifest_package_url_for_source "$_manifest_json" "${ARCH}" "$_pkg_ext" "$_source" 2>/dev/null || true)
            _resolved_sha=$(get_server_manifest_package_sha256 "$_manifest_json" "${ARCH}" "$_pkg_ext" 2>/dev/null || true)
            if [[ -n "$_resolved_url" ]]; then
                break
            fi
        fi
        log_warn "${_source} manifest unavailable or missing ${ARCH}/${_pkg_ext}; trying next source..."
    done
    [[ -n "$_resolved_url" ]] || _resolved_url="$_fallback_url"

    _tmp_dir=$(mktemp -d)
    trap 'rm -rf "$_tmp_dir"' RETURN
    PKG_FILE="$_tmp_dir/$_asset_name"

    if ! tx5dr_download_package "$_resolved_url" "$_resolved_sha" "$PKG_FILE"; then
        if [[ "$_resolved_url" != "$_fallback_url" ]]; then
            log_warn "Primary download failed; falling back to GitHub release asset..."
            tx5dr_download_package "$_fallback_url" "" "$PKG_FILE" || {
                log_error "Download failed: $_fallback_url"
                log_error "You can manually download and pass the package path as argument."
                exit 1
            }
        else
            log_error "Download failed: $_resolved_url"
            log_error "You can manually download and pass the package path as argument."
            exit 1
        fi
    fi

    log_ok "Downloaded: $PKG_FILE"
    $IS_UPGRADE && systemctl stop tx5dr 2>/dev/null || true

    _install_ok=false
    if [[ "$_dl_family" == "rhel" ]]; then
        if rpm -q tx5dr &>/dev/null; then
            if ! (dnf upgrade -y "$PKG_FILE" || dnf install -y "$PKG_FILE" || rpm -Uvh "$PKG_FILE") 2>&1 | tail -20; then
                log_warn "RPM package manager reported an install failure; verifying package state..."
            fi
        else
            if ! (dnf install -y "$PKG_FILE" || rpm -ivh "$PKG_FILE") 2>&1 | tail -20; then
                log_warn "RPM package manager reported an install failure; verifying package state..."
            fi
        fi
        rpm -q tx5dr &>/dev/null && _install_ok=true
    else
        if ! dpkg -i --force-depends "$PKG_FILE" 2>&1 | tail -20; then
            log_warn "dpkg reported an install issue; attempting dependency repair..."
        fi
        if ! apt-get install -f -y 2>&1 | tail -20; then
            log_warn "apt-get dependency repair reported an issue; verifying package state..."
        fi
        dpkg-query -W -f='${Status}' tx5dr 2>/dev/null | grep -q "install ok installed" && _install_ok=true
    fi

    if ! $_install_ok; then
        log_error "Package installation failed."
        exit 1
    fi

    rm -rf "$_tmp_dir"
    trap - RETURN
}

tx5dr_download_package() {
    local url="$1" expected_sha="$2" output="$3"

    rm -f "$output"
    if ! curl -fSL --progress-bar -o "$output" "$url"; then
        rm -f "$output"
        return 1
    fi

    if [[ -n "$expected_sha" ]] && command -v sha256sum &>/dev/null; then
        if ! printf "%s  %s\n" "$expected_sha" "$output" | sha256sum -c - >/dev/null 2>&1; then
            log_warn "Package checksum mismatch: $url"
            rm -f "$output"
            return 1
        fi
    fi

    return 0
}
'''

if 'tx5dr_online_install_missing_package' not in install_src:
    print('ERROR: linux/install.sh no longer calls tx5dr_online_install_missing_package hook', file=sys.stderr)
    sys.exit(1)

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
    f.write('\n# ── online install hook ──────────────────────────────────────────\n')
    f.write(online_hook)
    f.write('\n# ── install.sh (inlined) ─────────────────────────────────────────\n')
    f.write(install_src)

print(f"Generated: {output_path}")
PYEOF

chmod +x "$OUTPUT"
if ! grep -q '^tx5dr_online_install_missing_package()' "$OUTPUT"; then
    echo "ERROR: generated installer is missing online download hook" >&2
    exit 1
fi
if ! grep -q 'Resolving latest nightly package' "$OUTPUT"; then
    echo "ERROR: generated installer is missing nightly package resolver" >&2
    exit 1
fi
bash -n "$OUTPUT"
LINES=$(wc -l < "$OUTPUT")
SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "  $LINES lines, $SIZE"
