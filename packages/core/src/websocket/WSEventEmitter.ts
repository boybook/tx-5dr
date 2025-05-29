import { EventEmitter } from 'eventemitter3';
import type { 
  WSMessage, 
  WSMessageType,
  DigitalRadioEngineEvents
} from '@tx5dr/contracts';

/**
 * WebSocket事件发射器基类
 * 提供类型安全的事件发射和监听功能
 * 基于contracts中定义的DigitalRadioEngineEvents接口
 */
export class WSEventEmitter extends EventEmitter {
  /**
   * 发射WebSocket事件
   */
  emitWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    ...args: Parameters<DigitalRadioEngineEvents[K]>
  ): boolean {
    return this.emit(event, ...args);
  }

  /**
   * 监听WebSocket事件
   */
  onWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): this {
    return this.on(event, listener);
  }

  /**
   * 移除WebSocket事件监听器
   */
  offWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener?: DigitalRadioEngineEvents[K]
  ): this {
    return this.off(event, listener);
  }

  /**
   * 一次性监听WebSocket事件
   */
  onceWSEvent<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): this {
    return this.once(event, listener);
  }

  /**
   * 发射原始WebSocket消息事件（用于内部处理）
   */
  emitRawMessage(message: WSMessage): boolean {
    return this.emit('rawMessage', message);
  }

  /**
   * 监听原始WebSocket消息事件（用于内部处理）
   */
  onRawMessage(listener: (message: WSMessage) => void): this {
    return this.on('rawMessage', listener);
  }
} 