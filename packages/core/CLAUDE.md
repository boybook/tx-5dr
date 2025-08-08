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
```typescript
import { WSClient, WSMessageHandler } from '@tx5dr/core';

const client = new WSClient('ws://localhost:4000/ws');
const handler = new WSMessageHandler();

handler.on('radio_status_updated', (data) => {
  console.log('Radio status:', data);
});

client.sendMessage({
  type: 'set_frequency',
  payload: { frequency: 14074000 }
});
```

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