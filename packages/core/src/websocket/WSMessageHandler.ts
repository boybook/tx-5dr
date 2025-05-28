import { WSEventEmitter } from './WSEventEmitter.js';
import type { WSEventMap } from './WSEventEmitter.js';

/**
 * WebSocket消息处理器
 * 负责消息的序列化、反序列化、验证和路由
 */
export class WSMessageHandler extends WSEventEmitter {
  /**
   * 已知的WebSocket事件类型集合
   * 从WSEventMap中提取，用于运行时类型检查
   */
  private static readonly KNOWN_EVENT_TYPES = new Set<keyof WSEventMap>([
    'modeChanged', 'clockStarted', 'clockStopped', 'slotStart', 'subWindow',
    'slotPackUpdated', 'decodeError', 'systemStatus', 'commandResult',
    'welcome', 'pong', 'error', 'connected', 'disconnected', 'connectionError'
  ]);

  /**
   * 处理接收到的原始消息
   * @param rawMessage 原始消息字符串
   */
  handleRawMessage(rawMessage: string): void {
    try {
      const data = JSON.parse(rawMessage);
      const message = this.validateMessage(data);
      
      if (message) {
        this.handleMessage(message);
      }
    } catch (error) {
      console.error('解析WebSocket消息失败:', error);
      this.emitWSEvent('error', {
        message: '消息格式错误',
        code: 'PARSE_ERROR',
        details: { rawMessage, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  /**
   * 验证消息格式
   * @param data 待验证的数据
   * @returns 验证后的消息对象，如果验证失败返回null
   */
  private validateMessage(data: any): any | null {
    // 简化验证，只检查基本结构
    if (data && typeof data === 'object' && typeof data.type === 'string' && typeof data.timestamp === 'string') {
      return data;
    }
    
    console.error('WebSocket消息验证失败: 缺少必要字段');
    this.emitWSEvent('error', {
      message: '消息验证失败',
      code: 'VALIDATION_ERROR',
      details: { data }
    });
    return null;
  }

  /**
   * 处理验证后的消息
   * @param message 验证后的消息对象
   */
  private handleMessage(message: any): void {
    // 发射原始消息事件（用于调试和扩展）
    this.emitWSEvent('rawMessage', message);

    const messageType = message.type;
    
    if (WSMessageHandler.KNOWN_EVENT_TYPES.has(messageType)) {
      // 动态发射事件，根据消息是否有data决定参数
      if (message.data !== undefined) {
        this.emitWSEvent(messageType as keyof WSEventMap, message.data);
      } else {
        this.emitWSEvent(messageType as keyof WSEventMap);
      }
    } else {
      console.warn('未知的WebSocket消息类型:', messageType);
      this.emitWSEvent('error', {
        message: '未知的消息类型',
        code: 'UNKNOWN_MESSAGE_TYPE',
        details: { message }
      });
    }
  }

  /**
   * 创建消息对象
   * @param type 消息类型
   * @param data 消息数据
   * @param id 可选的消息ID
   * @returns 格式化的消息对象
   */
  createMessage(
    type: string,
    data?: any,
    id?: string
  ): any {
    const message: any = {
      type,
      timestamp: new Date().toISOString(),
      ...(data !== undefined && { data }),
      ...(id && { id })
    };

    return message;
  }

  /**
   * 序列化消息为JSON字符串
   * @param message 消息对象
   * @returns JSON字符串
   */
  serializeMessage(message: any): string {
    try {
      // 发射原始发送事件（用于调试和扩展）
      this.emitWSEvent('rawSend', message);
      return JSON.stringify(message);
    } catch (error) {
      console.error('序列化WebSocket消息失败:', error);
      throw new Error(`消息序列化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 创建并序列化消息
   * @param type 消息类型
   * @param data 消息数据
   * @param id 可选的消息ID
   * @returns JSON字符串
   */
  createAndSerializeMessage(
    type: string,
    data?: any,
    id?: string
  ): string {
    const message = this.createMessage(type, data, id);
    return this.serializeMessage(message);
  }
} 