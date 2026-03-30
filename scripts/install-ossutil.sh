#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="${PROJECT_ROOT}/.tools"
INSTALL_DIR="${TOOLS_DIR}/ossutil"
VERSION="${OSSUTIL_VERSION:-2.2.1}"
ARCHIVE_NAME="ossutil-${VERSION}-linux-amd64.zip"
DOWNLOAD_URL="https://gosspublic.alicdn.com/ossutil/v2/${VERSION}/${ARCHIVE_NAME}"

mkdir -p "$TOOLS_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ossutil from ${DOWNLOAD_URL}"
curl -fsSL -o "${TMP_DIR}/${ARCHIVE_NAME}" "${DOWNLOAD_URL}"
unzip -q "${TMP_DIR}/${ARCHIVE_NAME}" -d "${TMP_DIR}/extracted"

OSSUTIL_BIN="$(find "${TMP_DIR}/extracted" -type f -name ossutil | head -1)"
if [[ -z "${OSSUTIL_BIN}" ]]; then
    echo "Failed to locate ossutil binary after extraction." >&2
    exit 1
fi

install -m 0755 "${OSSUTIL_BIN}" "${INSTALL_DIR}/ossutil"
echo "Installed ossutil to ${INSTALL_DIR}/ossutil"

if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "${INSTALL_DIR}" >> "${GITHUB_PATH}"
fi
