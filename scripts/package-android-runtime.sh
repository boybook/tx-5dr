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
BASE_URL="${TX5DR_ANDROID_RUNTIME_BASE_URL:-https://tx5dr.oss-cn-hangzhou.aliyuncs.com}"
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

ARTIFACT_NAME="TX-5DR-${VERSION}-android-runtime-linux-arm64.tar.gz"
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
  --exclude='*/src' \
  --exclude='*/test' \
  --exclude='*/tests' \
  "$PROJECT_ROOT/node_modules/" "$APP_ROOT/node_modules/"
rm -rf "$APP_ROOT/node_modules/@tx5dr"
mkdir -p "$APP_ROOT/node_modules/@tx5dr"
for pkg in builtin-plugins client-tools contracts core plugin-api rigctld-server server web; do
  ln -s "../../packages/$pkg" "$APP_ROOT/node_modules/@tx5dr/$pkg"
done

# Keep Linux arm64 native prebuilds only where packages provide multiple platforms.
find "$APP_ROOT/node_modules" -path '*/prebuilds/darwin-*' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP_ROOT/node_modules" -path '*/prebuilds/win32-*' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP_ROOT/node_modules" -path '*/prebuilds/linux-x64' -type d -prune -exec rm -rf {} + 2>/dev/null || true
if [[ -d "$APP_ROOT/node_modules/onnxruntime-node/bin/napi-v6" ]]; then
  rm -rf "$APP_ROOT/node_modules/onnxruntime-node/bin/napi-v6/linux/x64" \
         "$APP_ROOT/node_modules/onnxruntime-node/bin/napi-v6/darwin" \
         "$APP_ROOT/node_modules/onnxruntime-node/bin/napi-v6/win32" || true
fi

tar -C "$APP_ROOT" -czf "$DIST_DIR/$ARTIFACT_NAME" .
SHA256="$(shasum -a 256 "$DIST_DIR/$ARTIFACT_NAME" | awk '{print $1}')"
SIZE="$(stat -f %z "$DIST_DIR/$ARTIFACT_NAME" 2>/dev/null || stat -c %s "$DIST_DIR/$ARTIFACT_NAME")"
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
