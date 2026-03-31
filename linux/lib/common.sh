#!/bin/bash
# TX-5DR shared shell library: i18n, logging, OS detection, utilities
# Source this file from other scripts: source "$(dirname "$0")/lib/common.sh"

# ── i18n ─────────────────────────────────────────────────────────────────────

detect_lang() {
    local lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}"
    case "$lang" in
        zh_CN*|zh_TW*|zh_HK*|zh.*) TX5DR_LANG="zh" ;;
        *) TX5DR_LANG="en" ;;
    esac
}
detect_lang

# Message lookup: msg KEY [printf args...]
# Uses MSG_EN_<KEY> / MSG_ZH_<KEY> variables defined below
msg() {
    local key="$1"; shift
    local var_name="MSG_${TX5DR_LANG^^}_${key}"
    local fallback="MSG_EN_${key}"
    local text="${!var_name:-${!fallback:-$key}}"
    if [[ $# -gt 0 ]]; then
        printf "$text" "$@"
    else
        printf "%s" "$text"
    fi
}

# ── Message definitions ──────────────────────────────────────────────────────

# install.sh / general
MSG_EN_CHECKING_ENV="Checking system environment..."
MSG_ZH_CHECKING_ENV="正在检查系统环境..."
MSG_EN_STEP="Step %s/%s"
MSG_ZH_STEP="步骤 %s/%s"
MSG_EN_ALL_CHECKS_PASSED="All checks passed."
MSG_ZH_ALL_CHECKS_PASSED="所有检查已通过。"
MSG_EN_ISSUES_FOUND="Found %s issue(s)."
MSG_ZH_ISSUES_FOUND="发现 %s 个问题。"

# start/stop
MSG_EN_STARTING="Starting TX-5DR server..."
MSG_ZH_STARTING="正在启动 TX-5DR 服务器..."
MSG_EN_STOPPING="Stopping TX-5DR server..."
MSG_ZH_STOPPING="正在停止 TX-5DR 服务器..."
MSG_EN_RESTARTING="Restarting TX-5DR server..."
MSG_ZH_RESTARTING="正在重启 TX-5DR 服务器..."
MSG_EN_START_OK="TX-5DR is running."
MSG_ZH_START_OK="TX-5DR 已运行。"
MSG_EN_STOP_OK="TX-5DR stopped."
MSG_ZH_STOP_OK="TX-5DR 已停止。"
MSG_EN_START_FAIL="Server failed to start. Recent logs:"
MSG_ZH_START_FAIL="服务器启动失败。最近日志："
MSG_EN_RUN_DOCTOR="Run 'tx5dr doctor' to diagnose the issue."
MSG_ZH_RUN_DOCTOR="运行 'tx5dr doctor' 诊断问题。"
MSG_EN_OPEN_URL="Open the URL above in your browser to access TX-5DR"
MSG_ZH_OPEN_URL="在浏览器中打开上方链接即可访问 TX-5DR"

# ports
MSG_EN_PORT_READY="Port %s ready"
MSG_ZH_PORT_READY="端口 %s 就绪"
MSG_EN_PORT_FAIL="Port %s not responding after %ss"
MSG_ZH_PORT_FAIL="端口 %s 在 %s 秒后无响应"
MSG_EN_PORT_IN_USE="Port %s is already in use"
MSG_ZH_PORT_IN_USE="端口 %s 已被占用"

# token
MSG_EN_TOKEN_LABEL="Admin Token"
MSG_ZH_TOKEN_LABEL="管理员令牌"
MSG_EN_TOKEN_NOT_FOUND="Admin token file not found. Start the server first."
MSG_ZH_TOKEN_NOT_FOUND="未找到管理员令牌文件。请先启动服务器。"
MSG_EN_TOKEN_RESET="Token reset. Restarting server..."
MSG_ZH_TOKEN_RESET="令牌已重置。正在重启服务器..."

# doctor / checks
MSG_EN_CHECK_NODEJS="Node.js version"
MSG_ZH_CHECK_NODEJS="Node.js 版本"
MSG_EN_CHECK_GLIBCXX="GLIBCXX_3.4.32"
MSG_ZH_CHECK_GLIBCXX="GLIBCXX_3.4.32"
MSG_EN_CHECK_GLIBC="glibc version"
MSG_ZH_CHECK_GLIBC="glibc 版本"
MSG_EN_CHECK_NGINX_INSTALLED="nginx installed"
MSG_ZH_CHECK_NGINX_INSTALLED="nginx 已安装"
MSG_EN_CHECK_NGINX_CONFIG="nginx config valid"
MSG_ZH_CHECK_NGINX_CONFIG="nginx 配置有效"
MSG_EN_CHECK_NGINX_RUNNING="nginx running"
MSG_ZH_CHECK_NGINX_RUNNING="nginx 运行中"
MSG_EN_CHECK_NGINX_REALTIME_PROXY="nginx realtime WS proxy"
MSG_ZH_CHECK_NGINX_REALTIME_PROXY="nginx 实时语音 WS 代理"
MSG_EN_CHECK_SERVICE="TX-5DR service"
MSG_ZH_CHECK_SERVICE="TX-5DR 服务"
MSG_EN_CHECK_LIVEKIT_BINARY="LiveKit binary"
MSG_ZH_CHECK_LIVEKIT_BINARY="LiveKit 二进制"
MSG_EN_CHECK_LIVEKIT_CONFIG="LiveKit config"
MSG_ZH_CHECK_LIVEKIT_CONFIG="LiveKit 配置"
MSG_EN_CHECK_LIVEKIT_URL="LiveKit bridge URL"
MSG_ZH_CHECK_LIVEKIT_URL="LiveKit 桥接 URL"
MSG_EN_CHECK_LIVEKIT_SERVICE="LiveKit service"
MSG_ZH_CHECK_LIVEKIT_SERVICE="LiveKit 服务"
MSG_EN_CHECK_LIVEKIT_SIGNAL_PORT="LiveKit signaling port %s"
MSG_ZH_CHECK_LIVEKIT_SIGNAL_PORT="LiveKit signaling 端口 %s"
MSG_EN_CHECK_LIVEKIT_TCP_PORT="LiveKit RTC TCP port %s"
MSG_ZH_CHECK_LIVEKIT_TCP_PORT="LiveKit RTC TCP 端口 %s"
MSG_EN_CHECK_LIVEKIT_UDP_RANGE="LiveKit UDP range %s-%s"
MSG_ZH_CHECK_LIVEKIT_UDP_RANGE="LiveKit UDP 范围 %s-%s"
MSG_EN_CHECK_LIVEKIT_CREDENTIALS="LiveKit credentials"
MSG_ZH_CHECK_LIVEKIT_CREDENTIALS="LiveKit 凭据"
MSG_EN_CHECK_LIVEKIT_CREDENTIAL_FILE="LiveKit credential file"
MSG_ZH_CHECK_LIVEKIT_CREDENTIAL_FILE="LiveKit 凭据文件"
MSG_EN_CHECK_PORT_BACKEND="Backend port %s"
MSG_ZH_CHECK_PORT_BACKEND="后端端口 %s"
MSG_EN_CHECK_PORT_HTTP="HTTP port %s"
MSG_ZH_CHECK_PORT_HTTP="HTTP 端口 %s"
MSG_EN_CHECK_USER="tx5dr user"
MSG_ZH_CHECK_USER="tx5dr 用户"
MSG_EN_CHECK_DISK="Disk space"
MSG_ZH_CHECK_DISK="磁盘空间"

MSG_EN_FIX_NODEJS="Install Node.js: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
MSG_ZH_FIX_NODEJS="安装 Node.js: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
MSG_EN_FIX_GLIBCXX="Run: sudo bash /usr/share/tx5dr/install.sh"
MSG_ZH_FIX_GLIBCXX="运行: sudo bash /usr/share/tx5dr/install.sh"
MSG_EN_FIX_NGINX="Install nginx manually: sudo dnf install nginx  or  sudo apt install nginx"
MSG_ZH_FIX_NGINX="请手动安装 nginx：sudo dnf install nginx  或  sudo apt install nginx"
MSG_EN_FIX_NGINX_REALTIME_PROXY="Repair nginx ws-compat proxy: sudo tx5dr doctor --fix"
MSG_ZH_FIX_NGINX_REALTIME_PROXY="修复 nginx 的 ws-compat 代理: sudo tx5dr doctor --fix"
MSG_EN_FIX_LIVEKIT_BINARY="Reinstall the tx5dr package, or install manually: curl -sSL https://get.livekit.io | bash"
MSG_ZH_FIX_LIVEKIT_BINARY="重新安装 tx5dr 软件包，或手动安装: curl -sSL https://get.livekit.io | bash"
MSG_EN_FIX_LIVEKIT_CONFIG="Regenerate config: sudo rm -f /etc/tx5dr/livekit.yaml && sudo /usr/share/tx5dr/postinstall.sh"
MSG_ZH_FIX_LIVEKIT_CONFIG="重新生成配置: sudo rm -f /etc/tx5dr/livekit.yaml && sudo /usr/share/tx5dr/postinstall.sh"
MSG_EN_FIX_LIVEKIT_CREDENTIALS="Regenerate credentials: sudo tx5dr livekit-creds rotate"
MSG_ZH_FIX_LIVEKIT_CREDENTIALS="重新生成凭据: sudo tx5dr livekit-creds rotate"

MSG_EN_INSTALLING_NODEJS="Installing Node.js 22..."
MSG_ZH_INSTALLING_NODEJS="正在安装 Node.js 22..."
MSG_EN_UPGRADING_GLIBCXX="Upgrading libstdc++6 for GLIBCXX_3.4.32..."
MSG_ZH_UPGRADING_GLIBCXX="正在升级 libstdc++6 以支持 GLIBCXX_3.4.32..."
MSG_EN_GLIBCXX_WARN="This may also upgrade libc6 (glibc). Service file already has GLIBC_TUNABLES configured."
MSG_ZH_GLIBCXX_WARN="此操作可能连带升级 libc6 (glibc)。服务文件已配置 GLIBC_TUNABLES。"
MSG_EN_INSTALLING_NGINX="Installing nginx..."
MSG_ZH_INSTALLING_NGINX="正在安装 nginx..."

MSG_EN_UPGRADING="Upgrading TX-5DR..."
MSG_ZH_UPGRADING="正在升级 TX-5DR..."
MSG_EN_UPGRADE_OK="TX-5DR upgraded successfully."
MSG_ZH_UPGRADE_OK="TX-5DR 升级完成。"
MSG_EN_CHECKING_UPDATE="Checking for updates..."
MSG_ZH_CHECKING_UPDATE="正在检查更新..."
MSG_EN_DOWNLOADING="Downloading %s..."
MSG_ZH_DOWNLOADING="正在下载 %s..."
MSG_EN_ALREADY_LATEST="Already up to date."
MSG_ZH_ALREADY_LATEST="已是最新版本。"
MSG_EN_UPDATE_AVAILABLE="Update available: %s → %s"
MSG_ZH_UPDATE_AVAILABLE="有可用更新: %s → %s"
MSG_EN_UPDATE_DONE="Update complete. Restarted."
MSG_ZH_UPDATE_DONE="更新完成，已重启。"
MSG_EN_UPDATE_FAILED="Update failed."
MSG_ZH_UPDATE_FAILED="更新失败。"

MSG_EN_CHECK_SSL="HTTPS (SSL)"
MSG_ZH_CHECK_SSL="HTTPS (SSL)"
MSG_EN_SSL_OK="configured (port %s)"
MSG_ZH_SSL_OK="已配置（端口 %s）"
MSG_EN_SSL_NOT_CONFIGURED="not configured"
MSG_ZH_SSL_NOT_CONFIGURED="未配置"
MSG_EN_SSL_HINT="Voice features require HTTPS (browser microphone access).\n      Configure SSL in: /etc/nginx/conf.d/tx5dr.conf\n      See nginx SSL docs: https://nginx.org/en/docs/http/configuring_https_servers.html"
MSG_ZH_SSL_HINT="语音通联功能需要 HTTPS（浏览器麦克风权限要求）。\n      请在此文件中按 nginx 标准方式配置 SSL: /etc/nginx/conf.d/tx5dr.conf\n      参考文档: https://nginx.org/en/docs/http/configuring_https_servers.html"

MSG_EN_REQUIRE_ROOT="This command must be run as root (sudo)."
MSG_ZH_REQUIRE_ROOT="此命令需要 root 权限 (sudo)。"

# ── Colored logging ──────────────────────────────────────────────────────────

if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
    _RED='\033[0;31m'; _GREEN='\033[0;32m'; _YELLOW='\033[1;33m'
    _BLUE='\033[0;34m'; _BOLD='\033[1m'; _DIM='\033[2m'; _NC='\033[0m'
else
    _RED=''; _GREEN=''; _YELLOW=''; _BLUE=''; _BOLD=''; _DIM=''; _NC=''
fi

log_info()  { echo -e "${_GREEN}[INFO]${_NC}  $*"; }
log_warn()  { echo -e "${_YELLOW}[WARN]${_NC}  $*"; }
log_error() { echo -e "${_RED}[ERROR]${_NC} $*"; }
log_step()  { echo -e "${_BLUE}[STEP]${_NC}  ${_BOLD}$*${_NC}"; }
log_ok()    { echo -e "  ${_GREEN}✓${_NC} $*"; }
log_fail()  { echo -e "  ${_RED}✗${_NC} $*"; }

# doctor output: check_line LABEL STATUS [DETAIL]
check_line() {
    local label="$1" status="$2" detail="${3:-}"
    local padded
    padded=$(printf "%-30s" "$label")
    if [[ "$status" == "ok" ]]; then
        echo -e "  ${_GREEN}[✓]${_NC} ${padded} ${_DIM}${detail}${_NC}"
    else
        echo -e "  ${_RED}[✗]${_NC} ${padded} ${_RED}${detail}${_NC}"
    fi
}

# ── OS detection ─────────────────────────────────────────────────────────────

detect_os() {
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_VERSION_ID="${VERSION_ID:-0}"
        OS_CODENAME="${VERSION_CODENAME:-unknown}"
        OS_ID_LIKE="${ID_LIKE:-}"
    else
        OS_ID="unknown"; OS_VERSION_ID="0"; OS_CODENAME="unknown"; OS_ID_LIKE=""
    fi
    ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    case "$ARCH" in
        x86_64)  ARCH="amd64" ;;
        aarch64) ARCH="arm64" ;;
    esac
}

# Returns the OS package family: "debian", "rhel", or "unknown"
# Falls back to ID_LIKE if OS_ID is not directly recognized (e.g. fedora-asahi-remix)
os_family() {
    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop) echo "debian"; return ;;
        rhel|centos|fedora|rocky|alma) echo "rhel"; return ;;
    esac
    case "${OS_ID_LIKE:-}" in
        *fedora*|*rhel*|*centos*) echo "rhel"; return ;;
        *debian*|*ubuntu*) echo "debian"; return ;;
    esac
    echo "unknown"
}

# ── Utilities ────────────────────────────────────────────────────────────────

require_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "$(msg REQUIRE_ROOT)"
        exit 1
    fi
}

env_file_has_key() {
    local file="$1" key="$2"
    local content
    content=$(read_file_maybe_sudo "$file" 2>/dev/null || true)
    [[ -n "$content" ]] || return 1
    printf "%s\n" "$content" | grep -Eq "^[[:space:]]*${key}="
}

read_env_file_value() {
    local file="$1" key="$2"
    local content
    content=$(read_file_maybe_sudo "$file" 2>/dev/null || true)
    [[ -n "$content" ]] || return 1
    printf "%s\n" "$content" | grep -E "^[[:space:]]*${key}=" | head -1 | cut -d= -f2-
}

# Load TX-5DR config
load_config() {
    local config_env="/etc/tx5dr/config.env"
    local inherited_livekit_api_key="${LIVEKIT_API_KEY:-}"
    local inherited_livekit_api_secret="${LIVEKIT_API_SECRET:-}"
    local config_file_livekit_override=0

    unset LIVEKIT_API_KEY LIVEKIT_API_SECRET

    if env_file_has_key "$config_env" "LIVEKIT_API_KEY" && env_file_has_key "$config_env" "LIVEKIT_API_SECRET"; then
        config_file_livekit_override=1
    fi

    if [[ -f /etc/tx5dr/config.env ]]; then
        # shellcheck disable=SC1091
        source /etc/tx5dr/config.env 2>/dev/null || true
    fi

    LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE=0
    LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE=""
    LIVEKIT_CREDENTIALS_FILE="${LIVEKIT_CREDENTIALS_FILE:-/etc/tx5dr/livekit-credentials.env}"

    local managed_livekit_api_key=""
    local managed_livekit_api_secret=""
    managed_livekit_api_key=$(read_env_file_value "${LIVEKIT_CREDENTIALS_FILE}" "LIVEKIT_API_KEY" 2>/dev/null || true)
    managed_livekit_api_secret=$(read_env_file_value "${LIVEKIT_CREDENTIALS_FILE}" "LIVEKIT_API_SECRET" 2>/dev/null || true)

    if [[ -n "$inherited_livekit_api_key" && -n "$inherited_livekit_api_secret" ]]; then
        if [[ -z "$managed_livekit_api_key" || -z "$managed_livekit_api_secret" \
           || "$inherited_livekit_api_key" != "$managed_livekit_api_key" \
           || "$inherited_livekit_api_secret" != "$managed_livekit_api_secret" ]]; then
            LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE=1
            LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE="environment"
        fi
        LIVEKIT_API_KEY="$inherited_livekit_api_key"
        LIVEKIT_API_SECRET="$inherited_livekit_api_secret"
    elif [[ $config_file_livekit_override -eq 1 && -n "${LIVEKIT_API_KEY:-}" && -n "${LIVEKIT_API_SECRET:-}" ]]; then
        if [[ -z "$managed_livekit_api_key" || -z "$managed_livekit_api_secret" \
           || "${LIVEKIT_API_KEY}" != "$managed_livekit_api_key" \
           || "${LIVEKIT_API_SECRET}" != "$managed_livekit_api_secret" ]]; then
            LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE=1
            LIVEKIT_CREDENTIAL_OVERRIDE_SOURCE="$config_env"
        fi
    fi

    if [[ "${LIVEKIT_CREDENTIAL_OVERRIDE_ACTIVE:-0}" != "1" && (-z "${LIVEKIT_API_KEY:-}" || -z "${LIVEKIT_API_SECRET:-}") ]]; then
        [[ -n "$managed_livekit_api_key" ]] && LIVEKIT_API_KEY="$managed_livekit_api_key"
        [[ -n "$managed_livekit_api_secret" ]] && LIVEKIT_API_SECRET="$managed_livekit_api_secret"
    fi

    HTTP_PORT="${TX5DR_HTTP_PORT:-8076}"
    API_PORT="${PORT:-4000}"
    LIVEKIT_SIGNAL_PORT="${LIVEKIT_SIGNAL_PORT:-7880}"
    LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
    LIVEKIT_UDP_PORT_START="${LIVEKIT_UDP_PORT_START:-50000}"
    LIVEKIT_UDP_PORT_END="${LIVEKIT_UDP_PORT_END:-50100}"
    LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-}"
    LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-}"
    LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:${LIVEKIT_SIGNAL_PORT}}"
    LIVEKIT_CONFIG_FILE="${LIVEKIT_CONFIG_FILE:-/etc/tx5dr/livekit.yaml}"
    CONFIG_DIR="${TX5DR_CONFIG_DIR:-/var/lib/tx5dr/config}"
    DATA_DIR="${TX5DR_DATA_DIR:-/var/lib/tx5dr}"
    TX5DR_GITHUB_REPO="${TX5DR_GITHUB_REPO:-boybook/tx-5dr}"
    TX5DR_DOWNLOAD_BASE_URL="${TX5DR_DOWNLOAD_BASE_URL:-}"
    TX5DR_DOWNLOAD_SOURCE="${TX5DR_DOWNLOAD_SOURCE:-auto}"
}

get_download_base_url() {
    if [[ -z "${TX5DR_DOWNLOAD_BASE_URL:-}" ]]; then
        return 1
    fi
    normalize_remote_url "${TX5DR_DOWNLOAD_BASE_URL%/}"
}

get_server_manifest_url() {
    local base_url
    base_url=$(get_download_base_url) || return 1
    printf "%s/tx-5dr/server/latest.json" "$base_url"
}

get_server_latest_install_script_url() {
    local base_url
    base_url=$(get_download_base_url) || return 1
    printf "%s/tx-5dr/server/latest/install-online.sh" "$base_url"
}

normalize_remote_url() {
    local value="${1:-}"
    if [[ -z "$value" ]]; then
        return 1
    fi
    case "$value" in
        http://*|https://*)
            printf "%s" "$value"
            ;;
        //*)
            printf "https:%s" "$value"
            ;;
        *)
            printf "https://%s" "$value"
            ;;
    esac
}

get_github_release_asset_url() {
    local tag="$1" asset_name="$2"
    printf "https://github.com/%s/releases/download/%s/%s" "${TX5DR_GITHUB_REPO:-boybook/tx-5dr}" "$tag" "$asset_name"
}

fetch_server_manifest() {
    local manifest_url
    manifest_url=$(get_server_manifest_url) || return 1
    curl -fsSL "$manifest_url"
}

normalize_country_code() {
    local value="${1:-}"
    value=$(printf "%s" "$value" | tr -d '\r\n[:space:]' | tr '[:lower:]' '[:upper:]')
    [[ ${#value} -eq 2 ]] || return 1
    printf "%s" "$value"
}

fetch_country_code() {
    local response country

    response=$(curl -fsSL --connect-timeout 2 --max-time 4 https://ipinfo.io/country 2>/dev/null || true)
    country=$(normalize_country_code "$response" 2>/dev/null || true)
    [[ -n "$country" ]] && { printf "%s" "$country"; return 0; }

    response=$(curl -fsSL --connect-timeout 2 --max-time 4 https://ifconfig.co/country-iso 2>/dev/null || true)
    country=$(normalize_country_code "$response" 2>/dev/null || true)
    [[ -n "$country" ]] && { printf "%s" "$country"; return 0; }

    response=$(curl -fsSL --connect-timeout 2 --max-time 4 https://ipapi.co/country/ 2>/dev/null || true)
    country=$(normalize_country_code "$response" 2>/dev/null || true)
    [[ -n "$country" ]] && { printf "%s" "$country"; return 0; }

    response=$(curl -fsSL --connect-timeout 2 --max-time 4 https://api.country.is/ 2>/dev/null || true)
    country=$(printf "%s" "$response" | tr -d '\n' | grep -oP '"country"\s*:\s*"\K[A-Z]{2}' | head -1 || true)
    [[ -n "$country" ]] && { printf "%s" "$country"; return 0; }

    return 1
}

is_mainland_china() {
    local country
    country=$(fetch_country_code 2>/dev/null || true)
    [[ "$country" == "CN" ]]
}

should_prefer_oss_download() {
    case "${TX5DR_DOWNLOAD_SOURCE:-auto}" in
        oss|aliyun)
            [[ -n "${TX5DR_DOWNLOAD_BASE_URL:-}" ]]
            return
            ;;
        github)
            return 1
            ;;
        auto|"")
            [[ -n "${TX5DR_DOWNLOAD_BASE_URL:-}" ]] || return 1
            is_mainland_china
            return
            ;;
        *)
            return 1
            ;;
    esac
}

manifest_lookup_value() {
    local manifest_json="$1" lookup_key="$2"
    if command -v node >/dev/null 2>&1; then
        printf "%s" "$manifest_json" | env LOOKUP_KEY="$lookup_key" node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const key = process.env.LOOKUP_KEY;
if (!key) process.exit(1);
try {
  const data = JSON.parse(input);
  const value = data[key];
  if (typeof value === "string") {
    process.stdout.write(value);
  }
} catch {
  process.exit(1);
}
'
        return
    fi

    printf "%s" "$manifest_json" | tr -d '\n' | grep -oP "\"${lookup_key}\":\\s*\"\\K[^\"]+" | head -1
}

get_server_manifest_package_url() {
    local manifest_json="$1" pkg_arch="$2" pkg_ext="$3"
    local value=""
    value=$(manifest_lookup_value "$manifest_json" "latest_url_${pkg_arch}_${pkg_ext}")
    [[ -n "$value" ]] || return 1
    normalize_remote_url "$value"
}

get_server_manifest_package_sha256() {
    local manifest_json="$1" pkg_arch="$2" pkg_ext="$3"
    manifest_lookup_value "$manifest_json" "latest_sha256_${pkg_arch}_${pkg_ext}"
}

get_server_manifest_commit() {
    local manifest_json="$1"
    manifest_lookup_value "$manifest_json" "commit"
}

get_server_manifest_published_at() {
    local manifest_json="$1"
    manifest_lookup_value "$manifest_json" "published_at"
}

get_livekit_binary_path() {
    local bundled="${LIVEKIT_BINARY_PATH:-/usr/share/tx5dr/bin/livekit-server}"
    if [[ -x "$bundled" ]]; then
        printf "%s" "$bundled"
        return 0
    fi

    command -v livekit-server 2>/dev/null || return 1
}

get_livekit_config_path() {
    printf "%s" "${LIVEKIT_CONFIG_FILE:-/etc/tx5dr/livekit.yaml}"
}

get_livekit_credentials_path() {
    printf "%s" "${LIVEKIT_CREDENTIALS_FILE:-/etc/tx5dr/livekit-credentials.env}"
}

read_file_maybe_sudo() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        return 1
    fi
    if [[ -r "$file" || $EUID -eq 0 ]]; then
        cat "$file"
        return 0
    fi
    sudo cat "$file" 2>/dev/null
}

can_read_file_noninteractive() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        return 1
    fi
    if [[ -r "$file" || $EUID -eq 0 ]]; then
        return 0
    fi
    sudo -n test -r "$file" 2>/dev/null
}

get_url_port() {
    local url="$1"
    local rest="${url#*://}"
    local host_port="${rest%%/*}"
    if [[ "$host_port" == *:* ]]; then
        printf "%s" "${host_port##*:}"
        return 0
    fi
    case "$url" in
        wss://*|https://*) printf "443" ;;
        *) printf "80" ;;
    esac
}

# Wait for a TCP port to become available
# Usage: wait_for_port PORT [TIMEOUT_SECONDS]
wait_for_port() {
    local port=$1 timeout=${2:-10} elapsed=0
    while ! ss -tlnp 2>/dev/null | grep -q ":${port} "; do
        sleep 1
        elapsed=$((elapsed + 1))
        if [[ $elapsed -ge $timeout ]]; then
            return 1
        fi
    done
    return 0
}

# Check if a port is open
is_port_open() {
    ss -tlnp 2>/dev/null | grep -q ":${1} "
}

list_udp_ports_in_range() {
    local start_port="$1"
    local end_port="$2"
    ss -ulnH 2>/dev/null | awk -v start="$start_port" -v end="$end_port" '
        {
            n = split($5, parts, ":");
            port = parts[n];
            gsub(/[^0-9]/, "", port);
            if (port >= start && port <= end) {
                print port;
            }
        }
    ' | sort -n -u
}

count_udp_ports_in_range() {
    local start_port="$1"
    local end_port="$2"
    local count
    count=$(list_udp_ports_in_range "$start_port" "$end_port" | wc -l | tr -d ' ')
    printf "%s" "${count:-0}"
}

get_systemd_state() {
    local service_name="$1"
    local active_state
    local sub_state
    active_state=$(systemctl is-active "$service_name" 2>/dev/null || true)
    sub_state=$(systemctl show "$service_name" --property=SubState --value 2>/dev/null || true)

    if [[ -n "$sub_state" && "$sub_state" != "$active_state" ]]; then
        printf "%s/%s" "${active_state:-unknown}" "$sub_state"
        return 0
    fi

    printf "%s" "${active_state:-unknown}"
}

# Get local non-loopback IPv4 address
get_local_ip() {
    ip -4 route get 1.0.0.0 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true
}

# Read admin token from config directory
read_admin_token() {
    local token_file="${CONFIG_DIR:=/var/lib/tx5dr/config}/.admin-token"
    if [[ -f "$token_file" ]]; then
        cat "$token_file" 2>/dev/null
    fi
}

# Build full Web UI URL with auth token
get_web_url() {
    local ip
    ip=$(get_local_ip)
    local token
    token=$(read_admin_token)
    local base="http://${ip:-localhost}:${HTTP_PORT:-8076}"
    if [[ -n "$token" ]]; then
        echo "${base}?auth_token=${token}"
    else
        echo "$base"
    fi
}

# Get glibc major.minor version as a comparable integer (e.g. 2.41 → 241)
get_glibc_version_int() {
    local ver
    ver=$(ldd --version 2>&1 | grep -oP '\d+\.\d+' | head -1 || true)
    if [[ -n "$ver" ]]; then
        echo "$ver" | awk -F. '{printf "%d%02d", $1, $2}'
    else
        echo "0"
    fi
}
