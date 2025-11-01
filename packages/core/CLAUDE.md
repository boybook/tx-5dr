# CLAUDE.md - Core

TX-5DR 核心业务逻辑和通信组件：API 客户端、WebSocket 客户端、业务模型。

## 核心组件

### 通信层 (websocket/)
- **WSClient**: WebSocket 客户端，自动重连+心跳+指数退避
- **WSMessageHandler**: Schema 验证+事件路由+类型安全分发
- **WSEventEmitter**: 类型安全事件系统，防内存泄漏

### 业务层
- **RadioOperator**: 操作员模型，状态管理+传输策略模式
- **SlotClock/SlotScheduler**: 时隙时钟，多时钟源+15秒精确调度
- **FT8MessageParser**: FT8 消息解析，提取呼号/网格/信号报告

### 工具层
- **CallsignUtils**: 呼号工具，DXCC查询+格式验证
- **CycleManager**: FT8周期管理，15秒周期计算+同步

## 使用示例

### WebSocket 客户端

#### 基础连接
```typescript
import { WSClient } from '@tx5dr/core';

const client = new WSClient({
  url: 'ws://localhost:4000/ws',
  reconnectAttempts: -1,      // 无限重连
  reconnectDelay: 1000,       // 重连延迟1秒
  heartbeatInterval: 30000    // 心跳间隔30秒
});

await client.connect();
```

#### 事件订阅（推荐方式）
```typescript
import type { RadioStatus, SlotPack } from '@tx5dr/contracts';

// 订阅事件
const handleRadioStatus = (data: RadioStatus) => {
  console.log('📻 Radio status:', data);
};

client.onWSEvent('radioStatusUpdated', handleRadioStatus);

// 清理订阅（非常重要！避免内存泄漏）
client.offWSEvent('radioStatusUpdated', handleRadioStatus);
```

#### 多监听器支持
```typescript
// 同一事件可以有多个监听器
const handlerA = (data: SlotPack) => console.log('Handler A:', data);
const handlerB = (data: SlotPack) => console.log('Handler B:', data);

client.onWSEvent('slotPackReceived', handlerA);
client.onWSEvent('slotPackReceived', handlerB);
// ✅ handlerA 和 handlerB 都会收到事件

// 取消单个监听器不影响其他监听器
client.offWSEvent('slotPackReceived', handlerA);
// ✅ handlerB 仍然会收到事件
```

#### 发送命令
```typescript
// 通用发送方法
client.send('setFrequency', { frequency: 14074000 });

// 或使用封装的便捷方法
client.startEngine();
client.stopEngine();
client.getStatus();
```

#### React Hook 集成示例
```typescript
import { useEffect } from 'react';
import type { WSClient } from '@tx5dr/core';

function useWSEvent<T = any>(
  client: WSClient | null,
  event: string,
  handler: (data: T) => void
) {
  useEffect(() => {
    if (!client) return;

    client.onWSEvent(event as any, handler as any);

    return () => {
      client.offWSEvent(event as any, handler as any);
    };
  }, [client, event, handler]);
}

// 使用
function MyComponent({ wsClient }: { wsClient: WSClient }) {
  useWSEvent(wsClient, 'slotPackReceived', (data: SlotPack) => {
    console.log('收到时隙包:', data);
  });

  return <div>...</div>;
}
```

## 事件系统设计

### 架构说明

WSClient 内置事件系统，组件直接订阅事件：
```
WSClient (内置 WSEventEmitter) → Components
```

### 核心特性

**内置事件系统**
- 基于 EventEmitter3 实现，成熟可靠
- 自动支持多监听器，同一事件可被多处独立订阅
- 监听器之间互不干扰

**类型安全**
- 基于 `DigitalRadioEngineEvents` 类型定义
- TypeScript 自动补全事件名称
- 事件数据类型强制检查

**内存安全**
- 必须配对调用 `onWSEvent` / `offWSEvent`
- 组件卸载时必须清理监听器，避免内存泄漏

### 实现细节

**WSEventEmitter** 继承自 EventEmitter3，提供类型安全的事件接口：

```typescript
import { EventEmitter } from 'eventemitter3';

export class WSEventEmitter extends EventEmitter {
  onWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): this {
    return this.on(event, listener);
  }

  offWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): this {
    return this.off(event, listener);
  }
}
```

**多监听器机制**：EventEmitter3 内部使用数组存储监听器，`emit()` 时按注册顺序触发，`off()` 时通过函数引用匹配移除。

### 传输策略
1. 实现 `ITransmissionStrategy` 接口
2. `strategies/` 目录创建策略类
3. 注册到 `RadioOperator`

## 开发规范
- 类型安全事件名称
- 及时清理监听器防内存泄漏
- 优雅降级错误处理

## 测试
`yarn test` - Vitest单元测试，重点测试 QSO 流程和消息解析

## 命令
- `yarn dev` - 开发构建
- `yarn build` - 生产构建