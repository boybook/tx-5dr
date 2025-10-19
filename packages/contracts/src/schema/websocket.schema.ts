import { z } from 'zod';
import { FT8DecodeSchema, FT8SpectrumSchema } from './ft8.schema.js';
import { SlotPackSchema, SlotInfoSchema } from './slot-info.schema.js';
import { ModeDescriptorSchema } from './mode.schema.js';
import { QSORecordSchema } from './qso.schema.js';
import { LogBookStatisticsSchema } from './logbook.schema.js';

// WebSocket消息类型枚举
export enum WSMessageType {
  // ===== 基础连接管理 =====
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  
  // ===== 引擎控制 =====
  START_ENGINE = 'startEngine',
  STOP_ENGINE = 'stopEngine',
  GET_STATUS = 'getStatus',
  SET_MODE = 'setMode',
  
  // ===== 引擎事件 =====
  MODE_CHANGED = 'modeChanged',
  SLOT_START = 'slotStart',
  SUB_WINDOW = 'subWindow',
  SLOT_PACK_UPDATED = 'slotPackUpdated',
  SPECTRUM_DATA = 'spectrumData',
  DECODE_ERROR = 'decodeError',
  SYSTEM_STATUS = 'systemStatus',
  
  // ===== 电台操作员管理 =====
  GET_OPERATORS = 'getOperators',
  OPERATORS_LIST = 'operatorsList',
  OPERATOR_STATUS_UPDATE = 'operatorStatusUpdate',
  SET_OPERATOR_CONTEXT = 'setOperatorContext',
  SET_OPERATOR_SLOT = 'setOperatorSlot',
  USER_COMMAND = 'userCommand',
  START_OPERATOR = 'startOperator',
  STOP_OPERATOR = 'stopOperator',
  OPERATOR_REQUEST_CALL = 'operatorRequestCall',
  
  // ===== 客户端操作员过滤 =====
  SET_CLIENT_ENABLED_OPERATORS = 'setClientEnabledOperators',
  
  // ===== 握手协议 =====
  CLIENT_HANDSHAKE = 'clientHandshake',
  SERVER_HANDSHAKE_COMPLETE = 'serverHandshakeComplete',
  
  // ===== 发射日志 =====
  TRANSMISSION_LOG = 'transmissionLog',
  
  // ===== 音量控制 =====
  SET_VOLUME_GAIN = 'setVolumeGain',
  SET_VOLUME_GAIN_DB = 'setVolumeGainDb',
  VOLUME_GAIN_CHANGED = 'volumeGainChanged',
  
  // ===== 通联日志 =====
  QSO_RECORD_ADDED = 'qsoRecordAdded',
  LOGBOOK_UPDATED = 'logbookUpdated',
  // 仅通知的日志本变更事件（专用于日志本WS）
  LOGBOOK_CHANGE_NOTICE = 'logbookChangeNotice',
  
  // ===== 电台连接管理 =====
  RADIO_STATUS_CHANGED = 'radioStatusChanged',
  RADIO_RECONNECTING = 'radioReconnecting',
  RADIO_RECONNECT_FAILED = 'radioReconnectFailed',
  RADIO_RECONNECT_STOPPED = 'radioReconnectStopped',
  RADIO_ERROR = 'radioError',
  RADIO_MANUAL_RECONNECT = 'radioManualReconnect',
  RADIO_DISCONNECTED_DURING_TRANSMISSION = 'radioDisconnectedDuringTransmission',

  // ===== 频率管理 =====
  FREQUENCY_CHANGED = 'frequencyChanged',

  // ===== PTT状态管理 =====
  PTT_STATUS_CHANGED = 'pttStatusChanged',

  // ===== 极简文本消息 =====
  TEXT_MESSAGE = 'textMessage',
}

// ===== 共享数据类型Schema定义 =====

// 系统状态数据结构
export const SystemStatusSchema = z.object({
  isRunning: z.boolean(),
  isDecoding: z.boolean(),
  currentMode: ModeDescriptorSchema,
  currentTime: z.number(),
  nextSlotIn: z.number(),
  audioStarted: z.boolean(),
  radioConnected: z.boolean().optional(),
  radioReconnectInfo: z.object({
    isReconnecting: z.boolean(),
    reconnectAttempts: z.number(),
    maxReconnectAttempts: z.number(),
    hasReachedMaxAttempts: z.boolean(),
    connectionHealthy: z.boolean(),
    nextReconnectDelay: z.number(),
  }).optional(),
});

// 子窗口信息数据结构
export const SubWindowInfoSchema = z.object({
  slotInfo: SlotInfoSchema,
  windowIdx: z.number(),
});

// 解码错误信息数据结构
export const DecodeErrorInfoSchema = z.object({
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }),
  request: z.object({
    slotId: z.string(),
    windowIdx: z.number(),
  }),
});

// 频率状态数据结构
export const FrequencyStateSchema = z.object({
  frequency: z.number(),
  mode: z.string(),
  band: z.string(),
  description: z.string(),
  radioMode: z.string().optional(),
  radioConnected: z.boolean(),
});

// PTT状态数据结构
export const PTTStatusSchema = z.object({
  isTransmitting: z.boolean(),
  operatorIds: z.array(z.string()),
});

// ===== 导出共享类型 =====
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
export type SubWindowInfo = z.infer<typeof SubWindowInfoSchema>;
export type DecodeErrorInfo = z.infer<typeof DecodeErrorInfoSchema>;
export type FrequencyState = z.infer<typeof FrequencyStateSchema>;
export type PTTStatus = z.infer<typeof PTTStatusSchema>;

// ===== WebSocket消息Schema定义 =====

// WebSocket基础消息结构
export const WSBaseMessageSchema = z.object({
  type: z.nativeEnum(WSMessageType),
  timestamp: z.string(),
  id: z.string().optional(),
});

// 通用消息

export const WSPingMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PING),
  data: z.object({}).optional(),
});

export const WSPongMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PONG),
  data: z.object({}).optional(),
});

// 服务端到客户端消息
export const WSModeChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.MODE_CHANGED),
  data: ModeDescriptorSchema,
});

export const WSSlotStartMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SLOT_START),
  data: SlotInfoSchema,
});

export const WSSubWindowMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SUB_WINDOW),
  data: SubWindowInfoSchema,
});

export const WSSlotPackUpdatedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SLOT_PACK_UPDATED),
  data: SlotPackSchema,
});

export const WSSpectrumDataMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_DATA),
  data: FT8SpectrumSchema,
});

export const WSDecodeErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.DECODE_ERROR),
  data: DecodeErrorInfoSchema,
});

export const WSSystemStatusMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SYSTEM_STATUS),
  data: SystemStatusSchema,
});

export const WSErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.ERROR),
  data: z.object({
    message: z.string(),
    code: z.string().optional(),
    details: z.any().optional(),
  }),
});

// 日志本轻量变更通知（仅包含标识信息）
export const WSLogbookChangeNoticeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.LOGBOOK_CHANGE_NOTICE),
  data: z.object({
    logBookId: z.string(),
    operatorId: z.string().optional(),
  }),
});

// 客户端到服务端消息
export const WSStartEngineMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.START_ENGINE),
  data: z.object({}).optional(),
});

export const WSStopEngineMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.STOP_ENGINE),
  data: z.object({}).optional(),
});

export const WSSetModeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_MODE),
  data: z.object({
    mode: ModeDescriptorSchema,
  }),
});

export const WSGetStatusMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.GET_STATUS),
  data: z.object({}).optional(),
});

// ===== 电台操作员相关Schema =====

/**
 * 电台操作员状态信息
 */
export const OperatorStatusSchema = z.object({
  id: z.string(),
  isActive: z.boolean(),
  isTransmitting: z.boolean(), // 是否正在发射
  currentSlot: z.string().optional(),
  context: z.object({
    myCall: z.string(),
    myGrid: z.string(),
    targetCall: z.string(),
    targetGrid: z.string().optional(),
    frequency: z.number().optional(),
    reportSent: z.number().optional(), // 改为number类型
    reportReceived: z.number().optional(), // 改为number类型
    // 自动化设置
    autoReplyToCQ: z.boolean().optional(),
    autoResumeCQAfterFail: z.boolean().optional(),
    autoResumeCQAfterSuccess: z.boolean().optional(),
    replyToWorkedStations: z.boolean().optional(),
    prioritizeNewCalls: z.boolean().optional(),
  }),
  strategy: z.object({
    name: z.string(),
    state: z.string(),
    availableSlots: z.array(z.string()),
  }),
  cycleInfo: z.object({
    currentCycle: z.number(),
    isTransmitCycle: z.boolean(),
    cycleProgress: z.number().min(0).max(1), // 0-1 表示周期进度百分比
  }).optional(),
  // TX1-TX6 时隙内容
  slots: z.object({
    TX1: z.string().optional(),
    TX2: z.string().optional(),
    TX3: z.string().optional(),
    TX4: z.string().optional(),
    TX5: z.string().optional(),
    TX6: z.string().optional(),
  }).optional(),
  // 发射周期配置
  transmitCycles: z.array(z.number()).optional(),
});

export type OperatorStatus = z.infer<typeof OperatorStatusSchema>;

/**
 * 获取操作员列表消息
 */
export const WSGetOperatorsMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.GET_OPERATORS),
});

/**
 * 操作员列表响应消息
 */
export const WSOperatorsListMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.OPERATORS_LIST),
  data: z.object({
    operators: z.array(OperatorStatusSchema),
  }),
});

/**
 * 操作员状态更新消息
 */
export const WSOperatorStatusUpdateMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.OPERATOR_STATUS_UPDATE),
  data: OperatorStatusSchema,
});

/**
 * 设置操作员上下文消息
 */
export const WSSetOperatorContextMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_OPERATOR_CONTEXT),
  data: z.object({
    operatorId: z.string(),
    context: z.object({
      myCall: z.string(),
      myGrid: z.string(),
      targetCall: z.string(),
      targetGrid: z.string().optional(),
      frequency: z.number().optional(),
      reportSent: z.number().optional(),
      reportReceived: z.number().optional(),
      // 自动化设置
      autoReplyToCQ: z.boolean().optional(),
      autoResumeCQAfterFail: z.boolean().optional(),
      autoResumeCQAfterSuccess: z.boolean().optional(),
      replyToWorkedStations: z.boolean().optional(),
      prioritizeNewCalls: z.boolean().optional(),
    }),
  }),
});

/**
 * 设置操作员时隙消息
 */
export const WSSetOperatorSlotMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_OPERATOR_SLOT),
  data: z.object({
    operatorId: z.string(),
    slot: z.string(),
  }),
});

/**
 * 用户命令消息
 */
export const WSUserCommandMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.USER_COMMAND),
  data: z.object({
    operatorId: z.string(),
    command: z.string(),
    args: z.any(),
  }),
});

/**
 * 启动操作员消息
 */
export const WSStartOperatorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.START_OPERATOR),
  data: z.object({
    operatorId: z.string(),
  }),
});

/**
 * 停止操作员消息
 */
export const WSStopOperatorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.STOP_OPERATOR),
  data: z.object({
    operatorId: z.string(),
  }),
});

/**
 * 设置客户端启用的操作员列表消息
 */
export const WSSetClientEnabledOperatorsMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_CLIENT_ENABLED_OPERATORS),
  data: z.object({
    enabledOperatorIds: z.array(z.string()),
  }),
});

/**
 * 客户端握手消息
 */
export const WSClientHandshakeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.CLIENT_HANDSHAKE),
  data: z.object({
    enabledOperatorIds: z.array(z.string()).nullable(), // null表示新客户端，数组表示已配置的偏好
    clientVersion: z.string().optional(),
    clientCapabilities: z.array(z.string()).optional(),
  }),
});

/**
 * 服务器握手完成消息
 */
export const WSServerHandshakeCompleteMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SERVER_HANDSHAKE_COMPLETE),
  data: z.object({
    serverVersion: z.string().optional(),
    supportedFeatures: z.array(z.string()).optional(),
  }),
});

// 导出类型
export type WSGetOperatorsMessage = z.infer<typeof WSGetOperatorsMessageSchema>;
export type WSOperatorsListMessage = z.infer<typeof WSOperatorsListMessageSchema>;
export type WSOperatorStatusUpdateMessage = z.infer<typeof WSOperatorStatusUpdateMessageSchema>;
export type WSSetOperatorContextMessage = z.infer<typeof WSSetOperatorContextMessageSchema>;
export type WSSetOperatorSlotMessage = z.infer<typeof WSSetOperatorSlotMessageSchema>;
export type WSUserCommandMessage = z.infer<typeof WSUserCommandMessageSchema>;
export type WSStartOperatorMessage = z.infer<typeof WSStartOperatorMessageSchema>;
export type WSStopOperatorMessage = z.infer<typeof WSStopOperatorMessageSchema>;
export type WSSetClientEnabledOperatorsMessage = z.infer<typeof WSSetClientEnabledOperatorsMessageSchema>;
export type WSClientHandshakeMessage = z.infer<typeof WSClientHandshakeMessageSchema>;
export type WSServerHandshakeCompleteMessage = z.infer<typeof WSServerHandshakeCompleteMessageSchema>;

/**
 * 发射日志消息
 */
export const WSTransmissionLogMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.TRANSMISSION_LOG),
  data: z.object({
    operatorId: z.string(),
    time: z.string(),
    message: z.string(),
    frequency: z.number(),
    slotStartMs: z.number()
  }),
});

export type WSTransmissionLogMessage = z.infer<typeof WSTransmissionLogMessageSchema>;

/**
 * 设置音量增益消息（线性单位）
 */
export const WSSetVolumeGainMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_VOLUME_GAIN),
  data: z.object({
    gain: z.number().min(0.001).max(10),
  }),
});

export type WSSetVolumeGainMessage = z.infer<typeof WSSetVolumeGainMessageSchema>;

/**
 * 设置音量增益消息（dB单位）
 */
export const WSSetVolumeGainDbMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_VOLUME_GAIN_DB),
  data: z.object({
    gainDb: z.number().min(-60).max(20),
  }),
});

export type WSSetVolumeGainDbMessage = z.infer<typeof WSSetVolumeGainDbMessageSchema>;

/**
 * QSO记录添加消息（服务端到客户端）
 */
export const WSQSORecordAddedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.QSO_RECORD_ADDED),
  data: z.object({
    operatorId: z.string(),
    logBookId: z.string(),
    qsoRecord: QSORecordSchema,
  }),
});

export type WSQSORecordAddedMessage = z.infer<typeof WSQSORecordAddedMessageSchema>;

/**
 * 日志本更新消息（服务端到客户端）
 */
export const WSLogbookUpdatedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.LOGBOOK_UPDATED),
  data: z.object({
    logBookId: z.string(),
    statistics: LogBookStatisticsSchema,
  }),
});

export type WSLogbookUpdatedMessage = z.infer<typeof WSLogbookUpdatedMessageSchema>;

/**
 * 电台状态变化消息
 */
export const WSRadioStatusChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_STATUS_CHANGED),
  data: z.object({
    connected: z.boolean(),
    reason: z.string().optional(),
    reconnectInfo: z.object({
      isReconnecting: z.boolean(),
      reconnectAttempts: z.number(),
      maxReconnectAttempts: z.number(),
      hasReachedMaxAttempts: z.boolean(),
      connectionHealthy: z.boolean(),
      nextReconnectDelay: z.number(),
    }),
  }),
});

export type WSRadioStatusChangedMessage = z.infer<typeof WSRadioStatusChangedMessageSchema>;

/**
 * 电台重连中消息
 */
export const WSRadioReconnectingMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_RECONNECTING),
  data: z.object({
    attempt: z.number(),
    reconnectInfo: z.object({
      isReconnecting: z.boolean(),
      reconnectAttempts: z.number(),
      maxReconnectAttempts: z.number(),
      hasReachedMaxAttempts: z.boolean(),
      connectionHealthy: z.boolean(),
      nextReconnectDelay: z.number(),
    }),
  }),
});

export type WSRadioReconnectingMessage = z.infer<typeof WSRadioReconnectingMessageSchema>;

/**
 * 电台重连失败消息
 */
export const WSRadioReconnectFailedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_RECONNECT_FAILED),
  data: z.object({
    error: z.string(),
    attempt: z.number(),
    reconnectInfo: z.object({
      isReconnecting: z.boolean(),
      reconnectAttempts: z.number(),
      maxReconnectAttempts: z.number(),
      hasReachedMaxAttempts: z.boolean(),
      connectionHealthy: z.boolean(),
      nextReconnectDelay: z.number(),
    }),
  }),
});

export type WSRadioReconnectFailedMessage = z.infer<typeof WSRadioReconnectFailedMessageSchema>;

/**
 * 电台重连停止消息
 */
export const WSRadioReconnectStoppedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_RECONNECT_STOPPED),
  data: z.object({
    maxAttempts: z.number(),
    reconnectInfo: z.object({
      isReconnecting: z.boolean(),
      reconnectAttempts: z.number(),
      maxReconnectAttempts: z.number(),
      hasReachedMaxAttempts: z.boolean(),
      connectionHealthy: z.boolean(),
      nextReconnectDelay: z.number(),
    }),
  }),
});

export type WSRadioReconnectStoppedMessage = z.infer<typeof WSRadioReconnectStoppedMessageSchema>;

/**
 * 电台错误消息
 */
export const WSRadioErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_ERROR),
  data: z.object({
    error: z.string(),
    reconnectInfo: z.object({
      isReconnecting: z.boolean(),
      reconnectAttempts: z.number(),
      maxReconnectAttempts: z.number(),
      hasReachedMaxAttempts: z.boolean(),
      connectionHealthy: z.boolean(),
      nextReconnectDelay: z.number(),
    }),
  }),
});

export type WSRadioErrorMessage = z.infer<typeof WSRadioErrorMessageSchema>;

/**
 * 手动重连电台消息（客户端到服务端）
 */
export const WSRadioManualReconnectMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_MANUAL_RECONNECT),
  data: z.object({}).optional(),
});

export type WSRadioManualReconnectMessage = z.infer<typeof WSRadioManualReconnectMessageSchema>;

/**
 * 电台发射中断开连接消息
 */
export const WSRadioDisconnectedDuringTransmissionMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION),
  data: z.object({
    reason: z.string(),
    message: z.string(),
    recommendation: z.string(),
  }),
});

export type WSRadioDisconnectedDuringTransmissionMessage = z.infer<typeof WSRadioDisconnectedDuringTransmissionMessageSchema>;

/**
 * 频率变化消息（服务端到客户端）
 */
export const WSFrequencyChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.FREQUENCY_CHANGED),
  data: FrequencyStateSchema,
});

export type WSFrequencyChangedMessage = z.infer<typeof WSFrequencyChangedMessageSchema>;

/**
 * PTT状态变化消息（服务端到客户端）
 */
export const WSPTTStatusChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PTT_STATUS_CHANGED),
  data: PTTStatusSchema,
});

export type WSPTTStatusChangedMessage = z.infer<typeof WSPTTStatusChangedMessageSchema>;

// 联合所有WebSocket消息类型
export const WSMessageSchema = z.discriminatedUnion('type', [
  WSPingMessageSchema,
  WSPongMessageSchema,
  // 服务端到客户端
  WSModeChangedMessageSchema,
  WSSlotStartMessageSchema,
  WSSubWindowMessageSchema,
  WSSlotPackUpdatedMessageSchema,
  WSSpectrumDataMessageSchema,
  WSDecodeErrorMessageSchema,
  WSSystemStatusMessageSchema,
  WSErrorMessageSchema,
  WSLogbookChangeNoticeMessageSchema,
  WSTransmissionLogMessageSchema,
  
  // 客户端到服务端
  WSStartEngineMessageSchema,
  WSStopEngineMessageSchema,
  WSSetModeMessageSchema,
  WSGetStatusMessageSchema,
  
  // 操作员相关消息
  WSGetOperatorsMessageSchema,
  WSOperatorsListMessageSchema,
  WSOperatorStatusUpdateMessageSchema,
  WSSetOperatorContextMessageSchema,
  WSSetOperatorSlotMessageSchema,
  WSUserCommandMessageSchema,
  WSStartOperatorMessageSchema,
  WSStopOperatorMessageSchema,
  
  // 音量控制消息
  WSSetVolumeGainMessageSchema,
  WSSetVolumeGainDbMessageSchema,
  
  // 通联日志消息
  WSQSORecordAddedMessageSchema,
  WSLogbookUpdatedMessageSchema,
  
  // 客户端启用操作员列表消息
  WSSetClientEnabledOperatorsMessageSchema,
  
  // 握手消息
  WSClientHandshakeMessageSchema,
  WSServerHandshakeCompleteMessageSchema,
  
  // 电台连接管理消息
  WSRadioStatusChangedMessageSchema,
  WSRadioReconnectingMessageSchema,
  WSRadioReconnectFailedMessageSchema,
  WSRadioReconnectStoppedMessageSchema,
  WSRadioErrorMessageSchema,
  WSRadioManualReconnectMessageSchema,
  WSRadioDisconnectedDuringTransmissionMessageSchema,

  // 频率管理消息
  WSFrequencyChangedMessageSchema,

  // PTT状态管理消息
  WSPTTStatusChangedMessageSchema,
]);

// ===== 导出消息类型 =====
export type WSMessage = z.infer<typeof WSMessageSchema>;

// 具体消息类型
export type WSPingMessage = z.infer<typeof WSPingMessageSchema>;
export type WSPongMessage = z.infer<typeof WSPongMessageSchema>;

export type WSModeChangedMessage = z.infer<typeof WSModeChangedMessageSchema>;
export type WSSlotStartMessage = z.infer<typeof WSSlotStartMessageSchema>;
export type WSSubWindowMessage = z.infer<typeof WSSubWindowMessageSchema>;
export type WSSlotPackUpdatedMessage = z.infer<typeof WSSlotPackUpdatedMessageSchema>;
export type WSSpectrumDataMessage = z.infer<typeof WSSpectrumDataMessageSchema>;
export type WSDecodeErrorMessage = z.infer<typeof WSDecodeErrorMessageSchema>;
export type WSSystemStatusMessage = z.infer<typeof WSSystemStatusMessageSchema>;
export type WSErrorMessage = z.infer<typeof WSErrorMessageSchema>;

export type WSStartEngineMessage = z.infer<typeof WSStartEngineMessageSchema>;
export type WSStopEngineMessage = z.infer<typeof WSStopEngineMessageSchema>;
export type WSSetModeMessage = z.infer<typeof WSSetModeMessageSchema>;
export type WSGetStatusMessage = z.infer<typeof WSGetStatusMessageSchema>;

export const TransmitRequestSchema = z.object({
  operatorId: z.string(),
  transmission: z.string(),
});

export type TransmitRequest = z.infer<typeof TransmitRequestSchema>;

// ===== 前端应用事件接口 =====

/**
 * 发射完成事件信息
 */
export const TransmissionCompleteInfoSchema = z.object({
  operatorId: z.string(),
  success: z.boolean(),
  duration: z.number().optional(),
  error: z.string().optional(),
  mixedWith: z.array(z.string()).optional(), // 与其他操作员混音的ID列表
});

export type TransmissionCompleteInfo = z.infer<typeof TransmissionCompleteInfoSchema>;

/**
 * 数字无线电引擎事件接口
 * 定义了前端应用层面的事件类型，基于底层WebSocket事件
 */
export interface DigitalRadioEngineEvents {
  // 模式和状态事件
  modeChanged: (mode: z.infer<typeof ModeDescriptorSchema>) => void;
  
  // 时隙和窗口事件
  slotStart: (slotInfo: z.infer<typeof SlotInfoSchema>, lastSlotPack: z.infer<typeof SlotPackSchema> | null) => void;
  subWindow: (windowInfo: SubWindowInfo) => void;
  
  // 数据更新事件
  slotPackUpdated: (slotPack: z.infer<typeof SlotPackSchema>) => void;
  spectrumData: (spectrumData: z.infer<typeof FT8SpectrumSchema>) => void;

  // 发射相关事件
  requestTransmit: (request: TransmitRequest) => void;
  transmissionComplete: (info: TransmissionCompleteInfo) => void;
  transmissionLog: (data: {
    operatorId: string;
    time: string;
    message: string;
    frequency: number;
    slotStartMs: number;
  }) => void;
  
  // 操作员事件
  operatorsList: (data: { operators: OperatorStatus[] }) => void;
  operatorStatusUpdate: (operatorStatus: OperatorStatus) => void;
  
  // 错误和状态事件
  decodeError: (errorInfo: DecodeErrorInfo) => void;
  systemStatus: (status: SystemStatus) => void;
  
  // 连接事件
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;

  // 音量控制事件
  volumeGainChanged: (data: { gain: number; gainDb: number } | number) => void;

  // 频率控制事件
  frequencyChanged: (data: FrequencyState) => void;

  // PTT状态控制事件
  pttStatusChanged: (data: PTTStatus) => void;
} 
