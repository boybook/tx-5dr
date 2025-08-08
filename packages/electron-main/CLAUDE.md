# CLAUDE.md - Electron Main

TX-5DR 桌面应用主进程：窗口管理、系统集成、进程间通信、安全控制。

## 核心功能

### main.ts
- **生命周期**: Electron app 管理 + BrowserWindow 创建
- **环境适配**: 开发服务器 vs 静态文件加载
- **系统事件**: 窗口关闭/最小化/激活处理

### 安全配置
```typescript
webPreferences: {
  nodeIntegration: false,     // 禁用渲染进程 Node.js
  contextIsolation: true,     // 启用上下文隔离
  preload: preloadPath       // 预加载脚本
}
```

### 开发集成
Vite 热重载 + 自动 DevTools + 错误处理

## 安全策略
- **渲染进程**: 禁用 Node.js + 上下文隔离 + CSP + 安全预加载
- **权限控制**: 最小权限 + IPC 安全 + 文件系统受限

## 打包构建
- **资源**: icon.ico/png + 静态资源嵌入
- **平台**: Windows/macOS/Linux + NSIS/DMG/AppImage
- **签名**: 生产环境代码签名

## 开发规范

### 主进程
async/await 异步 + 错误处理 + 资源清理

### IPC 通信
TypeScript 类型 + 错误处理 + 安全验证

### 跨平台
path 模块 + 系统特性 + 资源定位

## 常见问题
- **开发**: Vite 端口 + 本地资源 + 热重载
- **生产**: 资源路径 + 权限限制 + 性能优化

## 命令
```bash
EMBEDDED=true yarn dev    # 开发
yarn build                # 构建
yarn build:package        # 打包
yarn build:make          # 安装程序
```

## 依赖
依赖: electron + @tx5dr/electron-preload + @electron-forge
运行时: @tx5dr/web + @tx5dr/server