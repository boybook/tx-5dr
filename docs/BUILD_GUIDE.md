# TX-5DR 构建指南

本文档介绍如何在本地和 CI 环境中构建 TX-5DR Electron 应用。

## 前置要求

### 必需软件

- **Node.js** 20.x+ (推荐 22.15.1)
- **Yarn** 4.9.1 (通过 Corepack 安装)
- **Python** 3.11 (用于原生模块编译)
- **Git**

### 平台特定依赖

#### macOS

```bash
# 安装 Xcode Command Line Tools
xcode-select --install

# 安装 Homebrew 依赖
brew install cmake fftw boost gcc pkg-config
```

#### Linux (Ubuntu/Debian)

```bash
# 基础构建工具
sudo apt-get update
sudo apt-get install -y \
  cmake build-essential gfortran \
  libfftw3-dev libboost-all-dev pkg-config \
  libasound2-dev libpulse-dev portaudio19-dev \
  libx11-dev libxrandr-dev libxinerama-dev \
  libxcursor-dev libxi-dev libxext-dev

# ARM64 交叉编译(可选)
sudo apt-get install -y \
  gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
  gfortran-aarch64-linux-gnu
```

## 构建流程

### 1. 克隆仓库

```bash
git clone https://github.com/boybook/tx-5dr.git
cd tx-5dr
```

### 2. 安装依赖

```bash
# 启用 Corepack 并安装 Yarn 4
corepack enable
corepack prepare yarn@4.9.1 --activate

# 安装项目依赖
yarn install
```

### 3. 构建所有包

```bash
# 构建 TypeScript 代码
yarn build
```

这会构建以下包:
- `packages/contracts` → `dist/`
- `packages/core` → `dist/`
- `packages/server` → `dist/`
- `packages/web` → `dist/`
- `packages/electron-main` → `dist/`
- `packages/electron-preload` → `dist/`

### 4. 生成生产依赖

```bash
# 为 server 包生成生产环境的 node_modules
yarn build:focus
```

这会在 `packages/server/node_modules` 中创建一个只包含生产依赖的目录。

**注意**: 此目录由 `.gitignore` 忽略,每次打包前都需要重新生成。

### 5. 打包应用

#### 当前平台快速打包

```bash
yarn build:dist
```

#### 指定平台和架构

```bash
# macOS ARM64 (Apple Silicon)
yarn build:mac-arm64

# Linux x64
yarn build:linux-x64

# Linux ARM64
yarn build:linux-arm64
```

### 输出文件

打包产物位于 `out/electron-builder/`:

**macOS**:
- `TX-5DR-1.0.0-mac-arm64.dmg`

**Linux x64**:
- `TX-5DR-1.0.0-linux-x64.deb`
- `TX-5DR-1.0.0-linux-x64.rpm`
- `TX-5DR-1.0.0-linux-x64.AppImage`

**Linux ARM64**:
- `TX-5DR-1.0.0-linux-arm64.deb`
- `TX-5DR-1.0.0-linux-arm64.rpm`
- `TX-5DR-1.0.0-linux-arm64.AppImage`

## 完整构建命令

### 一键构建(从零开始)

```bash
# 清理旧产物
yarn clean
yarn clean:focus

# 重新安装依赖
yarn install

# 构建并打包
yarn build
yarn build:focus
yarn build:dist
```

### 开发环境测试

```bash
# 浏览器模式
yarn dev

# Electron 模式
yarn dev:electron
```

## 常见命令

| 命令 | 说明 |
|------|------|
| `yarn build` | 构建所有 TypeScript 包 |
| `yarn build:focus` | 生成 server 生产依赖 |
| `yarn build:dist` | 打包当前平台应用 |
| `yarn build:mac-arm64` | 打包 macOS ARM64 应用 |
| `yarn build:linux-x64` | 打包 Linux x64 应用 |
| `yarn build:linux-arm64` | 打包 Linux ARM64 应用 |
| `yarn clean` | 清理所有构建产物 |
| `yarn clean:focus` | 清理 focus 生成的 node_modules |
| `yarn lint` | 运行代码检查 |

## 架构说明

### 依赖管理

TX-5DR 使用 **Yarn Focus** 管理生产依赖:

1. 开发时,所有包共享根目录的 `node_modules` (Yarn PnP 符号链接)
2. 打包前,运行 `yarn build:focus` 为 `server` 生成真实的 `node_modules`
3. electron-builder 将 `packages/server/node_modules` 包含到应用包中

### 包结构(打包后)

```
TX-5DR.app/Contents/Resources/
├─ app/
│  ├─ packages/
│  │  ├─ electron-main/dist/         # Electron 主进程
│  │  ├─ electron-preload/dist/      # Electron 预加载脚本
│  │  ├─ server/
│  │  │  ├─ dist/                    # 后端服务代码
│  │  │  ├─ node_modules/            # 生产依赖(Yarn Focus 生成)
│  │  │  │  ├─ naudiodon2/
│  │  │  │  ├─ wsjtx-lib/
│  │  │  │  └─ ...
│  │  │  └─ package.json
│  │  ├─ web/dist/                   # 前端静态文件
│  │  └─ web-proxy/src/              # 静态服务器+代理
│  └─ package.json
└─ bin/
   └─ darwin-arm64/node              # 便携式 Node.js
```

### 运行时架构

**生产环境** (Electron 应用):

1. `electron-main` 启动,使用便携式 Node.js 运行两个子进程:
   - `server:4000` - Fastify 后端
   - `web-proxy:5173` - 静态服务 + 反向代理
2. BrowserWindow 加载 `http://127.0.0.1:5173`
3. 前端通过 `/api` 路由与后端通信,web-proxy 负责代理

**开发环境**:

1. `yarn dev:electron` 启动 Vite dev server (5173) 和 Fastify (4000)
2. Electron 连接到本地开发服务器
3. 支持热重载

## 故障排查

### 构建失败

#### 错误: "server node_modules missing"

**原因**: 未运行 `yarn build:focus`

**解决**:
```bash
yarn build:focus
```

#### 错误: 原生模块编译失败

**原因**: 缺少平台特定依赖

**解决**:
- macOS: 确保安装了 Xcode Command Line Tools
- Linux: 安装 `build-essential cmake gfortran`

### 打包体积过大

#### 检查包含的文件

```bash
# 查看打包产物内容
cd out/electron-builder
tar -tzf TX-5DR-*.tar.xz | head -n 100
```

#### 验证 node_modules

确保 `packages/server/node_modules` 中只有生产依赖:

```bash
ls packages/server/node_modules | grep -E "vite|typescript|electron-builder"
```

应该为空。如果有开发依赖,重新运行:

```bash
yarn clean:focus
yarn build:focus
```

### 应用无法启动

#### 检查日志

**macOS**:
```bash
# 从终端启动查看日志
/Applications/TX-5DR.app/Contents/MacOS/tx-5dr
```

**Linux**:
```bash
# 从终端启动
./TX-5DR-*.AppImage --no-sandbox
```

#### 常见问题

1. **原生模块加载失败**: 确保 after-pack.js 正确清理了跨平台二进制
2. **子进程启动失败**: 检查便携式 Node.js 是否存在于 `resources/bin/`
3. **WebSocket 连接失败**: 确保 server 和 web-proxy 都正常启动

## 高级选项

### 自定义 electron-builder 参数

```bash
# 只生成 DMG,不签名
yarn workspace @tx5dr/electron-main electron-builder --mac dmg --arm64 --publish never

# 生成 Linux AppImage,跳过依赖检查
yarn workspace @tx5dr/electron-main electron-builder --linux AppImage --x64 --publish never
```

### 手动清理

```bash
# 清理所有构建产物和缓存
yarn clean
yarn clean:focus
rm -rf out/
rm -rf packages/*/dist/
find packages -name ".turbo" -type d -exec rm -rf {} +
```

### 调试打包过程

```bash
# 启用 electron-builder 调试输出
DEBUG=electron-builder yarn build:dist
```

## CI/CD 构建

参见 `.github/workflows/release.yml` 了解自动化构建流程。

关键步骤:
1. 安装依赖
2. 构建所有包
3. 运行 `yarn workspaces focus @tx5dr/server --production`
4. 下载便携式 Node.js
5. 运行 electron-builder
6. 上传产物

## 支持的平台

| 平台 | 架构 | 状态 |
|------|------|------|
| macOS | ARM64 | ✅ 完全支持 |
| macOS | x64 | ❌ 不支持 |
| Linux | x64 | ✅ 完全支持 |
| Linux | ARM64 | ✅ 完全支持 |
| Windows | x64 | ❌ 不支持 |

## 参考资源

- [Electron Builder 文档](https://www.electron.build/)
- [Yarn 4 文档](https://yarnpkg.com/)
- [docs/electron_monorepo_build_guide.md](./electron_monorepo_build_guide.md) - Monorepo 最佳实践
- [docs/LOCAL_BUILD.md](./LOCAL_BUILD.md) - 本地构建详细说明
- [docs/GITHUB_RELEASE_SETUP.md](./GITHUB_RELEASE_SETUP.md) - CI/CD 配置
