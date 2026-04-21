import { WSEventEmitter } from './WSEventEmitter.js';
import { WSMessageType } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WSMessageHandler');

/**
 * 消息类型到事件名称的映射表
 * 客户端和服务器都可复用
 */
export const WS_MESSAGE_EVENT_MAP: Record<string, string> = {
  [WSMessageType.MODE_CHANGED]: 'modeChanged',
  [WSMessageType.SLOT_START]: 'slotStart',
  [WSMessageType.SUB_WINDOW]: 'subWindow',
  [WSMessageType.SLOT_PACK_UPDATED]: 'slotPackUpdated',
  [WSMessageType.SLOT_PACKS_RESET]: 'slotPacksReset',
  [WSMessageType.SPECTRUM_CAPABILITIES]: 'spectrumCapabilities',
  [WSMessageType.SPECTRUM_FRAME]: 'spectrumFrame',
  [WSMessageType.SPECTRUM_SESSION_STATE_CHANGED]: 'spectrumSessionStateChanged',
  [WSMessageType.DECODE_ERROR]: 'decodeError',
  [WSMessageType.SYSTEM_STATUS]: 'systemStatus',
  [WSMessageType.CLIENT_COUNT_CHANGED]: 'clientCountChanged',
  [WSMessageType.CLOCK_STATUS_CHANGED]: 'clockStatusChanged',
  [WSMessageType.RIGCTLD_STATUS]: 'rigctldStatus',

  // 操作员相关事件
  [WSMessageType.OPERATORS_LIST]: 'operatorsList',
  [WSMessageType.OPERATOR_STATUS_UPDATE]: 'operatorStatusUpdate',

  // 电台相关事件
  [WSMessageType.RADIO_STATUS_CHANGED]: 'radioStatusChanged',
  [WSMessageType.RADIO_ERROR]: 'radioError',
  [WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION]: 'radioDisconnectedDuringTransmission',
  [WSMessageType.RADIO_POWER_STATE]: 'radioPowerState',

  // 音频 sidecar 事件
  [WSMessageType.AUDIO_SIDECAR_STATUS_CHANGED]: 'audioSidecarStatusChanged',

  // QSO 日志相关事件
  [WSMessageType.QSO_RECORD_ADDED]: 'qsoRecordAdded',
  [WSMessageType.QSO_RECORD_UPDATED]: 'qsoRecordUpdated',
  [WSMessageType.LOGBOOK_UPDATED]: 'logbookUpdated',
  [WSMessageType.LOGBOOK_CHANGE_NOTICE]: 'logbookChangeNotice',

  // 频率相关事件
  [WSMessageType.FREQUENCY_CHANGED]: 'frequencyChanged',

  // PTT状态相关事件
  [WSMessageType.PTT_STATUS_CHANGED]: 'pttStatusChanged',

  // 电台数值表相关事件
  [WSMessageType.METER_DATA]: 'meterData',

  // 其他事件
  [WSMessageType.TRANSMISSION_LOG]: 'transmissionLog',
  [WSMessageType.VOLUME_GAIN_CHANGED]: 'volumeGainChanged',
  [WSMessageType.SERVER_HANDSHAKE_COMPLETE]: 'handshakeComplete',
  // 极简文本消息
  [WSMessageType.TEXT_MESSAGE]: 'textMessage',

  // 统一能力系统事件
  [WSMessageType.RADIO_CAPABILITY_LIST]: 'radioCapabilityList',
  [WSMessageType.RADIO_CAPABILITY_CHANGED]: 'radioCapabilityChanged',

  // Profile 管理事件
  [WSMessageType.PROFILE_CHANGED]: 'profileChanged',
  [WSMessageType.PROFILE_LIST_UPDATED]: 'profileListUpdated',
  [WSMessageType.REALTIME_SETTINGS_CHANGED]: 'realtimeSettingsChanged',

  // 认证相关事件
  [WSMessageType.AUTH_REQUIRED]: 'authRequired',
  [WSMessageType.AUTH_RESULT]: 'authResult',
  [WSMessageType.AUTH_EXPIRED]: 'authExpired',

  // 语音模式事件
  [WSMessageType.VOICE_PTT_LOCK_CHANGED]: 'voicePttLockChanged',
  [WSMessageType.VOICE_RADIO_MODE_CHANGED]: 'voiceRadioModeChanged',

  // 进程监控事件
  [WSMessageType.PROCESS_SNAPSHOT]: 'processSnapshot',
  [WSMessageType.PROCESS_SNAPSHOT_HISTORY]: 'processSnapshotHistory',

  // OpenWebRX SDR events
  [WSMessageType.OPENWEBRX_LISTEN_STATUS]: 'openwebrxListenStatus',
  [WSMessageType.OPENWEBRX_PROFILE_SELECT_REQUEST]: 'openwebrxProfileSelectRequest',
  [WSMessageType.OPENWEBRX_PROFILE_VERIFY_RESULT]: 'openwebrxProfileVerifyResult',
  [WSMessageType.OPENWEBRX_CLIENT_COUNT]: 'openwebrxClientCount',
  [WSMessageType.OPENWEBRX_COOLDOWN_NOTICE]: 'openwebrxCooldownNotice',

  // 连接管理事件
  [WSMessageType.CONNECTION_REPLACED]: 'connectionReplaced',

  // 插件系统事件
  [WSMessageType.PLUGIN_LIST]: 'pluginList',
  [WSMessageType.PLUGIN_STATUS_CHANGED]: 'pluginStatusChanged',
  [WSMessageType.PLUGIN_DATA]: 'pluginData',
  [WSMessageType.PLUGIN_LOG]: 'pluginLog',
  [WSMessageType.PLUGIN_PAGE_PUSH]: 'pluginPagePush',
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
      logger.error('Failed to parse message:', error);
      this.emitWSEvent('error', new Error(`Message parse error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * 验证消息格式
   * @param data 待验证的数据
   * @returns 验证后的消息对象，如果验证失败返回null
   */
  private validateMessage(data: unknown): Record<string, unknown> | null {
    // 简化验证，只检查基本结构
    if (data && typeof data === 'object' && data !== null) {
      const msg = data as Record<string, unknown>;
      if (typeof msg.type === 'string' && typeof msg.timestamp === 'string') {
        return msg;
      }
    }

    logger.debug('Message validation failed: missing required fields');
    this.emitWSEvent('error', new Error('Message validation failed'));
    return null;
  }

  /**
   * 处理验证后的消息
   * @param message 验证后的消息对象
   */
  private handleMessage(message: Record<string, unknown>): void {
    const messageType = message.type;

    // 检查是否是已知的消息类型
    if (typeof messageType === 'string' && Object.values(WSMessageType).includes(messageType as WSMessageType)) {
      // 注意：这里需要使用 any 因为 message 是动态验证的运行时数据
      // 在实际使用中，每个事件的 data 字段会在运行时通过 Zod schema 验证
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.emitRawMessage(message as any);

      // 根据消息类型分发事件
      this.dispatchMessageEvent(messageType, message);
    } else {
      logger.warn('Unknown message type:', messageType);
      this.emitWSEvent('error', new Error(`Unknown message type: ${String(messageType)}`));
    }
  }

  /**
   * 分发消息事件
   * @param messageType 消息类型
   * @param message 消息对象
   */
  private dispatchMessageEvent(messageType: string, message: Record<string, unknown>): void {
    const eventName = WS_MESSAGE_EVENT_MAP[messageType];
    if (eventName) {
      // 动态发射事件
      this.emitWSEvent(eventName as keyof import('@tx5dr/contracts').DigitalRadioEngineEvents, message.data as never);
    } else if (messageType === WSMessageType.ERROR) {
      // 特殊处理错误消息
      const errorData = message.data as Record<string, unknown> | undefined;
      const errorMessage = typeof errorData?.message === 'string' ? errorData.message : 'Unknown error';
      this.emitWSEvent('error', new Error(errorMessage));
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
    data?: unknown,
    id?: string
  ): Record<string, unknown> {
    const message: Record<string, unknown> = {
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
  serializeMessage(message: Record<string, unknown>): string {
    try {
      return JSON.stringify(message);
    } catch (error) {
      logger.error('Failed to serialize message:', error);
      throw new Error(`Message serialization failed: ${error instanceof Error ? error.message : String(error)}`);
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
    data?: unknown,
    id?: string
  ): string {
    const message = this.createMessage(type, data, id);
    return this.serializeMessage(message);
  }
} 
