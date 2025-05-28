import { EventEmitter } from 'eventemitter3';
import type { 
  WSMessage, 
  WSMessageType,
  ModeDescriptor,
  SlotPack,
  SystemStatus,
  SlotInfo,
  SubWindowInfo,
  DecodeErrorInfo,
  CommandResult
} from '@tx5dr/contracts';

/**
 * WebSocket事件映射接口
 * 定义了所有可能的WebSocket事件及其数据类型
 */
export interface WSEventMap {
  // 服务端到客户端事件
  'modeChanged': [mode: ModeDescriptor];
  'clockStarted': [];
  'clockStopped': [];
  'slotStart': [slotInfo: SlotInfo];
  'subWindow': [windowInfo: SubWindowInfo];
  'slotPackUpdated': [slotPack: SlotPack];
  'decodeError': [errorInfo: DecodeErrorInfo];
  'systemStatus': [status: SystemStatus];
  'commandResult': [result: CommandResult];
  'welcome': [data: { message: string; serverVersion?: string }];
  'pong': [];
  'error': [error: { message: string; code?: string; details?: any }];
  
  // 连接状态事件
  'connected': [];
  'disconnected': [];
  'connectionError': [error: Error];
  
  // 原始消息事件（用于调试和扩展）
  'rawMessage': [message: WSMessage];
  'rawSend': [message: WSMessage];
}

/**
 * WebSocket事件发射器基类
 * 提供类型安全的事件发射和监听功能
 */
export class WSEventEmitter extends EventEmitter {
  /**
   * 发射WebSocket事件
   */
  emitWSEvent<K extends keyof WSEventMap>(
    event: K,
    ...args: WSEventMap[K]
  ): boolean {
    return this.emit(event, ...args);
  }

  /**
   * 监听WebSocket事件
   */
  onWSEvent<K extends keyof WSEventMap>(
    event: K,
    listener: (...args: WSEventMap[K]) => void
  ): this {
    return this.on(event, listener);
  }

  /**
   * 移除WebSocket事件监听器
   */
  offWSEvent<K extends keyof WSEventMap>(
    event: K,
    listener?: (...args: WSEventMap[K]) => void
  ): this {
    return this.off(event, listener);
  }

  /**
   * 一次性监听WebSocket事件
   */
  onceWSEvent<K extends keyof WSEventMap>(
    event: K,
    listener: (...args: WSEventMap[K]) => void
  ): this {
    return this.once(event, listener);
  }
} 