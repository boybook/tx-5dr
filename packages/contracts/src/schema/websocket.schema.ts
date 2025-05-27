import { z } from 'zod';
import { FT8DecodeSchema, FT8SpectrumSchema } from './ft8.schema.js';

// WebSocket消息类型
export enum WSMessageType {
  // 服务端到客户端
  FT8_DECODE = 'ft8_decode',           // FT8解码数据
  SPECTRUM_DATA = 'spectrum_data',     // 频谱数据
  QSO_STATE_CHANGE = 'qso_state_change', // QSO状态变化
  CYCLE_CHANGE = 'cycle_change',       // 周期变化
  TRANSMIT_START = 'transmit_start',   // 开始发射
  TRANSMIT_END = 'transmit_end',       // 结束发射
  ERROR = 'error',                     // 错误消息
  
  // 客户端到服务端
  SUBSCRIBE = 'subscribe',             // 订阅数据
  UNSUBSCRIBE = 'unsubscribe',         // 取消订阅
  TRANSMIT_MESSAGE = 'transmit_message', // 发射消息
  SET_FREQUENCY = 'set_frequency',     // 设置频率
}

// WebSocket基础消息结构
export const WSBaseMessageSchema = z.object({
  type: z.nativeEnum(WSMessageType),
  timestamp: z.number(),
  id: z.string().optional(),
});

// FT8解码WebSocket消息
export const WSFt8DecodeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.FT8_DECODE),
  data: FT8DecodeSchema,
});

// 频谱数据WebSocket消息
export const WSSpectrumMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SPECTRUM_DATA),
  data: FT8SpectrumSchema,
});

// QSO状态变化WebSocket消息
export const WSQSOStateChangeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.QSO_STATE_CHANGE),
  data: z.object({
    oldState: z.string(),
    newState: z.string(),
    callsign: z.string().optional(),
    context: z.record(z.any()).optional(),
  }),
});

// 周期变化WebSocket消息
export const WSCycleChangeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.CYCLE_CHANGE),
  data: z.object({
    cycle: z.number(),
    startTime: z.number(),
    endTime: z.number(),
    isTransmitting: z.boolean(),
  }),
});

// 发射开始WebSocket消息
export const WSTransmitStartMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.TRANSMIT_START),
  data: z.object({
    message: z.string(),
    frequency: z.number(),
    cycle: z.number(),
  }),
});

// 发射结束WebSocket消息
export const WSTransmitEndMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.TRANSMIT_END),
  data: z.object({
    success: z.boolean(),
    message: z.string().optional(),
  }),
});

// 错误WebSocket消息
export const WSErrorMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.ERROR),
  data: z.object({
    error: z.string(),
    code: z.string().optional(),
    details: z.record(z.any()).optional(),
  }),
});

// 订阅WebSocket消息
export const WSSubscribeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SUBSCRIBE),
  data: z.object({
    channels: z.array(z.string()),
  }),
});

// 取消订阅WebSocket消息
export const WSUnsubscribeMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.UNSUBSCRIBE),
  data: z.object({
    channels: z.array(z.string()),
  }),
});

// 发射消息WebSocket消息
export const WSTransmitMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.TRANSMIT_MESSAGE),
  data: z.object({
    message: z.string(),
    frequency: z.number().optional(),
    immediate: z.boolean().optional(),
  }),
});

// 设置频率WebSocket消息
export const WSSetFrequencyMessageSchema = WSBaseMessageSchema.extend({
  type: z.literal(WSMessageType.SET_FREQUENCY),
  data: z.object({
    frequency: z.number(),
  }),
});

// 联合所有WebSocket消息类型
export const WSMessageSchema = z.discriminatedUnion('type', [
  WSFt8DecodeMessageSchema,
  WSSpectrumMessageSchema,
  WSQSOStateChangeMessageSchema,
  WSCycleChangeMessageSchema,
  WSTransmitStartMessageSchema,
  WSTransmitEndMessageSchema,
  WSErrorMessageSchema,
  WSSubscribeMessageSchema,
  WSUnsubscribeMessageSchema,
  WSTransmitMessageSchema,
  WSSetFrequencyMessageSchema,
]);

export type WSMessage = z.infer<typeof WSMessageSchema>;
export type WSFt8DecodeMessage = z.infer<typeof WSFt8DecodeMessageSchema>;
export type WSSpectrumMessage = z.infer<typeof WSSpectrumMessageSchema>;
export type WSQSOStateChangeMessage = z.infer<typeof WSQSOStateChangeMessageSchema>;
export type WSCycleChangeMessage = z.infer<typeof WSCycleChangeMessageSchema>;
export type WSTransmitStartMessage = z.infer<typeof WSTransmitStartMessageSchema>;
export type WSTransmitEndMessage = z.infer<typeof WSTransmitEndMessageSchema>;
export type WSErrorMessage = z.infer<typeof WSErrorMessageSchema>;
export type WSSubscribeMessage = z.infer<typeof WSSubscribeMessageSchema>;
export type WSUnsubscribeMessage = z.infer<typeof WSUnsubscribeMessageSchema>;
export type WSTransmitMessage = z.infer<typeof WSTransmitMessageSchema>;
export type WSSetFrequencyMessage = z.infer<typeof WSSetFrequencyMessageSchema>; 