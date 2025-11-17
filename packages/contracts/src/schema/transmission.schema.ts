import { z } from 'zod';
import { FrameMessageSchema, SlotInfoSchema } from './slot-info.schema.js';
// 导入已存在的类型，避免重复定义
export { StrategiesResultSchema } from './qso.schema.js';
export type { StrategiesResult } from './qso.schema.js';
export { QSOCommandSchema } from './qso.schema.js';
export type { QSOCommand } from './qso.schema.js';
export { CycleInfoSchema } from './cycle.schema.js';
export type { CycleInfo } from './cycle.schema.js';

/**
 * 传输策略相关类型定义
 * 用于 RadioOperator 和 ITransmissionStrategy
 *
 * 注意：StrategiesResult, QSOCommand, CycleInfo 已在其他 schema 中定义，这里重新导出
 */

// ========== 策略状态类型 ==========

/**
 * 策略状态信息
 */
export const StrategyStateSchema = z.object({
  name: z.string(), // 策略名称（如 StandardQSOStrategy）
  state: z.string(), // 当前状态（如 TX1, TX2, IDLE 等）
  availableSlots: z.array(z.string()), // 可用的时隙列表
  metadata: z.record(z.any()).optional(), // 状态的额外信息
});

// ========== 呼叫请求类型 ==========

/**
 * 呼叫请求参数
 */
export const CallRequestSchema = z.object({
  callsign: z.string(), // 目标呼号
  lastMessage: z.object({
    message: FrameMessageSchema,
    slotInfo: SlotInfoSchema,
  }).optional(), // 从目标接收到的最后一条消息
});

// ========== 传输请求类型 ==========

/**
 * 传输请求（已在 websocket.schema.ts 中定义）
 * TransmitRequestSchema
 */

// ========== 时隙映射类型 ==========

/**
 * 操作员时隙配置
 */
export const OperatorSlotsSchema = z.object({
  TX1: z.string().optional(),
  TX2: z.string().optional(),
  TX3: z.string().optional(),
  TX4: z.string().optional(),
  TX5: z.string().optional(),
  TX6: z.string().optional(),
});

// ========== QSO 上下文类型 (已在 qso.schema.ts 中定义) ==========

/**
 * QSO 上下文（已在 qso.schema.ts 中定义为 QSOContextSchema）
 * 包含：myCall, myGrid, targetCall, targetGrid, reportSent, reportReceived 等
 */

// ========== 操作员事件数据类型 ==========

/**
 * 操作员时隙更新事件数据
 */
export const OperatorSlotsUpdatedEventSchema = z.object({
  operatorId: z.string(),
  slots: OperatorSlotsSchema,
});

/**
 * 操作员时隙内容变更事件数据
 */
export const OperatorSlotContentChangedEventSchema = z.object({
  operatorId: z.string(),
  slotName: z.string(),
  content: z.string(),
});

/**
 * 操作员发射周期变更事件数据
 */
export const OperatorTransmitCyclesChangedEventSchema = z.object({
  operatorId: z.string(),
  transmitCycles: z.array(z.number().min(0).max(1)),
});

// ========== 导出 TypeScript 类型 ==========

// StrategiesResult, QSOCommand, CycleInfo 已在文件顶部重新导出

export type StrategyState = z.infer<typeof StrategyStateSchema>;
export type CallRequest = z.infer<typeof CallRequestSchema>;
export type OperatorSlots = z.infer<typeof OperatorSlotsSchema>;
export type OperatorSlotsUpdatedEvent = z.infer<typeof OperatorSlotsUpdatedEventSchema>;
export type OperatorSlotContentChangedEvent = z.infer<typeof OperatorSlotContentChangedEventSchema>;
export type OperatorTransmitCyclesChangedEvent = z.infer<typeof OperatorTransmitCyclesChangedEventSchema>;
