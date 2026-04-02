import { z } from 'zod';
import { FT8DecodeSchema } from './ft8.schema.js';
import { SlotPackSchema, SlotInfoSchema } from './slot-info.schema.js';
import { ModeDescriptorSchema } from './mode.schema.js';
import { QSORecordSchema, TargetSelectionPriorityModeSchema } from './qso.schema.js';
import { LogBookStatisticsSchema } from './logbook.schema.js';
import { RadioInfoSchema, HamlibConfigSchema, TunerStatusSchema, TunerCapabilitiesSchema, RadioConnectionStatusSchema, ReconnectProgressSchema, CoreRadioCapabilitiesSchema, CoreCapabilityDiagnosticsSchema } from './radio.schema.js';
import { RadioProfileSchema, ProfileChangedEventSchema } from './radio-profile.schema.js';
import { UserRole } from './auth.schema.js';
import type { VoicePTTLock } from './voice.schema.js';
import { CapabilityListSchema, CapabilityStateSchema, WriteCapabilityPayloadSchema } from './radio-capability.schema.js';
import { SpectrumCapabilitiesSchema, SpectrumFrameSchema, SpectrumKindSchema, SpectrumSessionControlActionSchema, SpectrumSessionControlIdSchema, SpectrumSessionStateSchema } from './spectrum.schema.js';
import type { RealtimeSettingsResponseData } from './realtime.schema.js';

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
  SPECTRUM_CAPABILITIES = 'spectrumCapabilities',
  SUBSCRIBE_SPECTRUM = 'subscribeSpectrum',
  SPECTRUM_FRAME = 'spectrumFrame',
  SPECTRUM_SESSION_STATE_CHANGED = 'spectrumSessionStateChanged',
  INVOKE_SPECTRUM_CONTROL = 'invokeSpectrumControl',
  DECODE_ERROR = 'decodeError',
  SYSTEM_STATUS = 'systemStatus',
  CLIENT_COUNT_CHANGED = 'clientCountChanged',
  
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
  RADIO_ERROR = 'radioError',
  RADIO_MANUAL_RECONNECT = 'radioManualReconnect',
  RADIO_DISCONNECTED_DURING_TRANSMISSION = 'radioDisconnectedDuringTransmission',

  // ===== 频率管理 =====
  FREQUENCY_CHANGED = 'frequencyChanged',
  // ===== PTT状态管理 =====
  PTT_STATUS_CHANGED = 'pttStatusChanged',
  FORCE_STOP_TRANSMISSION = 'forceStopTransmission',
  REMOVE_OPERATOR_FROM_TRANSMISSION = 'removeOperatorFromTransmission',

  // ===== 电台数值表 =====
  METER_DATA = 'meterData',

  // ===== 极简文本消息 =====
  TEXT_MESSAGE = 'textMessage',

  // ===== 天线调谐器（已迁移至统一能力系统，枚举值保留以避免运行时错误，不再广播）=====
  /** @deprecated Use RADIO_CAPABILITY_CHANGED with id='tuner_switch' instead */
  TUNER_STATUS_CHANGED = 'tunerStatusChanged',

  // ===== 统一电台控制能力系统 =====
  /** 连接时下发能力快照（server → client） */
  RADIO_CAPABILITY_LIST = 'radioCapabilityList',
  /** 单个能力值变化（server → client） */
  RADIO_CAPABILITY_CHANGED = 'radioCapabilityChanged',
  /** 客户端写入能力值（client → server） */
  WRITE_RADIO_CAPABILITY = 'writeRadioCapability',

  // ===== 电台重连控制 =====
  RADIO_STOP_RECONNECT = 'radioStopReconnect',

  // ===== Profile 管理 =====
  PROFILE_CHANGED = 'profileChanged',
  PROFILE_LIST_UPDATED = 'profileListUpdated',
  REALTIME_SETTINGS_CHANGED = 'realtimeSettingsChanged',

  // ===== 认证 =====
  AUTH_REQUIRED = 'authRequired',
  AUTH_TOKEN = 'authToken',
  AUTH_PUBLIC_VIEWER = 'authPublicViewer',
  AUTH_RESULT = 'authResult',
  AUTH_EXPIRED = 'authExpired',

  // ===== 语音模式 =====
  VOICE_PTT_REQUEST = 'voicePttRequest',
  VOICE_PTT_RELEASE = 'voicePttRelease',
  VOICE_PTT_LOCK_CHANGED = 'voicePttLockChanged',
  VOICE_SET_RADIO_MODE = 'voiceSetRadioMode',
  VOICE_RADIO_MODE_CHANGED = 'voiceRadioModeChanged',

  // ===== 进程监控 =====
  PROCESS_SNAPSHOT = 'processSnapshot',
  PROCESS_SNAPSHOT_HISTORY = 'processSnapshotHistory',

  // ===== OpenWebRX SDR =====
  OPENWEBRX_LISTEN_STATUS = 'openwebrxListenStatus',
  OPENWEBRX_PROFILE_SELECT_REQUEST = 'openwebrxProfileSelectRequest',
  OPENWEBRX_PROFILE_SELECT_RESPONSE = 'openwebrxProfileSelectResponse',
  OPENWEBRX_PROFILE_VERIFY_RESULT = 'openwebrxProfileVerifyResult',
  OPENWEBRX_CLIENT_COUNT = 'openwebrxClientCount',
  OPENWEBRX_COOLDOWN_NOTICE = 'openwebrxCooldownNotice',
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
  radioConnectionHealth: z.object({
    connectionHealthy: z.boolean(),
  }).optional(),
  /** 引擎模式：digital（FT8/FT4）或 voice（语音通联） */
  engineMode: z.enum(['digital', 'voice']).default('digital'),
  /** 当前电台调制模式（语音模式下使用，如 USB/LSB/FM/AM） */
  currentRadioMode: z.string().optional(),
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
  source: z.enum(['program', 'radio']).optional(),
});

export const SpectrumControlInvocationSchema = z.object({
  id: SpectrumSessionControlIdSchema,
  action: SpectrumSessionControlActionSchema,
});
export type SpectrumControlInvocation = z.infer<typeof SpectrumControlInvocationSchema>;

// PTT状态数据结构
export const PTTStatusSchema = z.object({
  isTransmitting: z.boolean(),
  operatorIds: z.array(z.string()),
});

/**
 * S-meter (signal strength) level reading
 * For CI-V 0x15/0x02 command
 *
 * Calibration (IC-705):
 * - raw=0 → S0
 * - raw=120 → S9
 * - raw=241 → S9+60dB
 */
export const LevelMeterReadingSchema = z.object({
  /** Raw 0-255 BCD value */
  raw: z.number(),
  /** Percentage (0-100%) */
  percent: z.number(),
  /** S-unit value (0-9+), supports decimal (e.g., 4.5 = S4.5) */
  sUnits: z.number(),
  /** dB above S9 (only when >S9, e.g., 20 means S9+20dB) */
  dbAboveS9: z.number().optional(),
  /** Estimated absolute power in dBm (based on HF standard S9 ≈ -73dBm) */
  dBm: z.number(),
  /** Human-readable formatted string (e.g., "S4", "S9+20dB") */
  formatted: z.string(),
});

export type LevelMeterReading = z.infer<typeof LevelMeterReadingSchema>;

// 电台数值表能力检测
export const MeterCapabilitiesSchema = z.object({
  strength: z.boolean(),  // 接收信号强度 (STRENGTH)
  swr: z.boolean(),       // 驻波比 (SWR)
  alc: z.boolean(),       // 自动电平控制 (ALC)
  power: z.boolean(),     // 射频功率 (RFPOWER_METER / RFPOWER_METER_WATTS)
  powerWatts: z.boolean(),  // 是否支持绝对瓦数读取 (RFPOWER_METER_WATTS)
});
export type MeterCapabilities = z.infer<typeof MeterCapabilitiesSchema>;

// 电台数值表数据结构
export const MeterDataSchema = z.object({
  swr: z.object({
    raw: z.number(),
    swr: z.number(),
    alert: z.boolean(),
  }).nullable(),
  alc: z.object({
    raw: z.number(),
    percent: z.number(),
    alert: z.boolean(),
  }).nullable(),
  level: LevelMeterReadingSchema.nullable(),
  power: z.object({
    raw: z.number(),
    percent: z.number(),
    watts: z.number().nullable(),  // 绝对瓦数（仅当电台支持 RFPOWER_METER_WATTS 时非 null）
    maxWatts: z.number().nullable(), // 当前频率+模式对应的量程瓦数
  }).nullable(),
});

// ===== 导出共享类型 =====
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
export type SubWindowInfo = z.infer<typeof SubWindowInfoSchema>;
export type DecodeErrorInfo = z.infer<typeof DecodeErrorInfoSchema>;
export type FrequencyState = z.infer<typeof FrequencyStateSchema>;
export type PTTStatus = z.infer<typeof PTTStatusSchema>;
export type MeterData = z.infer<typeof MeterDataSchema>;

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

export const WSSpectrumCapabilitiesMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_CAPABILITIES),
  data: SpectrumCapabilitiesSchema,
});

export const WSSubscribeSpectrumMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SUBSCRIBE_SPECTRUM),
  data: z.object({
    kind: SpectrumKindSchema.nullable(),
  }),
});

export const WSSpectrumFrameMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_FRAME),
  data: SpectrumFrameSchema,
});

export const WSSpectrumSessionStateChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_SESSION_STATE_CHANGED),
  data: SpectrumSessionStateSchema,
});

export const WSInvokeSpectrumControlMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.INVOKE_SPECTRUM_CONTROL),
  data: SpectrumControlInvocationSchema,
});

export const WSDecodeErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.DECODE_ERROR),
  data: DecodeErrorInfoSchema,
});

export const WSSystemStatusMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SYSTEM_STATUS),
  data: SystemStatusSchema,
});

export const WSClientCountChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.CLIENT_COUNT_CHANGED),
  data: z.object({
    count: z.number(),
    timestamp: z.number(),
  }),
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
  isTransmitting: z.boolean(), // 是否正在发射（发射开关状态）
  isInActivePTT: z.boolean().optional(), // 该操作员的音频是否正在被实际播放
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
    targetSelectionPriorityMode: TargetSelectionPriorityModeSchema.optional(),
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
      targetSelectionPriorityMode: TargetSelectionPriorityModeSchema.optional(),
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
    clientInstanceId: z.string().min(1),
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
    status: RadioConnectionStatusSchema, // 精细化连接状态（必填）
    radioInfo: RadioInfoSchema.nullable(), // 电台信息（连接时有值，断开时为null）
    radioConfig: HamlibConfigSchema.optional(), // 电台配置（保持当前配置）
    reason: z.string().optional(),
    message: z.string().optional(), // 用户友好的消息
    recommendation: z.string().optional(), // 操作建议
    reconnectProgress: ReconnectProgressSchema.optional(), // 重连进度
    connectionHealth: z.object({
      connectionHealthy: z.boolean(),
    }).optional(),
    coreCapabilities: CoreRadioCapabilitiesSchema.optional(),
    coreCapabilityDiagnostics: CoreCapabilityDiagnosticsSchema.optional(),
    meterCapabilities: MeterCapabilitiesSchema.optional(), // 电台数值表能力（连接时检测）
    /** @deprecated Tuner capability is now in radioCapabilityList event. Kept for backward compat. */
    tunerCapabilities: TunerCapabilitiesSchema.optional(),
  }),
});

export type WSRadioStatusChangedMessage = z.infer<typeof WSRadioStatusChangedMessageSchema>;


/**
 * 电台错误事件数据（专用错误频道）
 * 包含完整的错误信息、解决建议、Profile 关联等
 */
export const RadioErrorEventDataSchema = z.object({
  /** 技术错误消息 */
  message: z.string(),
  /** 用户友好的错误消息 */
  userMessage: z.string(),
  /** 解决建议列表 */
  suggestions: z.array(z.string()).default([]),
  /** 错误代码（RadioErrorCode） */
  code: z.string().optional(),
  /** 严重程度 */
  severity: z.enum(['info', 'warning', 'error', 'critical']).default('error'),
  /** ISO 时间戳（服务端生成） */
  timestamp: z.string(),
  /** 错误堆栈（仅非生产环境） */
  stack: z.string().optional(),
  /** 错误上下文 */
  context: z.record(z.unknown()).optional(),
  /** 连接健康状态 */
  connectionHealth: z.object({
    connectionHealthy: z.boolean(),
  }).optional(),
  /** 关联的 Profile ID */
  profileId: z.string().nullable(),
  /** 关联的 Profile 名称 */
  profileName: z.string().nullable(),
});

export type RadioErrorEventData = z.infer<typeof RadioErrorEventDataSchema>;

/**
 * 电台错误消息
 */
export const WSRadioErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_ERROR),
  data: RadioErrorEventDataSchema,
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
 * 停止电台重连消息（客户端到服务端）
 */
export const WSRadioStopReconnectMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_STOP_RECONNECT),
  data: z.object({}).optional(),
});

export type WSRadioStopReconnectMessage = z.infer<typeof WSRadioStopReconnectMessageSchema>;

/**
 * 频率变化消息（服务端到客户端）
 */
export const WSFrequencyChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.FREQUENCY_CHANGED),
  data: FrequencyStateSchema,
});

export type WSFrequencyChangedMessage = z.infer<typeof WSFrequencyChangedMessageSchema>;

export const WSSpectrumSessionStateChangedOutboundMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_SESSION_STATE_CHANGED),
  data: SpectrumSessionStateSchema,
});

export type WSSpectrumSessionStateChangedOutboundMessage = z.infer<typeof WSSpectrumSessionStateChangedOutboundMessageSchema>;

/**
 * PTT状态变化消息（服务端到客户端）
 */
export const WSPTTStatusChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PTT_STATUS_CHANGED),
  data: PTTStatusSchema,
});

export type WSPTTStatusChangedMessage = z.infer<typeof WSPTTStatusChangedMessageSchema>;

/**
 * 强制停止发射消息（客户端到服务端）
 * 立即停止PTT并清空音频播放队列
 */
export const WSForceStopTransmissionMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.FORCE_STOP_TRANSMISSION),
  data: z.object({}).optional(),
});

export type WSForceStopTransmissionMessage = z.infer<typeof WSForceStopTransmissionMessageSchema>;

/**
 * 从当前发射中移除单个操作员消息（客户端到服务端）
 * 移除该操作员的音频并重混音，如果是最后一个操作员则停止PTT
 */
export const WSRemoveOperatorFromTransmissionMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.REMOVE_OPERATOR_FROM_TRANSMISSION),
  data: z.object({
    operatorId: z.string(),
  }),
});

export type WSRemoveOperatorFromTransmissionMessage = z.infer<typeof WSRemoveOperatorFromTransmissionMessageSchema>;

/**
 * 电台数值表数据消息（服务端到客户端）
 */
export const WSMeterDataMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.METER_DATA),
  data: MeterDataSchema,
});

export type WSMeterDataMessage = z.infer<typeof WSMeterDataMessageSchema>;

/**
 * 文本消息（Toast通知）
 * 用于向客户端推送提示信息
 */
export const WSTextMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.TEXT_MESSAGE),
  data: z.object({
    title: z.string(),
    text: z.string(),
    color: z.enum(['success', 'warning', 'danger', 'default']).optional(),
    timeout: z.number().nullable().optional(), // null 表示需要手动关闭，number 表示自动关闭的毫秒数
    /** i18n key，前端有此字段时优先翻译显示 */
    key: z.string().optional(),
    /** i18n 插值参数 */
    params: z.record(z.string()).optional(),
  }),
});

export type WSTextMessage = z.infer<typeof WSTextMessageSchema>;

// ===== 统一电台控制能力消息 =====

/**
 * 能力列表快照（连接成功后推送，server → client）
 */
export const WSRadioCapabilityListMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_CAPABILITY_LIST),
  data: CapabilityListSchema,
});

export type WSRadioCapabilityListMessage = z.infer<typeof WSRadioCapabilityListMessageSchema>;

/**
 * 单个能力值变化通知（server → client）
 */
export const WSRadioCapabilityChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.RADIO_CAPABILITY_CHANGED),
  data: CapabilityStateSchema,
});

export type WSRadioCapabilityChangedMessage = z.infer<typeof WSRadioCapabilityChangedMessageSchema>;

/**
 * 客户端写入能力值命令（client → server）
 * 权限：execute:RadioControl
 */
export const WSWriteRadioCapabilityMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.WRITE_RADIO_CAPABILITY),
  data: WriteCapabilityPayloadSchema,
});

export type WSWriteRadioCapabilityMessage = z.infer<typeof WSWriteRadioCapabilityMessageSchema>;

// ===== 认证相关消息 =====

/**
 * 服务端要求认证（连接建立后发送）
 */
export const WSAuthRequiredMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.AUTH_REQUIRED),
  data: z.object({
    allowPublicViewing: z.boolean(),
  }),
});

export type WSAuthRequiredMessage = z.infer<typeof WSAuthRequiredMessageSchema>;

/**
 * 客户端发送 JWT 进行认证（登录或权限升级）
 */
export const WSAuthTokenMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.AUTH_TOKEN),
  data: z.object({
    jwt: z.string(),
  }),
});

export type WSAuthTokenMessage = z.infer<typeof WSAuthTokenMessageSchema>;

/**
 * 客户端选择公开观察者模式
 */
export const WSAuthPublicViewerMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.AUTH_PUBLIC_VIEWER),
  data: z.object({}).optional(),
});

export type WSAuthPublicViewerMessage = z.infer<typeof WSAuthPublicViewerMessageSchema>;

/**
 * 认证结果（服务端到客户端）
 */
export const WSAuthResultMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.AUTH_RESULT),
  data: z.object({
    success: z.boolean(),
    role: z.nativeEnum(UserRole).optional(),
    label: z.string().optional(),
    operatorIds: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
});

export type WSAuthResultMessage = z.infer<typeof WSAuthResultMessageSchema>;

/**
 * JWT 过期通知（服务端到客户端）
 */
export const WSAuthExpiredMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.AUTH_EXPIRED),
  data: z.object({
    reason: z.string().optional(),
  }),
});

export type WSAuthExpiredMessage = z.infer<typeof WSAuthExpiredMessageSchema>;

// 联合所有WebSocket消息类型
export const WSMessageSchema = z.discriminatedUnion('type', [
  WSPingMessageSchema,
  WSPongMessageSchema,
  // 服务端到客户端
  WSModeChangedMessageSchema,
  WSSlotStartMessageSchema,
  WSSubWindowMessageSchema,
  WSSlotPackUpdatedMessageSchema,
  WSSpectrumCapabilitiesMessageSchema,
  WSSubscribeSpectrumMessageSchema,
  WSSpectrumFrameMessageSchema,
  WSSpectrumSessionStateChangedMessageSchema,
  WSInvokeSpectrumControlMessageSchema,
  WSDecodeErrorMessageSchema,
  WSSystemStatusMessageSchema,
  WSClientCountChangedMessageSchema,
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
  WSRadioErrorMessageSchema,
  WSRadioManualReconnectMessageSchema,
  WSRadioStopReconnectMessageSchema,
  WSRadioDisconnectedDuringTransmissionMessageSchema,

  // 频率管理消息
  WSFrequencyChangedMessageSchema,

  // PTT状态管理消息
  WSPTTStatusChangedMessageSchema,
  WSForceStopTransmissionMessageSchema,
  WSRemoveOperatorFromTransmissionMessageSchema,

  // 电台数值表消息
  WSMeterDataMessageSchema,

  // 文本消息（Toast通知）
  WSTextMessageSchema,

  // 认证消息
  WSAuthRequiredMessageSchema,
  WSAuthTokenMessageSchema,
  WSAuthPublicViewerMessageSchema,
  WSAuthResultMessageSchema,
  WSAuthExpiredMessageSchema,
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
export type WSSpectrumCapabilitiesMessage = z.infer<typeof WSSpectrumCapabilitiesMessageSchema>;
export type WSSubscribeSpectrumMessage = z.infer<typeof WSSubscribeSpectrumMessageSchema>;
export type WSSpectrumFrameMessage = z.infer<typeof WSSpectrumFrameMessageSchema>;
export type WSSpectrumSessionStateChangedMessage = z.infer<typeof WSSpectrumSessionStateChangedMessageSchema>;
export type WSInvokeSpectrumControlMessage = z.infer<typeof WSInvokeSpectrumControlMessageSchema>;
export type WSDecodeErrorMessage = z.infer<typeof WSDecodeErrorMessageSchema>;
export type WSSystemStatusMessage = z.infer<typeof WSSystemStatusMessageSchema>;
export type WSClientCountChangedMessage = z.infer<typeof WSClientCountChangedMessageSchema>;
export type WSErrorMessage = z.infer<typeof WSErrorMessageSchema>;

export type WSStartEngineMessage = z.infer<typeof WSStartEngineMessageSchema>;
export type WSStopEngineMessage = z.infer<typeof WSStopEngineMessageSchema>;
export type WSSetModeMessage = z.infer<typeof WSSetModeMessageSchema>;
export type WSGetStatusMessage = z.infer<typeof WSGetStatusMessageSchema>;

export const TransmitRequestSchema = z.object({
  operatorId: z.string(),
  transmission: z.string(),
  /** 是否覆盖同一操作员在同一时隙的现有 TX 帧（自动重决策时为 true） */
  replaceExisting: z.boolean().optional(),
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
  spectrumCapabilities: (data: z.infer<typeof SpectrumCapabilitiesSchema>) => void;
  spectrumFrame: (data: z.infer<typeof SpectrumFrameSchema>) => void;
  spectrumSessionStateChanged: (data: z.infer<typeof SpectrumSessionStateSchema>) => void;

  // 发射相关事件
  requestTransmit: (request: TransmitRequest) => void;
  transmissionComplete: (info: TransmissionCompleteInfo) => void;
  transmissionLog: (data: {
    operatorId: string;
    time: string;
    message: string;
    frequency: number;
    slotStartMs: number;
    replaceExisting?: boolean;
  }) => void;
  
  // 操作员事件
  operatorsList: (data: { operators: OperatorStatus[] }) => void;
  operatorStatusUpdate: (operatorStatus: OperatorStatus) => void;
  
  // 错误和状态事件
  decodeError: (errorInfo: DecodeErrorInfo) => void;
  systemStatus: (status: SystemStatus) => void;
  clientCountChanged: (data: { count: number; timestamp: number }) => void;

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

  // 电台数值表事件
  meterData: (data: MeterData) => void;

  /** @deprecated Tuner state is now delivered via radioCapabilityChanged event (id='tuner_switch') */
  tunerStatusChanged: (status: z.infer<typeof TunerStatusSchema>) => void;

  // 统一电台控制能力事件
  radioCapabilityList: (data: z.infer<typeof CapabilityListSchema>) => void;
  radioCapabilityChanged: (data: z.infer<typeof CapabilityStateSchema>) => void;

  // 电台连接状态事件
  radioStatusChanged: (data: z.infer<typeof WSRadioStatusChangedMessageSchema>['data']) => void;
  radioError: (data: z.infer<typeof RadioErrorEventDataSchema>) => void;
  radioDisconnectedDuringTransmission: (data: z.infer<typeof WSRadioDisconnectedDuringTransmissionMessageSchema>['data']) => void;

  // Profile 管理事件
  profileChanged: (data: z.infer<typeof ProfileChangedEventSchema>) => void;
  profileListUpdated: (data: { profiles: z.infer<typeof RadioProfileSchema>[]; activeProfileId: string | null }) => void;
  realtimeSettingsChanged: (data: RealtimeSettingsResponseData) => void;

  // 认证事件
  authRequired: (data: { allowPublicViewing: boolean }) => void;
  authResult: (data: { success: boolean; role?: UserRole; label?: string; operatorIds?: string[]; error?: string }) => void;
  authExpired: (data: { reason?: string }) => void;

  // 语音模式事件
  voicePttLockChanged: (data: VoicePTTLock) => void;
  voiceRadioModeChanged: (data: { radioMode: string }) => void;

  // 进程监控事件
  processSnapshot: (data: import('./process-monitor.schema.js').ProcessSnapshot) => void;
  processSnapshotHistory: (data: import('./process-monitor.schema.js').ProcessSnapshotHistory) => void;

  // OpenWebRX SDR 事件
  openwebrxProfileSelectRequest: (data: import('./openwebrx.schema.js').OpenWebRXProfileSelectRequest) => void;
  openwebrxProfileVerifyResult: (data: import('./openwebrx.schema.js').OpenWebRXProfileVerifyResult) => void;
  openwebrxClientCount: (data: { count: number }) => void;
  openwebrxCooldownNotice: (data: { waitMs: number }) => void;
  realtimeConnectivityIssue: (data: import('./realtime.schema.js').RealtimeConnectivityIssue) => void;
}
