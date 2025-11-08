# useWSEvent Hook 使用指南

## 概述

`useWSEvent` 和 `useWSEvents` 是专门用于 TX-5DR 项目的 React Hook,用于自动管理 WebSocket 事件监听器的订阅和清理，有效防止内存泄漏。

## 核心优势

- ✅ **自动清理**: 组件卸载时自动取消订阅，防止内存泄漏
- ✅ **类型安全**: 完全基于 `DigitalRadioEngineEvents` 接口，提供类型检查和自动补全
- ✅ **简化代码**: 减少样板代码，提高代码可读性
- ✅ **灵活依赖**: 支持自定义依赖数组，控制重新订阅时机

## useWSEvent - 单事件订阅

### 基本用法

```typescript
import { useWSEvent } from '../hooks/useWSEvent';
import { useConnection } from '../store/radioStore';
import { useState } from 'react';

function SpectrumDisplay() {
  const connection = useConnection();
  const [spectrumData, setSpectrumData] = useState<FT8Spectrum | null>(null);

  // 订阅单个事件
  useWSEvent(
    connection.state.radioService,
    'spectrumData',
    (data) => {
      setSpectrumData(data);
    }
  );

  return <div>{/* 渲染频谱 */}</div>;
}
```

### 带依赖的订阅

```typescript
function MessageFilter() {
  const connection = useConnection();
  const [filterCallsign, setFilterCallsign] = useState('');
  const [messages, setMessages] = useState<SlotPack[]>([]);

  // 当 filterCallsign 变化时,会重新订阅
  useWSEvent(
    connection.state.radioService,
    'slotPackUpdated',
    (slotPack) => {
      // 过滤消息
      const filtered = slotPack.messages.filter(msg =>
        msg.callsign.includes(filterCallsign)
      );
      if (filtered.length > 0) {
        setMessages(prev => [...prev, { ...slotPack, messages: filtered }]);
      }
    },
    [filterCallsign] // 依赖数组
  );

  return (
    <div>
      <input value={filterCallsign} onChange={(e) => setFilterCallsign(e.target.value)} />
      {/* 渲染过滤后的消息 */}
    </div>
  );
}
```

### 常见事件类型示例

```typescript
// 系统状态更新
useWSEvent(
  radioService,
  'systemStatus',
  (status) => {
    console.log('系统状态:', status.isRunning, status.isDecoding);
  }
);

// 时隙开始
useWSEvent(
  radioService,
  'slotStart',
  (slotInfo, lastSlotPack) => {
    console.log('时隙开始:', slotInfo.slotId, slotInfo.utcSeconds);
  }
);

// 电台数值表
useWSEvent(
  radioService,
  'meterData',
  (data) => {
    console.log('SWR:', data.swr, 'ALC:', data.alc);
  }
);

// 文本消息/Toast通知
useWSEvent(
  radioService,
  'textMessage',
  (message) => {
    addToast({ title: message.title, text: message.text, color: message.color });
  }
);

// 操作员状态更新
useWSEvent(
  radioService,
  'operatorStatusUpdate',
  (status) => {
    console.log('操作员', status.id, '状态:', status.status);
  }
);
```

## useWSEvents - 多事件批量订阅

### 基本用法

```typescript
import { useWSEvents } from '../hooks/useWSEvent';

function MultiEventComponent() {
  const connection = useConnection();
  const [state, setState] = useState({
    spectrum: null,
    meter: null,
    pttActive: false
  });

  // 批量订阅多个事件
  useWSEvents(connection.state.radioService, {
    spectrumData: (data) => {
      setState(prev => ({ ...prev, spectrum: data }));
    },
    meterData: (data) => {
      setState(prev => ({ ...prev, meter: data }));
    },
    pttStatusChanged: (data) => {
      setState(prev => ({ ...prev, pttActive: data.isTransmitting }));
    }
  });

  return <div>{/* 使用 state */}</div>;
}
```

### 与 Reducer 结合使用

```typescript
function RadioMonitor() {
  const connection = useConnection();
  const [state, dispatch] = useReducer(radioReducer, initialState);

  useWSEvents(connection.state.radioService, {
    systemStatus: (status) => {
      dispatch({ type: 'UPDATE_STATUS', payload: status });
    },
    operatorsList: (data) => {
      dispatch({ type: 'UPDATE_OPERATORS', payload: data.operators });
    },
    slotPackUpdated: (slotPack) => {
      dispatch({ type: 'ADD_SLOT_PACK', payload: slotPack });
    },
    qsoRecordAdded: (data) => {
      dispatch({ type: 'ADD_QSO', payload: data });
    }
  });

  return <div>{/* 渲染监控数据 */}</div>;
}
```

## 对比传统方式

### 传统方式 (手动管理)

```typescript
// ❌ 容易忘记清理,导致内存泄漏
useEffect(() => {
  const radioService = connection.state.radioService;
  if (!radioService) return;

  const wsClient = radioService.wsClientInstance;

  const handleSpectrum = (data: FT8Spectrum) => {
    setSpectrumData(data);
  };

  wsClient.onWSEvent('spectrumData', handleSpectrum);

  // ⚠️ 必须手动清理
  return () => {
    wsClient.offWSEvent('spectrumData', handleSpectrum);
  };
}, [connection.state.radioService]);
```

### 使用 useWSEvent

```typescript
// ✅ 自动清理,代码更简洁
useWSEvent(
  connection.state.radioService,
  'spectrumData',
  (data) => setSpectrumData(data)
);
```

## 注意事项

### 1. radioService 为 null 时的处理

Hook 会自动检查 `radioService` 是否为 `null`,如果为 `null` 则不会订阅:

```typescript
const connection = useConnection();

// 即使 radioService 为 null 也不会报错
useWSEvent(
  connection.state.radioService, // 可能为 null
  'systemStatus',
  (status) => console.log(status)
);
```

### 2. Handler 函数稳定性

如果 handler 函数使用了外部变量,建议使用 `useCallback` 或添加到依赖数组:

```typescript
// 方式A: 使用 useCallback
const handleSpectrum = useCallback((data: FT8Spectrum) => {
  processSpectrum(data, someExternalValue);
}, [someExternalValue]);

useWSEvent(radioService, 'spectrumData', handleSpectrum);

// 方式B: 添加到依赖数组 (推荐)
useWSEvent(
  radioService,
  'spectrumData',
  (data) => processSpectrum(data, someExternalValue),
  [someExternalValue]
);
```

### 3. 避免在 Handler 中触发频繁的 setState

对于高频事件 (如 `spectrumData`, `meterData`),建议使用防抖或节流:

```typescript
import { useMemo } from 'react';
import { debounce } from 'lodash';

function Component() {
  const [data, setData] = useState(null);

  // 使用 debounce 减少更新频率
  const debouncedSet = useMemo(
    () => debounce((newData) => setData(newData), 100),
    []
  );

  useWSEvent(
    radioService,
    'spectrumData', // 高频事件 (~6.7Hz)
    debouncedSet
  );

  return <div>{/* render */}</div>;
}
```

### 4. 类型安全

Hook 提供完整的类型检查:

```typescript
// ✅ 正确 - 类型匹配
useWSEvent(
  radioService,
  'systemStatus',
  (status) => console.log(status.isRunning)
);

// ❌ 错误 - 事件名称错误 (TypeScript 会报错)
useWSEvent(
  radioService,
  'invalidEvent', // Type error!
  (data) => {}
);

// ❌ 错误 - 参数类型不匹配 (TypeScript 会报错)
useWSEvent(
  radioService,
  'systemStatus',
  (wrongParam: string) => {} // Type error!
);
```

## 高级用法

### 条件订阅

```typescript
function ConditionalSubscription() {
  const connection = useConnection();
  const [enableMonitoring, setEnableMonitoring] = useState(false);

  useWSEvent(
    enableMonitoring ? connection.state.radioService : null, // 条件性订阅
    'spectrumData',
    (data) => console.log(data)
  );

  return (
    <button onClick={() => setEnableMonitoring(!enableMonitoring)}>
      {enableMonitoring ? '停止' : '开始'} 监听
    </button>
  );
}
```

### 与其他 Hook 组合

```typescript
function CombinedExample() {
  const connection = useConnection();
  const [history, setHistory] = useState<SlotPack[]>([]);

  // 使用自定义 Hook 处理数据
  const processedData = useProcessSlotPacks(history);

  useWSEvent(
    connection.state.radioService,
    'slotPackUpdated',
    (slotPack) => {
      setHistory(prev => [...prev.slice(-99), slotPack]); // 保留最近100条
    }
  );

  return <div>{/* render processed data */}</div>;
}
```

## 完整示例

```typescript
import { useWSEvent, useWSEvents } from '../hooks/useWSEvent';
import { useConnection } from '../store/radioStore';
import { useState } from 'react';
import type { FT8Spectrum, MeterData, SystemStatus } from '@tx5dr/contracts';

function CompleteExample() {
  const connection = useConnection();

  // 状态管理
  const [spectrum, setSpectrum] = useState<FT8Spectrum | null>(null);
  const [meter, setMeter] = useState<MeterData | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);

  // 方式1: 单个事件订阅
  useWSEvent(
    connection.state.radioService,
    'spectrumData',
    setSpectrum
  );

  // 方式2: 批量订阅
  useWSEvents(connection.state.radioService, {
    meterData: setMeter,
    systemStatus: setStatus,
    textMessage: (msg) => {
      console.log('收到消息:', msg.title, msg.text);
    }
  });

  return (
    <div>
      <div>系统运行: {status?.isRunning ? '是' : '否'}</div>
      <div>解码中: {status?.isDecoding ? '是' : '否'}</div>
      <div>频谱数据: {spectrum ? '有' : '无'}</div>
      <div>数值表: {meter ? JSON.stringify(meter) : '无'}</div>
    </div>
  );
}
```

## 总结

- 使用 `useWSEvent` 订阅单个事件
- 使用 `useWSEvents` 批量订阅多个事件
- 自动处理事件清理,防止内存泄漏
- 完整的 TypeScript 类型支持
- 灵活的依赖数组控制重新订阅
