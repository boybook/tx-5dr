// 事件系统
export { WSEventEmitter } from './WSEventEmitter.js';
export type { WSEventMap } from './WSEventEmitter.js';

// 消息处理
export { WSMessageHandler } from './WSMessageHandler.js';

// 客户端
export { WSClient } from './WSClient.js';
export type { WSClientConfig } from './WSClient.js';

// 服务端
export { WSServer, WSConnection } from './WSServer.js';

// 重新导出contracts包中的类型定义
export type {
  SystemStatus,
  SlotInfo,
  SubWindowInfo,
  DecodeErrorInfo,
  CommandResult
} from '@tx5dr/contracts'; 