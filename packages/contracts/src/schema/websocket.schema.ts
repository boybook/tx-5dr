import { z } from 'zod';
import { FT8DecodeSchema, FT8SpectrumSchema } from './ft8.schema.js';
import { SlotPackSchema } from './slot-info.schema.js';
import { ModeDescriptorSchema } from './mode.schema.js';

// WebSocket消息类型枚举
export enum WSMessageType {
  // 服务端到客户端 - 事件通知
  MODE_CHANGED = 'modeChanged',
  CLOCK_STARTED = 'clockStarted',
  CLOCK_STOPPED = 'clockStopped',
  SLOT_START = 'slotStart',
  SUB_WINDOW = 'subWindow',
  SLOT_PACK_UPDATED = 'slotPackUpdated',
  DECODE_ERROR = 'decodeError',
  SYSTEM_STATUS = 'systemStatus',
  
  // 服务端到客户端 - 响应
  COMMAND_RESULT = 'commandResult',
  WELCOME = 'welcome',
  PONG = 'pong',
  ERROR = 'error',
  
  // 客户端到服务端 - 命令
  START_ENGINE = 'startEngine',
  STOP_ENGINE = 'stopEngine',
  SET_MODE = 'setMode',
  GET_STATUS = 'getStatus',
  PING = 'ping',
  
  // 双向 - 数据传输
  FT8_DECODE = 'ft8Decode',
  SPECTRUM_DATA = 'spectrumData',
  
  // 客户端到服务端 - 订阅管理
  SUBSCRIBE = 'subscribe',
  UNSUBSCRIBE = 'unsubscribe',
}

// ===== 共享数据类型Schema定义 =====

// 系统状态数据结构
export const SystemStatusSchema = z.object({
  isRunning: z.boolean(),
  currentMode: ModeDescriptorSchema,
  currentTime: z.number(),
  nextSlotIn: z.number(),
  audioStarted: z.boolean(),
});

// 时隙信息数据结构
export const SlotInfoSchema = z.object({
  id: z.string(),
  startMs: z.number(),
  phaseMs: z.number(),
  driftMs: z.number(),
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

// 命令结果数据结构
export const CommandResultSchema = z.object({
  command: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.any().optional(),
});

// 订阅数据结构
export const SubscriptionSchema = z.object({
  channels: z.array(z.string()),
});

// ===== 导出共享类型 =====
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
export type SlotInfo = z.infer<typeof SlotInfoSchema>;
export type SubWindowInfo = z.infer<typeof SubWindowInfoSchema>;
export type DecodeErrorInfo = z.infer<typeof DecodeErrorInfoSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ===== WebSocket消息Schema定义 =====

// WebSocket基础消息结构
export const WSBaseMessageSchema = z.object({
  type: z.nativeEnum(WSMessageType),
  timestamp: z.string(),
  id: z.string().optional(),
});

// 服务端到客户端消息
export const WSModeChangedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.MODE_CHANGED),
  data: ModeDescriptorSchema,
});

export const WSClockStartedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.CLOCK_STARTED),
  data: z.object({}).optional(),
});

export const WSClockStoppedMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.CLOCK_STOPPED),
  data: z.object({}).optional(),
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

export const WSDecodeErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.DECODE_ERROR),
  data: DecodeErrorInfoSchema,
});

export const WSSystemStatusMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SYSTEM_STATUS),
  data: SystemStatusSchema,
});

export const WSCommandResultMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.COMMAND_RESULT),
  data: CommandResultSchema,
});

export const WSWelcomeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.WELCOME),
  data: z.object({
    message: z.string(),
    serverVersion: z.string().optional(),
  }),
});

export const WSPongMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PONG),
  data: z.object({}).optional(),
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

export const WSPingMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.PING),
  data: z.object({}).optional(),
});

export const WSSubscribeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SUBSCRIBE),
  data: SubscriptionSchema,
});

export const WSUnsubscribeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.UNSUBSCRIBE),
  data: SubscriptionSchema,
});

// 双向消息
export const WSFT8DecodeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.FT8_DECODE),
  data: FT8DecodeSchema,
});

export const WSSpectrumDataMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_DATA),
  data: FT8SpectrumSchema,
});

// 联合所有WebSocket消息类型
export const WSMessageSchema = z.discriminatedUnion('type', [
  // 服务端到客户端
  WSModeChangedMessageSchema,
  WSClockStartedMessageSchema,
  WSClockStoppedMessageSchema,
  WSSlotStartMessageSchema,
  WSSubWindowMessageSchema,
  WSSlotPackUpdatedMessageSchema,
  WSDecodeErrorMessageSchema,
  WSSystemStatusMessageSchema,
  WSCommandResultMessageSchema,
  WSWelcomeMessageSchema,
  WSPongMessageSchema,
  WSErrorMessageSchema,
  
  // 客户端到服务端
  WSStartEngineMessageSchema,
  WSStopEngineMessageSchema,
  WSSetModeMessageSchema,
  WSGetStatusMessageSchema,
  WSPingMessageSchema,
  WSSubscribeMessageSchema,
  WSUnsubscribeMessageSchema,
  
  // 双向
  WSFT8DecodeMessageSchema,
  WSSpectrumDataMessageSchema,
]);

// ===== 导出消息类型 =====
export type WSMessage = z.infer<typeof WSMessageSchema>;

// 具体消息类型
export type WSModeChangedMessage = z.infer<typeof WSModeChangedMessageSchema>;
export type WSClockStartedMessage = z.infer<typeof WSClockStartedMessageSchema>;
export type WSClockStoppedMessage = z.infer<typeof WSClockStoppedMessageSchema>;
export type WSSlotStartMessage = z.infer<typeof WSSlotStartMessageSchema>;
export type WSSubWindowMessage = z.infer<typeof WSSubWindowMessageSchema>;
export type WSSlotPackUpdatedMessage = z.infer<typeof WSSlotPackUpdatedMessageSchema>;
export type WSDecodeErrorMessage = z.infer<typeof WSDecodeErrorMessageSchema>;
export type WSSystemStatusMessage = z.infer<typeof WSSystemStatusMessageSchema>;
export type WSCommandResultMessage = z.infer<typeof WSCommandResultMessageSchema>;
export type WSWelcomeMessage = z.infer<typeof WSWelcomeMessageSchema>;
export type WSPongMessage = z.infer<typeof WSPongMessageSchema>;
export type WSErrorMessage = z.infer<typeof WSErrorMessageSchema>;

export type WSStartEngineMessage = z.infer<typeof WSStartEngineMessageSchema>;
export type WSStopEngineMessage = z.infer<typeof WSStopEngineMessageSchema>;
export type WSSetModeMessage = z.infer<typeof WSSetModeMessageSchema>;
export type WSGetStatusMessage = z.infer<typeof WSGetStatusMessageSchema>;
export type WSPingMessage = z.infer<typeof WSPingMessageSchema>;
export type WSSubscribeMessage = z.infer<typeof WSSubscribeMessageSchema>;
export type WSUnsubscribeMessage = z.infer<typeof WSUnsubscribeMessageSchema>;

export type WSFT8DecodeMessage = z.infer<typeof WSFT8DecodeMessageSchema>;
export type WSSpectrumDataMessage = z.infer<typeof WSSpectrumDataMessageSchema>;

// ===== 前端应用事件接口 =====

/**
 * 数字无线电引擎事件接口
 * 定义了前端应用层面的事件类型，基于底层WebSocket事件
 */
export interface DigitalRadioEngineEvents {
  // 模式和状态事件
  modeChanged: (mode: z.infer<typeof ModeDescriptorSchema>) => void;
  clockStarted: () => void;
  clockStopped: () => void;
  
  // 时隙和窗口事件
  slotStart: (slotInfo: SlotInfo) => void;
  subWindow: (windowInfo: SubWindowInfo) => void;
  
  // 数据更新事件
  slotPackUpdated: (slotPack: z.infer<typeof SlotPackSchema>) => void;
  
  // 错误和状态事件
  decodeError: (errorInfo: DecodeErrorInfo) => void;
  systemStatus: (status: SystemStatus) => void;
  commandResult: (result: CommandResult) => void;
  
  // 连接事件
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
} 