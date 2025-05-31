# 🚀 TX-5DR

## 📋 前置要求

- **Node.js** 20+ 
- **Yarn** 4+ (Berry)
- **Git**

### 安装 Yarn 4

本项目使用 yarn 4 进行项目管理，请按照如下说明安装。

#### 方法一：使用 Corepack（推荐）

Node.js 16.10+ 内置了 Corepack，可以直接使用：

```bash
# 启用 Corepack
corepack enable

# 设置 Yarn 版本
corepack prepare yarn@4.1.1 --activate
```

#### 方法二：手动安装

```bash
# 1. 创建项目目录
mkdir my-project
cd my-project

# 2. 初始化 Yarn
yarn init -2

# 3. 验证安装
yarn --version
```

#### 平台特定说明

##### Linux/macOS
```bash
# 如果遇到权限问题，可能需要使用 sudo
sudo corepack enable

# 验证安装
yarn --version
```

##### Windows
```powershell
# 以管理员身份运行 PowerShell
corepack enable

# 验证安装
yarn --version
```

### 平台特定依赖

#### Linux (Ubuntu/Debian)
```bash
# 安装基础构建工具和依赖
sudo apt-get update
sudo apt-get install -y \
  cmake \
  build-essential \
  gfortran \
  libfftw3-dev \
  libboost-all-dev \
  pkg-config

# ARM64 架构额外依赖
sudo apt-get install -y \
  gcc-aarch64-linux-gnu \
  g++-aarch64-linux-gnu \
  gfortran-aarch64-linux-gnu
sudo dpkg --add-architecture arm64
sudo apt-get update
sudo apt-get install -y \
  libfftw3-dev:arm64 \
  libboost-all-dev:arm64
```

#### macOS
```bash
# 使用 Homebrew 安装依赖
brew install cmake fftw boost gcc pkg-config

# 设置环境变量（根据架构）
if [ "$(uname -m)" = "arm64" ]; then
  # Apple Silicon (ARM64)
  BREW_PREFIX="/opt/homebrew"
else
  # Intel (x64)
  BREW_PREFIX="/usr/local"
fi

# 确保 brew 路径在 PATH 中
echo 'export PATH="'$BREW_PREFIX'/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 设置库路径
export LIBRARY_PATH=$BREW_PREFIX/lib:$LIBRARY_PATH
export LD_LIBRARY_PATH=$BREW_PREFIX/lib:$LD_LIBRARY_PATH
```

#### Windows
1. 安装 Visual Studio 2022 或更高版本（包含 MSVC 工具链）
2. 安装 Intel oneAPI（包含 Intel Fortran 编译器）
3. 安装 vcpkg 并配置依赖：
```cmd
# 克隆 vcpkg
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat

# 安装依赖
.\vcpkg install fftw3[float,threads]:x64-windows boost:x64-windows

# 集成到 Visual Studio（可选）
.\vcpkg integrate install
```

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd tx-5dr
```

### 2. 安装依赖

```bash
yarn install
```

### 3. 启动开发环境

#### 仅浏览器模式
```bash
yarn dev
```

这将启动：
- 🌐 Web 客户端：http://localhost:5173
- 🔧 服务器：http://localhost:4000

#### 带 Electron 的完整模式
```bash
EMBEDDED=true yarn dev
```

这将启动所有服务并打开 Electron 应用。

### 4. 构建生产版本

```bash
yarn build
```

### 5. 预览生产版本

```bash
yarn preview
```

## 📁 项目结构

```
TX-5DR/
├─ packages/
│  ├─ shared-config/      # ESLint, TypeScript, Prettier 配置
│  ├─ contracts/          # Zod schema 和 TypeScript 类型
│  ├─ core/               # 运行时无关的工具函数
│  ├─ server/             # Fastify 服务器 + 原生插件占位符
│  ├─ web/                # Vite + React 客户端
│  ├─ electron-preload/   # contextBridge，sandbox=true
│  └─ electron-main/      # Electron 主进程
├─ package.json           # 根配置和工作区
├─ turbo.json            # Turborepo 配置
└─ README.md             # 项目文档
```

## 🔗 依赖关系图

```
shared-config ← contracts ← core ← {web, electron-preload, server}
                                 ↑
                            electron-main
```

依赖关系是无环的，遵循从底层到顶层的模式。

## 📦 包说明

### `@tx5dr/shared-config`
- 共享的 ESLint、TypeScript 和 Prettier 配置
- 为所有其他包提供一致的代码风格和类型检查

### `@tx5dr/contracts`
- 使用 Zod 定义的 API 契约和数据模式
- 导出 TypeScript 类型供其他包使用

### `@tx5dr/core`
- 运行时无关的核心功能
- 包含 API 客户端和通用工具函数

### `@tx5dr/server`
- 基于 Fastify 的 HTTP 服务器
- 提供 RESTful API 端点
- 包含原生插件加载的占位符代码

### `@tx5dr/web`
- 基于 Vite 和 React 18 的 Web 客户端
- 现代化的用户界面
- 调用后端 API 并展示数据

### `@tx5dr/electron-preload`
- Electron 预加载脚本
- 在沙盒环境中安全地暴露原生 API

### `@tx5dr/electron-main`
- Electron 主进程
- 可选择性地嵌入服务器
- 管理应用窗口和生命周期

## 📄 许可证

本项目采用 GNU General Public License v3.0 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

- [Turborepo](https://turbo.build/) - 高性能构建系统
- [Yarn Workspaces](https://yarnpkg.com/features/workspaces) - 包管理
- [Fastify](https://www.fastify.io/) - 快速 Web 框架
- [React](https://reactjs.org/) - 用户界面库
- [Electron](https://www.electronjs.org/) - 跨平台桌面应用
- [Vite](https://vitejs.dev/) - 现代前端构建工具 