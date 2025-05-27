# 🚀 TX-5DR

## 📋 前置要求

- **Node.js** 20+ 
- **Yarn** 4+ (Berry)
- **Git**

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

## 🛠️ 开发工作流

### 添加新包

1. 在 `packages/` 目录下创建新文件夹
2. 添加 `package.json` 并设置工作区依赖
3. 创建 `tsconfig.json` 继承共享配置
4. 在根目录的 `turbo.json` 中配置构建管道（如需要）

### 运行测试

```bash
yarn test
```

### 代码检查

```bash
yarn lint
```

### 类型检查

```bash
# 在各个包中运行
cd packages/core
yarn build
```

## ⚡ Turborepo 优化

### 启用远程缓存

```bash
npx turbo login
npx turbo link
```

### 查看构建图

```bash
npx turbo run build --graph
```

### 并行执行

Turborepo 会自动并行执行可以并行的任务，并根据依赖关系正确排序。

## 🔧 配置说明

### TypeScript
- 目标：ES2021
- 模块：ESNext
- 严格模式启用
- 支持装饰器和实验性功能

### ESLint
- 基于 TypeScript ESLint 推荐配置
- 自定义规则确保代码质量
- 支持 React JSX

### Prettier
- 统一的代码格式化
- 单引号、分号、尾随逗号等配置

## 🚀 部署

### Web 应用
构建后的 Web 应用位于 `packages/web/dist/`，可以部署到任何静态文件服务器。

### 服务器
构建后的服务器位于 `packages/server/dist/`，可以作为 Node.js 应用部署。

### Electron 应用
使用 `electron-builder` 或类似工具打包桌面应用。

## 🤝 贡献

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开 Pull Request

## 📄 许可证

本项目采用 GNU General Public License v3.0 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

**重要说明**：由于本项目依赖了使用 GPL v3 许可证的 `wsjtx_lib` 库，根据 GPL v3 的 copyleft 条款，整个项目必须以 GPL v3 许可证发布。

## 🙏 致谢

- [Turborepo](https://turbo.build/) - 高性能构建系统
- [Yarn Workspaces](https://yarnpkg.com/features/workspaces) - 包管理
- [Fastify](https://www.fastify.io/) - 快速 Web 框架
- [React](https://reactjs.org/) - 用户界面库
- [Electron](https://www.electronjs.org/) - 跨平台桌面应用
- [Vite](https://vitejs.dev/) - 现代前端构建工具 