import { z } from 'zod';
import { FT8DecodeSchema, FT8SpectrumSchema } from './ft8.schema.js';
import { SlotPackSchema, SlotInfoSchema } from './slot-info.schema.js';
import { ModeDescriptorSchema } from './mode.schema.js';

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
  
  // ===== 日志管理 =====
  LOG_QUERY = 'logQuery',
  LOG_QUERY_RESPONSE = 'logQueryResponse',
  LOG_ANALYZE_CALLSIGN = 'logAnalyzeCallsign',
  LOG_ANALYZE_CALLSIGN_RESPONSE = 'logAnalyzeCallsignResponse',
  LOG_STATISTICS = 'logStatistics',
  LOG_STATISTICS_RESPONSE = 'logStatisticsResponse',
  LOG_EXPORT_ADIF = 'logExportAdif',
  LOG_EXPORT_ADIF_RESPONSE = 'logExportAdifResponse',
  LOG_IMPORT_ADIF = 'logImportAdif',
  LOG_IMPORT_ADIF_RESPONSE = 'logImportAdifResponse',
  
  // ===== 发射日志 =====
  TRANSMISSION_LOG = 'transmissionLog',
  
  // ===== 音量控制 =====
  SET_VOLUME_GAIN = 'setVolumeGain',
  VOLUME_GAIN_CHANGED = 'volumeGainChanged',
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

// ===== 导出共享类型 =====
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
export type SubWindowInfo = z.infer<typeof SubWindowInfoSchema>;
export type DecodeErrorInfo = z.infer<typeof DecodeErrorInfoSchema>;

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

// 导出类型
export type WSGetOperatorsMessage = z.infer<typeof WSGetOperatorsMessageSchema>;
export type WSOperatorsListMessage = z.infer<typeof WSOperatorsListMessageSchema>;
export type WSOperatorStatusUpdateMessage = z.infer<typeof WSOperatorStatusUpdateMessageSchema>;
export type WSSetOperatorContextMessage = z.infer<typeof WSSetOperatorContextMessageSchema>;
export type WSSetOperatorSlotMessage = z.infer<typeof WSSetOperatorSlotMessageSchema>;
export type WSUserCommandMessage = z.infer<typeof WSUserCommandMessageSchema>;
export type WSStartOperatorMessage = z.infer<typeof WSStartOperatorMessageSchema>;
export type WSStopOperatorMessage = z.infer<typeof WSStopOperatorMessageSchema>;

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
 * 设置音量增益消息
 */
export const WSSetVolumeGainMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_VOLUME_GAIN),
  data: z.object({
    gain: z.number().min(0).max(2),
  }),
});

export type WSSetVolumeGainMessage = z.infer<typeof WSSetVolumeGainMessageSchema>;

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
  operatorsList: (operators: OperatorStatus[]) => void;
  operatorStatusUpdate: (operatorStatus: OperatorStatus) => void;
  
  // 错误和状态事件
  decodeError: (errorInfo: DecodeErrorInfo) => void;
  systemStatus: (status: SystemStatus) => void;
  
  // 连接事件
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  
  // 音量控制事件
  volumeGainChanged: (gain: number) => void;
} 