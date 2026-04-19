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
  // 在 web 中使用 createLogger；此处仅示意
  // logger.debug('radio status updated', data);
};

client.onWSEvent('radioStatusUpdated', handleRadioStatus);

// 清理订阅（非常重要！避免内存泄漏）
client.offWSEvent('radioStatusUpdated', handleRadioStatus);
```

#### 多监听器支持
```typescript
// 同一事件可以有多个监听器
const handlerA = (data: SlotPack) => { /* handle A */ };
const handlerB = (data: SlotPack) => { /* handle B */ };

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
    // process data — use createLogger for any logging
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

### 自动化策略
标准 QSO 自动化已迁移到 server 侧插件系统。新增或修改自动化策略时，应优先在 `packages/server/src/plugin/` 内实现插件运行时，而不是在 core 中扩展旧策略抽象。

## 开发规范
- 类型安全事件名称
- 及时清理监听器防内存泄漏
- 优雅降级错误处理

## 测试
`yarn test` - Vitest单元测试，重点测试 QSO 流程和消息解析

## 命令
- `yarn dev` - 开发构建
- `yarn build` - 生产构建
- `yarn generate:dxcc` - 生成/更新 `src/callsign/dxcc.json`

## DXCC 数据维护

- `src/callsign/dxcc.json` 是运行时 DXCC 基础数据，包含历史 deleted entity 与 resolver version 元信息。
- 更新 DXCC 数据时，优先使用手动下载的 BigCTY 目录本地生成，例如：
  `node scripts/generate-dxcc-data.mjs --cty-dir=/Users/you/Downloads/bigcty-YYYYMMDD --arrl=https://www.arrl.org/files/file/DXCC/Current_Deleted.txt`
- 生成脚本会优先使用 `cty.csv` 做 current entity 的 code 对齐，`cty.dat` 作为名称/前缀补充；历史 deleted entity 仍以仓库基底和 ARRL current/deleted 校验为准。
- 不要依赖 country-files.com 页面中的旧 zip 直链；网站文章里的下载 URL 可能失效。

## 日志规范

禁止裸 `console.log`，使用 `createLogger`（`src/utils/logger.ts`）。日志消息必须为英文，不含 emoji。

```typescript
import { createLogger } from "../utils/logger.js"; // ESM .js 后缀
const logger = createLogger("MyModule");

logger.debug("slot started", { id }); // 高频路径（每时隙/每事件）
logger.info("operator stopped");      // 生命周期
logger.warn("unexpected state", ctx);
logger.error("decode failed", err);
```

- Node.js（server 进程）：`LOG_LEVEL` 控制级别，默认 info；server 的 `ConsoleLogger` 覆盖层将通过级别过滤的输出写入日志文件
- 浏览器：默认 info 级别（debug 静默）
