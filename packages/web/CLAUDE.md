# CLAUDE.md - Web

TX-5DR React 前端：现代化数字电台界面，实时频谱显示、FT8 监控、电台控制。

技术栈：React 18 + TypeScript + HeroUI + Tailwind + Vite + Context/Reducer + WebGL/Canvas

## 核心架构

### 状态管理
- **RadioProvider**: 三层 Reducer (connection/radio/slotPacks) + 事件驱动更新 + 状态持久化
- **专用 Hooks**: useConnection | useRadioState | useSlotPacks

### 通信层
- **RadioService**: WSClient 事件映射 + 方法封装 + 错误处理 + 状态同步
- **事件流**: Components → RadioProvider → RadioService → WSClient → Server

### 核心组件
- **FramesTable**: FT8 消息表格，时隙分组 + 日志本分析 + 实时更新 + 筛选排序
- **WebGLWaterfall**: GPU 瀑布图，实时频谱 + 交互控制 + 性能优化
- **RadioOperator**: 操作员面板，发送控制 + 状态显示 + 传输策略
- **SplitLayout**: 可调布局，拖拽调整 + 持久化 + 响应式
- **SpectrumDisplay**: 频谱显示，Canvas 绘制 + 频率标记 + 交互选择

### 设置配置
- **SettingsModal**: 统一面板 - 音频/电台设备 + 操作员管理 + 显示/自动化设置
- **持久化**: operatorPreferences + displayNotificationSettings + useTheme

### 页面路由
- **主界面**: 左侧(FT8表格+频谱) + 右侧(操作员+设置) + 状态栏
- **日志本**: QSO 查询 + 统计分析 + ADIF 导出

## 开发规范

### 组件
TypeScript 严格模式 + interface Props + ErrorBoundary + React.memo优化

### 状态
最小状态 + 不可变更新 + 类型安全

### 样式
Tailwind 优先 + HeroUI 组件 + 响应式 + 主题切换

### WebGL
资源管理 + 错误恢复 + 性能监控 + Canvas 降级

## 开发构建

### 命令
```bash
yarn dev                    # 浏览器模式
EMBEDDED=true yarn dev      # Electron模式
yarn preview                # 预览
yarn build                  # 构建
yarn build:standalone       # Electron构建
```

### 开发服务器
http://localhost:5173 + Vite代理4000 + 热更新

## 性能优化

### 渲染
虚拟滚动 + 分页加载 + 防抖输入

### 内存
组件卸载清理 + WebGL 资源释放 + 缓存策略

## 常见问题

### WebGL
上下文丢失恢复 + 性能调优 + 兼容性降级

### 状态同步
重连同步 + 事件驱动一致性 + 内存清理

## 依赖
依赖: @tx5dr/core + @tx5dr/contracts + react + heroui + vite