# CLAUDE.md - Electron Preload

安全的渲染进程预加载脚本，主进程和渲染进程间的安全通信桥梁。

## 核心功能

### 安全设计
- **contextBridge**: 安全暴露必要系统 API
- **权限最小化**: 只暴露渲染进程必需功能
- **IPC 验证**: 白名单机制 + 参数验证 + 错误处理

### 当前实现
基础框架 + 扩展预留接口

### 未来扩展
- **系统集成**: 文件系统 + 系统信息 + 音频设备 + 窗口控制
- **应用功能**: 配置管理 + 日志系统 + 更新检查 + 崩溃报告

## 开发规范

### API 设计
最小暴露 + 异步优先 + 错误处理 + 类型安全

### 安全实践
输入验证 + 权限检查 + 日志记录 + 定期审查

### 暴露 API
```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  readConfig: () => ipcRenderer.invoke('read-config'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
});
```

### 类型定义
```typescript
declare global {
  interface Window {
    electronAPI: {
      getSystemInfo: () => Promise<SystemInfo>;
      // ...更多 API
    };
  }
}
```

## 常见问题
- **上下文访问** + **权限错误** + **IPC 超时**

## 构建
TypeScript 严格检查 + Electron 环境配置 + 源码映射

## 依赖
electron + TypeScript + 构建工具