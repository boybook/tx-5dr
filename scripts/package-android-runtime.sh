#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/out/android-runtime"
WORK_DIR="$OUT_DIR/work"
DIST_DIR="$OUT_DIR/dist"
VERSION="nightly"
CHANNEL="nightly"
COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
SHORT="${COMMIT:0:7}"
BUILD_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT_TITLE="$(git -C "$PROJECT_ROOT" show -s --format=%s "$COMMIT" 2>/dev/null || echo "")"
ARTIFACT_NAME="TX-5DR-${VERSION}-android-runtime-linux-arm64.tar.gz"
BASE_URL="${TX5DR_ANDROID_RUNTIME_BASE_URL:-https://dl.tx5dr.com}"
OBJECT_PREFIX="${TX5DR_ANDROID_RUNTIME_OBJECT_PREFIX:-tx-5dr/android-runtime/${CHANNEL}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --commit) COMMIT="$2"; SHORT="${COMMIT:0:7}"; shift 2 ;;
    --commit-title) COMMIT_TITLE="$2"; shift 2 ;;
    --build-timestamp) BUILD_TS="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; WORK_DIR="$OUT_DIR/work"; DIST_DIR="$OUT_DIR/dist"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --object-prefix) OBJECT_PREFIX="$2"; shift 2 ;;
    --no-build) NO_BUILD=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

SAFE_VERSION="$(printf '%s' "$VERSION" | sed 's/[^A-Za-z0-9._-]/./g')"
ARTIFACT_NAME="TX-5DR-${SAFE_VERSION}-android-runtime-linux-arm64.tar.gz"
rm -rf "$WORK_DIR" "$DIST_DIR"
mkdir -p "$WORK_DIR/tx5dr" "$DIST_DIR"

if [[ "${NO_BUILD:-0}" != "1" ]]; then
  node "$PROJECT_ROOT/scripts/prepare-server-build-info.mjs" \
    --channel "$CHANNEL" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --build-timestamp "$BUILD_TS" \
    --distribution generic-server
  (cd "$PROJECT_ROOT" && yarn build)
fi

APP_ROOT="$WORK_DIR/tx5dr"
mkdir -p "$APP_ROOT/packages" "$APP_ROOT/resources"
for pkg in builtin-plugins client-tools contracts core plugin-api rigctld-server server web; do
  mkdir -p "$APP_ROOT/packages/$pkg"
  cp "$PROJECT_ROOT/packages/$pkg/package.json" "$APP_ROOT/packages/$pkg/package.json"
  [[ -d "$PROJECT_ROOT/packages/$pkg/dist" ]] && cp -R "$PROJECT_ROOT/packages/$pkg/dist" "$APP_ROOT/packages/$pkg/dist"
  if [[ "$pkg" == "client-tools" ]]; then
    mkdir -p "$APP_ROOT/packages/client-tools/src"
    cp "$PROJECT_ROOT/packages/client-tools/src/proxy.js" "$APP_ROOT/packages/client-tools/src/proxy.js"
  fi
done
cp -R "$PROJECT_ROOT/resources/models" "$APP_ROOT/resources/models"
cp "$PROJECT_ROOT/package.json" "$APP_ROOT/package.json"
cp "$PROJECT_ROOT/yarn.lock" "$APP_ROOT/yarn.lock"

mkdir -p "$APP_ROOT/node_modules"
rsync -a --delete \
  --exclude='.cache' \
  --exclude='*/test' \
  --exclude='*/tests' \
  "$PROJECT_ROOT/node_modules/" "$APP_ROOT/node_modules/"
rm -rf "$APP_ROOT/node_modules/@tx5dr"
mkdir -p "$APP_ROOT/node_modules/@tx5dr"
for pkg in builtin-plugins client-tools contracts core plugin-api rigctld-server server web; do
  ln -s "../../packages/$pkg" "$APP_ROOT/node_modules/@tx5dr/$pkg"
done

NM="$APP_ROOT/node_modules"

echo "Cleaning Android runtime node_modules..."
REMOVE_PACKAGES=(
  electron @electron electron-builder @electron-builder electron-squirrel-startup
  electron-installer-common electron-installer-debian electron-installer-redhat
  rollup @rollup vite @vitejs esbuild @esbuild postject sucrase
  appdmg jiti @swc webpack
  typescript @types eslint @eslint @eslint-community @typescript-eslint prettier
  @heroui @heroicons @fortawesome caniuse-lite
  tailwindcss tailwind-merge tailwind-variants
  @react-aria @react-stately @react-types @formatjs
  react react-dom framer-motion motion-dom motion-utils
  @internationalized
  postcss autoprefixer lilconfig postcss-load-config
  react-refresh react-is scheduler csstype
  @babel @jridgewell yaml source-map pngjs bluebird rxjs
  vitest @vitest chai @statelyai autocannon clinic tsx
  esquery graphemer espree esrecurse estraverse estree-walker esutils
  acorn acorn-jsx acorn-walk doctrine optionator
  resedit pe-library dir-compare flora-colossus galactus
  got global-agent global-dirs roarr serialize-error
  listr2 ora log-symbols log-update
  sudo-prompt cross-zip sumchecker
  @malept @gar @hapi @jest
  superjson lodash axios png-to-ico node-gyp segfault-handler
  inquirer @inquirer
  @tensorflow
  flag-icons showdown i18next i18next-browser-languagedetector react-i18next
  @tanstack recharts d3-array d3-color d3-format d3-interpolate d3-path
  d3-scale d3-shape d3-time d3-time-format victory-vendor
  clsx date-fns
  cmake-js @clinic
  turbo turbo-darwin-arm64 turbo-darwin-x64 turbo-linux-64 turbo-linux-arm64
)
for pkg in "${REMOVE_PACKAGES[@]}"; do
  rm -rf "$NM/$pkg" 2>/dev/null || true
done
find "$NM" -maxdepth 1 -name "turbo*" -exec rm -rf {} + 2>/dev/null || true

# Keep compiled native payloads but remove source/build/test/documentation bulk.
rm -rf "$NM/audify/vendor" "$NM/audify/src" "$NM/audify/binding.gyp" 2>/dev/null || true
rm -rf "$NM/naudiodon2/src" "$NM/naudiodon2/binding.gyp" 2>/dev/null || true
rm -rf "$NM/node-datachannel/src" \
       "$NM/node-datachannel/CMakeLists.txt" \
       "$NM/node-datachannel/BULDING.md" \
       "$NM/node-datachannel/rollup.config.mjs" 2>/dev/null || true
find "$NM" -type d -name ".npm" -exec rm -rf {} + 2>/dev/null || true
for dirName in test tests __tests__ docs doc example examples .github; do
  find "$NM" -type d -name "$dirName" -exec rm -rf {} + 2>/dev/null || true
done
find "$NM" -name "*.map" -delete 2>/dev/null || true
find "$NM" -name "*.d.ts" -delete 2>/dev/null || true
find "$NM" -name "*.d.ts.map" -delete 2>/dev/null || true
find "$NM" -name "*.d.cts" -delete 2>/dev/null || true
find "$NM" -name "*.d.mts" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -iname "README*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -iname "CHANGELOG*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -iname "HISTORY*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name ".eslintrc*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name "tsconfig*" -delete 2>/dev/null || true
find "$NM" -maxdepth 2 -name ".prettierrc*" -delete 2>/dev/null || true
find "$NM" -name ".cache" -type d -exec rm -rf {} + 2>/dev/null || true

# Keep only Linux arm64 native prebuilds for the Android PRoot Debian runtime.
for prebuilds_dir in \
  "$NM/wsjtx-lib/prebuilds" \
  "$NM/hamlib/prebuilds" \
  "$NM/@serialport/bindings-cpp/prebuilds"; do
  if [[ -d "$prebuilds_dir" ]]; then
    for subdir in "$prebuilds_dir"/*/; do
      [[ -d "$subdir" ]] || continue
      if [[ "$(basename "$subdir")" != "linux-arm64" ]]; then
        rm -rf "$subdir"
      fi
    done
  fi
done
find "$NM" -path '*/prebuilds/darwin-*' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$NM" -path '*/prebuilds/win32-*' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$NM" -path '*/prebuilds/android-*' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$NM" -path '*/prebuilds/linux-x64' -type d -prune -exec rm -rf {} + 2>/dev/null || true
if [[ -d "$NM/onnxruntime-node/bin/napi-v6" ]]; then
  rm -rf "$NM/onnxruntime-node/bin/napi-v6/linux/x64" \
         "$NM/onnxruntime-node/bin/napi-v6/darwin" \
         "$NM/onnxruntime-node/bin/napi-v6/win32" || true
fi

# Android/PRoot cannot enable an executable stack on demand. The Linux server
# and Electron paths use GLIBC_TUNABLES for wsjtx-lib, but Android rejects that
# with EPERM, so clear PT_GNU_STACK on the packaged core library for this
# Android-only runtime artifact.
WSJTX_CORE="$NM/wsjtx-lib/prebuilds/linux-arm64/libwsjtx_core.so"
if [[ -f "$WSJTX_CORE" ]]; then
  python3 - "$WSJTX_CORE" <<'PY'
import struct
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
    raise SystemExit(f"Unsupported ELF format: {path}")

PT_GNU_STACK = 0x6474E551
PF_X = 0x1
phoff = struct.unpack_from("<Q", data, 32)[0]
phentsize = struct.unpack_from("<H", data, 54)[0]
phnum = struct.unpack_from("<H", data, 56)[0]
found = False

for index in range(phnum):
    offset = phoff + index * phentsize
    p_type, p_flags = struct.unpack_from("<II", data, offset)
    if p_type != PT_GNU_STACK:
        continue
    found = True
    if p_flags & PF_X:
        struct.pack_into("<I", data, offset + 4, p_flags & ~PF_X)
    break

if not found:
    raise SystemExit(f"PT_GNU_STACK not found: {path}")

path.write_bytes(data)

verify = bytearray(path.read_bytes())
for index in range(phnum):
    offset = phoff + index * phentsize
    p_type, p_flags = struct.unpack_from("<II", verify, offset)
    if p_type == PT_GNU_STACK and (p_flags & PF_X):
        raise SystemExit(f"Failed to clear executable stack flag: {path}")
PY
fi

tar -C "$APP_ROOT" -czf "$DIST_DIR/$ARTIFACT_NAME" .
SHA256="$(shasum -a 256 "$DIST_DIR/$ARTIFACT_NAME" | awk '{print $1}')"
SIZE="$(node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).size))' "$DIST_DIR/$ARTIFACT_NAME")"
cat > "$DIST_DIR/latest.json" <<JSON
{
  "product": "android-runtime",
  "channel": "$CHANNEL",
  "tag": "$VERSION-android-runtime",
  "version": "$VERSION",
  "commit": "$COMMIT",
  "commit_title": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$COMMIT_TITLE"),
  "published_at": "$BUILD_TS",
  "base_url": "${BASE_URL%/}/${OBJECT_PREFIX#/}",
  "release_notes": "",
  "assets": [
    {
      "name": "$ARTIFACT_NAME",
      "url": "${BASE_URL%/}/${OBJECT_PREFIX#/}/$ARTIFACT_NAME",
      "url_cn": "${BASE_URL%/}/${OBJECT_PREFIX#/}/$ARTIFACT_NAME",
      "url_oss": "${BASE_URL%/}/${OBJECT_PREFIX#/}/$ARTIFACT_NAME",
      "url_global": "${BASE_URL%/}/${OBJECT_PREFIX#/}/$ARTIFACT_NAME",
      "sha256": "$SHA256",
      "size": $SIZE,
      "platform": "android",
      "arch": "arm64",
      "package_type": "tar.gz"
    }
  ]
}
JSON

echo "Artifact: $DIST_DIR/$ARTIFACT_NAME"
echo "Manifest: $DIST_DIR/latest.json"
