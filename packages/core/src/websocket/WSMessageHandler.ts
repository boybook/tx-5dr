import { WSEventEmitter } from './WSEventEmitter.js';
import { WSMessageType } from '@tx5dr/contracts';

/**
 * 消息类型到事件名称的映射表
 * 客户端和服务器都可复用
 */
export const WS_MESSAGE_EVENT_MAP: Record<string, string> = {
  [WSMessageType.MODE_CHANGED]: 'modeChanged',
  [WSMessageType.SLOT_START]: 'slotStart',
  [WSMessageType.SUB_WINDOW]: 'subWindow',
  [WSMessageType.SLOT_PACK_UPDATED]: 'slotPackUpdated',
  [WSMessageType.SPECTRUM_DATA]: 'spectrumData',
  [WSMessageType.DECODE_ERROR]: 'decodeError',
  [WSMessageType.SYSTEM_STATUS]: 'systemStatus',

  // 操作员相关事件
  [WSMessageType.OPERATORS_LIST]: 'operatorsList',
  [WSMessageType.OPERATOR_STATUS_UPDATE]: 'operatorStatusUpdate',

  // 电台相关事件
  [WSMessageType.RADIO_STATUS_CHANGED]: 'radioStatusChanged',
  [WSMessageType.RADIO_RECONNECTING]: 'radioReconnecting',
  [WSMessageType.RADIO_RECONNECT_FAILED]: 'radioReconnectFailed',
  [WSMessageType.RADIO_RECONNECT_STOPPED]: 'radioReconnectStopped',
  [WSMessageType.RADIO_ERROR]: 'radioError',
  [WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION]: 'radioDisconnectedDuringTransmission',

  // QSO 日志相关事件
  [WSMessageType.QSO_RECORD_ADDED]: 'qsoRecordAdded',
  [WSMessageType.LOGBOOK_UPDATED]: 'logbookUpdated',

  // 频率相关事件
  [WSMessageType.FREQUENCY_CHANGED]: 'frequencyChanged',

  // 其他事件
  [WSMessageType.TRANSMISSION_LOG]: 'transmissionLog',
  [WSMessageType.VOLUME_GAIN_CHANGED]: 'volumeGainChanged',
  [WSMessageType.SERVER_HANDSHAKE_COMPLETE]: 'handshakeComplete'
};

/**
 * WebSocket消息处理器
 * 负责消息的序列化、反序列化、验证和路由
 */
export class WSMessageHandler extends WSEventEmitter {
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
      this.emitWSEvent('error', new Error(`消息格式错误: ${error instanceof Error ? error.message : String(error)}`));
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
    this.emitWSEvent('error', new Error('消息验证失败'));
    return null;
  }

  /**
   * 处理验证后的消息
   * @param message 验证后的消息对象
   */
  private handleMessage(message: any): void {
    // 发射原始消息事件（用于调试和扩展）
    this.emitRawMessage(message);

    const messageType = message.type;
    
    // 检查是否是已知的消息类型
    if (Object.values(WSMessageType).includes(messageType)) {
      // 根据消息类型分发事件
      this.dispatchMessageEvent(messageType, message);
    } else {
      console.warn('未知的WebSocket消息类型:', messageType);
      this.emitWSEvent('error', new Error(`未知的消息类型: ${messageType}`));
    }
  }

  /**
   * 分发消息事件
   * @param messageType 消息类型
   * @param message 消息对象
   */
  private dispatchMessageEvent(messageType: string, message: any): void {
    const eventName = WS_MESSAGE_EVENT_MAP[messageType];
    if (eventName) {
      // 动态发射事件
      this.emitWSEvent(eventName as any, message.data);
    } else if (messageType === WSMessageType.ERROR) {
      // 特殊处理错误消息
      this.emitWSEvent('error', new Error(message.data?.message || 'Unknown error'));
    }
    // 对于其他消息类型（如ping/pong等），不需要特殊处理
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