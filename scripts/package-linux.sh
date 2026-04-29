#!/bin/bash
# TX-5DR Linux Package Builder
# Generates deb and/or rpm packages for native Linux deployment (no Electron).
#
# Prerequisites:
#   - fpm: gem install fpm (or: apt install ruby-dev && gem install fpm)
#   - Node.js 20+, yarn
#
# Usage:
#   scripts/package-linux.sh [deb|rpm|both]        # default: both
#   scripts/package-linux.sh deb --no-build         # skip yarn build
#   scripts/package-linux.sh deb --target-arch arm64 # cross-build arch label

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
FORMAT="${1:-both}"
SKIP_BUILD=false
TARGET_ARCH=""

# Parse flags
shift || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-build) SKIP_BUILD=true ;;
        --target-arch) TARGET_ARCH="$2"; shift ;;
    esac
    shift
done

# Determine architecture
if [[ -n "$TARGET_ARCH" ]]; then
    ARCH="$TARGET_ARCH"
elif command -v dpkg &>/dev/null; then
    ARCH="$(dpkg --print-architecture)"
else
    ARCH="$(uname -m)"
fi

# Normalize arch for fpm
case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
esac

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[package]${NC} $1"; }
warn() { echo -e "${YELLOW}[package]${NC} $1"; }
err()  { echo -e "${RED}[package]${NC} $1" >&2; }

# Warn if not building on Linux
if [[ "$(uname -s)" != "Linux" ]]; then
    warn "Building on $(uname -s). Native modules (audify, hamlib, etc.) will be"
    warn "for the current platform, NOT Linux. The resulting package may not work"
    warn "on Linux unless you build on a Linux machine or in Docker/CI."
    echo ""
fi

# --- Preflight checks ---
if ! command -v fpm &>/dev/null; then
    err "fpm not found. Install with: gem install fpm"
    err "On Debian/Ubuntu: sudo apt install ruby-dev build-essential && sudo gem install fpm"
    exit 1
fi

# --- Build ---
if [[ "$SKIP_BUILD" == "false" ]]; then
    log "Building project (yarn build)..."
    cd "$PROJECT_ROOT"
    yarn build
else
    log "Skipping build (--no-build flag)."
fi

# Verify build outputs exist
if [[ ! -d "$PROJECT_ROOT/packages/server/dist" ]]; then
    err "Server build output not found at packages/server/dist/"
    err "Run 'yarn build' first or remove --no-build flag."
    exit 1
fi
if [[ ! -d "$PROJECT_ROOT/packages/web/dist" ]]; then
    err "Web build output not found at packages/web/dist/"
    exit 1
fi

# Determine runtime workspace packages required by the server package.
SERVER_RUNTIME_WORKSPACES=()
while IFS= read -r pkg; do
    [[ -n "$pkg" ]] && SERVER_RUNTIME_WORKSPACES+=("$pkg")
done < <(
    node -e "
        const pkg = require('$PROJECT_ROOT/packages/server/package.json');
        const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
        for (const [name, version] of Object.entries(deps)) {
            if (name.startsWith('@tx5dr/') && typeof version === 'string' && version.startsWith('workspace:')) {
                console.log(name.slice('@tx5dr/'.length));
            }
        }
    "
)

# --- Stage files ---
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

log "Staging package files..."

# Application root
APP_ROOT="$STAGING/usr/share/tx5dr"
mkdir -p "$APP_ROOT"

# --- Copy server dist + runtime workspace packages ---
mkdir -p "$APP_ROOT/packages/server"
cp -r "$PROJECT_ROOT/packages/server/dist" "$APP_ROOT/packages/server/"
cp "$PROJECT_ROOT/packages/server/package.json" "$APP_ROOT/packages/server/"

for pkg in "${SERVER_RUNTIME_WORKSPACES[@]}"; do
    if [[ -d "$PROJECT_ROOT/packages/$pkg/dist" ]]; then
        mkdir -p "$APP_ROOT/packages/$pkg"
        cp -r "$PROJECT_ROOT/packages/$pkg/dist" "$APP_ROOT/packages/$pkg/"
        cp "$PROJECT_ROOT/packages/$pkg/package.json" "$APP_ROOT/packages/$pkg/"
    fi
done

# Root package.json for workspace resolution
cp "$PROJECT_ROOT/package.json" "$APP_ROOT/"

# --- Copy node_modules (skip symlinks, then aggressively clean) ---
log "Copying node_modules (skipping workspace symlinks)..."
mkdir -p "$APP_ROOT/node_modules"
# Copy only real directories/files, skip symlinks (workspace packages like @tx5dr/*)
for entry in "$PROJECT_ROOT/node_modules"/*; do
    entry_name=$(basename "$entry")
    if [[ -L "$entry" ]]; then
        # Skip symlinks — workspace packages are handled separately
        continue
    fi
    cp -r "$entry" "$APP_ROOT/node_modules/"
done

# Recreate @tx5dr workspace symlinks pointing to our packages/ directory.
# The copied root node_modules/@tx5dr directory contains monorepo symlinks, some
# of which do not exist in the server package. Replace it with a clean runtime set.
rm -rf "$APP_ROOT/node_modules/@tx5dr"
mkdir -p "$APP_ROOT/node_modules/@tx5dr"
for pkg in "${SERVER_RUNTIME_WORKSPACES[@]}" server; do
    if [[ -d "$APP_ROOT/packages/$pkg" ]]; then
        ln -sf "../../packages/$pkg" "$APP_ROOT/node_modules/@tx5dr/$pkg"
    fi
done

NM="$APP_ROOT/node_modules"

# === Cleanup: adapted from forge.config.js packageAfterCopy ===
log "Cleaning node_modules (removing dev/frontend/build dependencies)..."

# 1. Remove exact-match packages (dev tools, frontend, build tools, Electron)
REMOVE_PACKAGES=(
    # Electron & related
    electron @electron @electron-forge electron-squirrel-startup
    electron-installer-common electron-installer-debian electron-installer-redhat

    # Build tools / bundlers
    rollup @rollup vite @vitejs esbuild @esbuild postject sucrase
    appdmg jiti @swc webpack

    # Code quality / types
    typescript @types eslint @eslint @eslint-community @typescript-eslint prettier

    # Frontend UI libraries (runtime uses pre-built web/dist)
    @heroui @heroicons @fortawesome caniuse-lite
    tailwindcss tailwind-merge tailwind-variants
    @react-aria @react-stately @react-types @formatjs
    react react-dom framer-motion motion-dom motion-utils
    @internationalized

    # Frontend build/CSS toolchain
    postcss autoprefixer lilconfig postcss-load-config
    react-refresh react-is scheduler csstype

    # Build helpers
    @babel @jridgewell yaml source-map pngjs bluebird rxjs

    # Testing / profiling
    vitest @vitest chai @statelyai autocannon clinic tsx

    # ESLint toolchain residuals
    esquery graphemer espree esrecurse estraverse estree-walker esutils
    acorn acorn-jsx acorn-walk doctrine optionator

    # Electron Forge packaging residuals
    resedit pe-library dir-compare flora-colossus galactus
    got global-agent global-dirs roarr serialize-error
    listr2 ora log-symbols log-update
    sudo-prompt cross-zip sumchecker
    @malept @gar @hapi @jest

    # Other unused
    superjson lodash axios png-to-ico node-gyp segfault-handler
    inquirer @inquirer

    # ML/AI (not used by server)
    @tensorflow

    # Frontend-only packages
    flag-icons showdown i18next i18next-browser-languagedetector react-i18next
    @tanstack recharts d3-array d3-color d3-format d3-interpolate d3-path
    d3-scale d3-shape d3-time d3-time-format victory-vendor
    clsx date-fns

    # Build tools
    cmake-js @clinic insight

    # Turbo
    turbo turbo-darwin-arm64 turbo-darwin-x64 turbo-linux-64 turbo-linux-arm64
)

for pkg in "${REMOVE_PACKAGES[@]}"; do
    rm -rf "$NM/$pkg" 2>/dev/null || true
done

# Remove turbo* glob
find "$NM" -maxdepth 1 -name "turbo*" -exec rm -rf {} + 2>/dev/null || true

# 2. Clean native module source code (only need compiled binaries)
log "Cleaning native module source code..."
rm -rf "$NM/audify/vendor" "$NM/audify/src" "$NM/audify/binding.gyp" 2>/dev/null || true
rm -rf "$NM/naudiodon2/src" "$NM/naudiodon2/binding.gyp" 2>/dev/null || true
# node-datachannel runtime needs dist/ plus build/Release/node_datachannel.node.
# Keep the compiled addon and remove only source/build metadata.
rm -rf "$NM/node-datachannel/src" \
    "$NM/node-datachannel/CMakeLists.txt" \
    "$NM/node-datachannel/BULDING.md" \
    "$NM/node-datachannel/rollup.config.mjs" 2>/dev/null || true
# @discordjs/opus runtime only needs lib/, package.json and prebuild/*.node.
rm -rf "$NM/@discordjs/opus/src" \
    "$NM/@discordjs/opus/deps" \
    "$NM/@discordjs/opus/typings" \
    "$NM/@discordjs/opus/node_modules" \
    "$NM/@discordjs/opus/binding.gyp" 2>/dev/null || true

# 3. Clean .npm cache dirs
find "$NM" -type d -name ".npm" -exec rm -rf {} + 2>/dev/null || true

# 4. Clean non-runtime files (tests, docs, sourcemaps, type defs)
log "Cleaning non-runtime files..."
for dirName in test tests __tests__ docs doc example examples .github; do
    find "$NM" -type d -name "$dirName" -exec rm -rf {} + 2>/dev/null || true
done
find "$NM" -name "*.map" -delete 2>/dev/null || true
find "$NM" -name "*.d.ts" -delete 2>/dev/null || true
find "$NM" -name "*.d.ts.map" -delete 2>/dev/null || true
find "$NM" -name "*.d.cts" -delete 2>/dev/null || true
find "$NM" -name "*.d.mts" -delete 2>/dev/null || true
# Docs and config files
find "$NM" -maxdepth 2 -iname "README*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -iname "CHANGELOG*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -iname "HISTORY*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name ".eslintrc*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name "tsconfig*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name ".prettierrc*" -delete 2>/dev/null || true
find "$NM" -name ".cache" -type d -exec rm -rf {} + 2>/dev/null || true

# 5. Clean cross-platform prebuilds (keep only linux-$ARCH)
log "Cleaning cross-platform prebuilds (keeping linux-${ARCH})..."
KEEP_PREBUILD=""
case "$ARCH" in
    amd64) KEEP_PREBUILD="linux-x64" ;;
    arm64) KEEP_PREBUILD="linux-arm64" ;;
esac
KEEP_OPUS_NEEDLE=""
case "$ARCH" in
    amd64) KEEP_OPUS_NEEDLE="-linux-x64-" ;;
    arm64) KEEP_OPUS_NEEDLE="-linux-arm64-" ;;
esac

for prebuilds_dir in \
    "$NM/wsjtx-lib/prebuilds" \
    "$NM/hamlib/prebuilds" \
    "$NM/@serialport/bindings-cpp/prebuilds"; do
    if [[ -d "$prebuilds_dir" ]]; then
        for subdir in "$prebuilds_dir"/*/; do
            [[ -d "$subdir" ]] || continue
            dir_name=$(basename "$subdir")
            if [[ "$dir_name" != "$KEEP_PREBUILD" ]]; then
                rm -rf "$subdir"
            fi
        done
    fi
done

# Also clean any darwin-*/win32-* prebuilds elsewhere
find "$NM" -path "*/prebuilds/darwin-*" -type d -exec rm -rf {} + 2>/dev/null || true
find "$NM" -path "*/prebuilds/win32-*" -type d -exec rm -rf {} + 2>/dev/null || true
find "$NM" -path "*/prebuilds/android-*" -type d -exec rm -rf {} + 2>/dev/null || true
# Remove the other linux arch
if [[ "$ARCH" == "amd64" ]]; then
    find "$NM" -path "*/prebuilds/linux-arm64" -type d -exec rm -rf {} + 2>/dev/null || true
elif [[ "$ARCH" == "arm64" ]]; then
    find "$NM" -path "*/prebuilds/linux-x64" -type d -exec rm -rf {} + 2>/dev/null || true
fi

# @discordjs/opus uses singular "prebuild" directories named by Node ABI,
# platform and arch, e.g. node-v127-napi-v3-linux-x64-glibc-2.39.
OPUS_PREBUILD_DIR="$NM/@discordjs/opus/prebuild"
if [[ -n "$KEEP_OPUS_NEEDLE" && -d "$OPUS_PREBUILD_DIR" ]]; then
    for subdir in "$OPUS_PREBUILD_DIR"/*/; do
        [[ -d "$subdir" ]] || continue
        dir_name=$(basename "$subdir")
        if [[ "$dir_name" != *"$KEEP_OPUS_NEEDLE"* ]]; then
            rm -rf "$subdir"
        fi
    done
fi

# --- Copy web static files ---
mkdir -p "$APP_ROOT/web"
cp -r "$PROJECT_ROOT/packages/web/dist/." "$APP_ROOT/web/"

# --- Copy nginx template (for postinstall) ---
cp "$PROJECT_ROOT/linux/nginx-site.conf" "$APP_ROOT/nginx-site.conf"
# --- Shared library and install script ---
mkdir -p "$APP_ROOT/lib"
cp "$PROJECT_ROOT/linux/lib/"*.sh "$APP_ROOT/lib/"
cp "$PROJECT_ROOT/linux/install.sh" "$APP_ROOT/install.sh"
chmod 755 "$APP_ROOT/install.sh"

# --- Version file ---
echo "$VERSION" > "$APP_ROOT/version"

# --- CLI script ---
mkdir -p "$STAGING/usr/bin"
cp "$PROJECT_ROOT/linux/tx5dr-cli.sh" "$STAGING/usr/bin/tx5dr"
chmod 755 "$STAGING/usr/bin/tx5dr"

# --- systemd service ---
mkdir -p "$STAGING/lib/systemd/system"
cp "$PROJECT_ROOT/linux/tx5dr.service" "$STAGING/lib/systemd/system/tx5dr.service"

# --- Default config ---
mkdir -p "$STAGING/etc/tx5dr"
cp "$PROJECT_ROOT/linux/config.env" "$STAGING/etc/tx5dr/config.env"

# --- Data directory (must exist in staging for RPM --directories to work) ---
mkdir -p "$STAGING/var/lib/tx5dr"

# --- Calculate size ---
STAGING_SIZE=$(du -sh "$STAGING" | cut -f1)
log "Staged package size: $STAGING_SIZE"

# --- Output directory ---
OUTPUT_DIR="$PROJECT_ROOT/dist"
mkdir -p "$OUTPUT_DIR"

# --- Build packages ---
build_package() {
    local format=$1
    log "Building $format package (v${VERSION}, ${ARCH})..."

    # Remove existing package to allow overwrite
    rm -f "$OUTPUT_DIR"/tx5dr*"${VERSION}"*"${ARCH}"*."${format}" 2>/dev/null || true

    # Package names differ between deb (Debian/Ubuntu) and rpm (Fedora/RHEL)
    local alsa_dep nginx_dep hamlib_dep pulse_dep opus_dep
    if [[ "$format" == "rpm" ]]; then
        alsa_dep="alsa-lib"
        hamlib_dep="hamlib"
        pulse_dep="pulseaudio-libs"
        opus_dep="opus"
    else
        alsa_dep="libasound2"
        hamlib_dep="libhamlib4"
        pulse_dep="libpulse0"
        opus_dep="libopus0"
    fi

    local extra_flags=()
    [[ "$format" == "deb" ]] && extra_flags+=(--deb-no-default-config-files)

    fpm -s dir -t "$format" \
        --name tx5dr \
        --version "$VERSION" \
        --architecture "$ARCH" \
        --description "TX-5DR Digital Radio Server - Ham Radio FT8 Application" \
        --maintainer "BG5DRB <bg5drb@example.com>" \
        --url "https://tx5dr.com" \
        --license "MIT" \
        --category "hamradio" \
        --depends "nodejs >= 20" \
        --depends "nginx" \
        --depends "$alsa_dep" \
        --depends "$pulse_dep" \
        --depends "$hamlib_dep" \
        --depends "$opus_dep" \
        --after-install "$PROJECT_ROOT/linux/postinstall.sh" \
        --before-remove "$PROJECT_ROOT/linux/preremove.sh" \
        --config-files /etc/tx5dr/config.env \
        "${extra_flags[@]}" \
        --directories /var/lib/tx5dr \
        --package "$OUTPUT_DIR/" \
        -C "$STAGING" \
        .

    log "$format package created in $OUTPUT_DIR/"
}

case "$FORMAT" in
    deb)
        build_package deb
        ;;
    rpm)
        build_package rpm
        ;;
    both)
        build_package deb
        build_package rpm
        ;;
    *)
        err "Unknown format: $FORMAT (use: deb, rpm, or both)"
        exit 1
        ;;
esac

# --- Summary ---
echo ""
log "Done! Packages:"
ls -lh "$OUTPUT_DIR"/tx5dr* 2>/dev/null || true
echo ""
log "Install with:"
log "  Debian/Ubuntu: sudo dpkg -i dist/tx5dr_${VERSION}_${ARCH}.deb && sudo apt-get install -f"
log "  RHEL/Fedora:   sudo rpm -i dist/tx5dr-${VERSION}-1.${ARCH}.rpm"
echo ""
log "After install: tx5dr start"
