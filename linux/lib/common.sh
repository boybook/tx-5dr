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
MSG_EN_CHECK_SERVICE="TX-5DR service"
MSG_ZH_CHECK_SERVICE="TX-5DR 服务"
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
MSG_EN_FIX_NGINX="Install nginx: sudo apt install -y nginx"
MSG_ZH_FIX_NGINX="安装 nginx: sudo apt install -y nginx"

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
    else
        OS_ID="unknown"; OS_VERSION_ID="0"; OS_CODENAME="unknown"
    fi
    ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    case "$ARCH" in
        x86_64)  ARCH="amd64" ;;
        aarch64) ARCH="arm64" ;;
    esac
}

# ── Utilities ────────────────────────────────────────────────────────────────

require_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "$(msg REQUIRE_ROOT)"
        exit 1
    fi
}

# Load TX-5DR config
load_config() {
    if [[ -f /etc/tx5dr/config.env ]]; then
        # shellcheck disable=SC1091
        source /etc/tx5dr/config.env 2>/dev/null || true
    fi
    HTTP_PORT="${TX5DR_HTTP_PORT:-8076}"
    API_PORT="${PORT:-4000}"
    CONFIG_DIR="${TX5DR_CONFIG_DIR:-/var/lib/tx5dr/config}"
    DATA_DIR="${TX5DR_DATA_DIR:-/var/lib/tx5dr}"
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

# Get local non-loopback IPv4 address
get_local_ip() {
    ip -4 route get 1.0.0.0 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1
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
    ver=$(ldd --version 2>&1 | head -1 | grep -oP '\d+\.\d+' | tail -1)
    if [[ -n "$ver" ]]; then
        echo "$ver" | awk -F. '{printf "%d%02d", $1, $2}'
    else
        echo "0"
    fi
}
