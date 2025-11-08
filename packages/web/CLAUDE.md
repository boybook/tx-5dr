# CLAUDE.md - Web

TX-5DR React 前端：现代化数字电台界面，实时频谱显示、FT8 监控、电台控制。

技术栈：React 18 + TypeScript + HeroUI + Tailwind + Vite + Context/Reducer + WebGL/Canvas

## 核心架构

### 状态管理
- **RadioProvider**: 三层 Reducer (connection/radio/slotPacks) + 事件驱动更新 + 状态持久化
- **专用 Hooks**: useConnection | useRadioState | useSlotPacks

### 通信层
- **RadioService**: 轻量级 WSClient 包装器 + 命令方法封装 + 暴露 wsClientInstance
- **事件流**: Components → wsClient (via radioService.wsClientInstance) → Server
- **事件订阅**: 组件直接通过 wsClient.onWSEvent() 订阅，支持多监听器

### 核心组件
- **FramesTable**: FT8 消息表格，时隙分组 + 日志本分析 + 实时更新 + 筛选排序
- **WebGLWaterfall**: GPU 瀑布图，实时频谱 + 交互控制 + 性能优化
- **RadioOperator**: 操作员面板，发送控制 + 状态显示 + 传输策略
- **SplitLayout**: 可调布局，拖拽调整 + 持久化 + 响应式
- **SpectrumDisplay**: 频谱显示，Canvas 绘制 + 频率标记 + 交互选择

### WebSocket 事件订阅指南

#### 推荐方式: 使用 useWSEvent Hook (NEW ✨)

**强烈推荐**使用 `useWSEvent` 和 `useWSEvents` Hook 来订阅事件，自动处理清理逻辑:

```typescript
import { useWSEvent, useWSEvents } from '../hooks/useWSEvent';
import { useConnection } from '../store/radioStore';

// 单事件订阅
function MyComponent() {
  const connection = useConnection();
  const [data, setData] = useState(null);

  useWSEvent(
    connection.state.radioService,
    'spectrumData',
    (spectrum) => setData(spectrum)
  );

  return <div>{/* render */}</div>;
}

// 多事件批量订阅
function MultiEventComponent() {
  const connection = useConnection();

  useWSEvents(connection.state.radioService, {
    spectrumData: (data) => console.log('频谱:', data),
    meterData: (data) => console.log('数值表:', data),
    systemStatus: (status) => console.log('系统状态:', status)
  });

  return <div>{/* render */}</div>;
}
```

**优势**:
- ✅ 自动清理事件监听器,防止内存泄漏
- ✅ 代码更简洁,减少样板代码
- ✅ 完整的 TypeScript 类型支持
- ✅ 支持依赖数组,灵活控制重新订阅

详细用法请查看: `packages/web/src/hooks/useWSEvent.example.md`

#### 架构原则
- **RadioService** 是轻量级包装器，提供 wsClient 实例访问和命令方法
- **组件直接订阅 WSClient 事件**，通过 `radioService.wsClientInstance`
- **支持多监听器**，同一事件可被多个组件独立订阅（如 RadioProvider + 组件同时订阅）
- **内存安全**: 使用 `useWSEvent` Hook 自动清理,或手动配对调用 `onWSEvent` / `offWSEvent`

#### 传统方式 (手动管理)

**1. 在 RadioProvider 中订阅全局状态事件**
```typescript
// packages/web/src/store/radioStore.tsx
useEffect(() => {
  const wsClient = radioService.wsClientInstance;

  const handleSlotPackReceived = (data: SlotPack) => {
    slotPacksDispatch({ type: 'ADD_SLOT_PACK', payload: data });
  };

  // 订阅事件
  wsClient.onWSEvent('slotPackReceived', handleSlotPackReceived);

  // 组件卸载时清理
  return () => {
    wsClient.offWSEvent('slotPackReceived', handleSlotPackReceived);
  };
}, [radioService]);
```

**2. 在普通组件中订阅局部事件**
```typescript
// packages/web/src/components/SpectrumDisplay.tsx
import { useConnection } from '../store/radioStore';

function SpectrumDisplay() {
  const connection = useConnection();
  const [spectrumData, setSpectrumData] = useState(null);

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    const wsClient = radioService.wsClientInstance;

    const handleSpectrumData = (data: FT8Spectrum) => {
      setSpectrumData(data);
    };

    wsClient.onWSEvent('spectrumData', handleSpectrumData);

    return () => {
      wsClient.offWSEvent('spectrumData', handleSpectrumData);
    };
  }, [connection.state.radioService]);

  return <div>{/* 渲染频谱数据 */}</div>;
}
```

**3. 多监听器场景**
```typescript
// 同一事件可以被多处独立订阅

// RadioService 内部订阅
this.wsClient.onWSEvent('systemStatus', (data) => {
  this._isDecoding = data.isDecoding;
});

// RadioProvider 订阅
wsClient.onWSEvent('systemStatus', (data) => {
  radioDispatch({ type: 'UPDATE_STATUS', payload: data });
});

// RadioControl 组件订阅
wsClient.onWSEvent('systemStatus', (data) => {
  setVolumeGain(data.volumeGain);
});
```

#### 注意事项
- **必须配对清理**：在 useEffect 的 cleanup 中调用 offWSEvent()，否则会造成内存泄漏
- **函数引用一致**：用于注册和取消的必须是同一个函数（避免使用匿名函数）
- **检查服务存在性**：避免在 radioService 未连接时订阅
- **使用类型安全**：从 @tx5dr/contracts 导入事件数据类型
- **事件名称自动补全**：wsClient.onWSEvent 的第一个参数有 TypeScript 类型提示

#### 批量订阅（RadioProvider 模式）
```typescript
useEffect(() => {
  const wsClient = radioService.wsClientInstance;

  // 定义所有事件处理器
  const eventMap = {
    slotPackReceived: (data: SlotPack) => {
      slotPacksDispatch({ type: 'ADD_SLOT_PACK', payload: data });
    },
    systemStatus: (status: SystemStatus) => {
      radioDispatch({ type: 'UPDATE_STATUS', payload: status });
    },
    frequencyChanged: (data: { frequency: number }) => {
      radioDispatch({ type: 'UPDATE_FREQUENCY', payload: data.frequency });
      slotPacksDispatch({ type: 'CLEAR_SLOT_PACKS' });
    }
  };

  // 批量订阅
  Object.entries(eventMap).forEach(([event, handler]) => {
    wsClient.onWSEvent(event as any, handler as any);
  });

  // 清理函数
  return () => {
    Object.entries(eventMap).forEach(([event, handler]) => {
      wsClient.offWSEvent(event as any, handler as any);
    });
  };
}, [radioService]);
```

### 设置配置
- **SettingsModal**: 统一面板 - 音频/电台设备 + 操作员管理 + 显示/自动化设置
- **持久化**: operatorPreferences + displayNotificationSettings + useTheme

### 页面路由
- **主界面**: 左侧(FT8表格+频谱) + 右侧(操作员+设置) + 状态栏
- **日志本**: QSO 查询 + 统计分析 + ADIF 导出

## 开发规范

### 组件
TypeScript 严格模式 + interface Props + ErrorBoundary + React.memo优化 + WebSocket事件订阅必须配对清理

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