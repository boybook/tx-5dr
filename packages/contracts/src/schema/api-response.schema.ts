import { z } from 'zod';
import {
  HamlibConfigSchema,
  RadioInfoSchema,
  PresetFrequencySchema,
  SupportedRigSchema,
  SerialPortSchema,
  TunerCapabilitiesSchema,
  TunerStatusSchema,
} from './radio.schema.js';

/**
 * API 响应基础类型定义
 * 用于统一 API 响应格式
 */

// ========== 通用响应 Schema ==========

/**
 * 基础成功响应
 */
export const BaseSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});

/**
 * 基础错误响应
 */
export const BaseErrorResponseSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  code: z.string().optional(),
  userMessage: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  context: z.record(z.any()).optional(),
});

// ========== 电台配置相关响应 ==========

/**
 * 获取电台配置响应 (已存在于 radio.schema.ts)
 * RadioConfigResponseSchema
 */

/**
 * 更新电台配置响应
 */
export const UpdateRadioConfigResponseSchema = z.object({
  success: z.boolean(),
  config: HamlibConfigSchema,
  message: z.string().optional(),
});

/**
 * 支持的电台列表响应 (已存在于 radio.schema.ts)
 * SupportedRigsResponseSchema
 */

/**
 * 串口列表响应 (已存在于 radio.schema.ts)
 * SerialPortsResponseSchema
 */

/**
 * 电台测试响应 (已存在于 radio.schema.ts)
 * TestResponseSchema
 */

/**
 * 电台状态响应
 */
export const RadioStatusResponseSchema = z.object({
  success: z.boolean(),
  status: z.object({
    connected: z.boolean(),
    radioInfo: RadioInfoSchema.nullable(),
    radioConfig: HamlibConfigSchema.optional(),
    connectionHealth: z.object({
      connectionHealthy: z.boolean(),
    }).optional(),
  }),
});

/**
 * 连接电台响应
 */
export const ConnectRadioResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  radioInfo: RadioInfoSchema.optional(),
});

/**
 * 断开电台响应
 */
export const DisconnectRadioResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// ========== 频率管理相关响应 ==========

/**
 * 预设频率列表响应 (已存在于 radio.schema.ts)
 * FrequencyListResponseSchema
 */

/**
 * 最后使用频率响应
 */
export const LastFrequencyResponseSchema = z.object({
  success: z.boolean(),
  lastFrequency: PresetFrequencySchema.nullable(),
});

/**
 * 设置频率响应
 */
export const SetFrequencyResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  frequency: z.number(),
  mode: z.string().optional(),
  band: z.string().optional(),
  radioMode: z.string().optional(),
});

// ========== 时隙包相关响应 ==========

/**
 * 时隙包列表响应
 */
export const SlotPacksResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(z.any()), // 使用 SlotPackSchema，但这里暂时用 any 避免循环依赖
  timestamp: z.number(),
});

/**
 * 单个时隙包响应
 */
export const SlotPackResponseSchema = z.object({
  success: z.boolean(),
  data: z.any(), // 使用 SlotPackSchema
  timestamp: z.number(),
});

/**
 * 时隙包统计响应
 */
export const SlotPackStatsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    activeSlotPacks: z.number(),
    totalProcessed: z.number(),
    totalFrames: z.number(),
    averageFramesPerSlot: z.number(),
    lastActivity: z.number(),
  }),
  timestamp: z.number(),
});

// ========== 天调相关响应 (已存在于 radio.schema.ts) ==========
// TunerCapabilitiesResponseSchema
// TunerStatusResponseSchema

// ========== 导出 TypeScript 类型 ==========

export type BaseSuccessResponse = z.infer<typeof BaseSuccessResponseSchema>;
export type BaseErrorResponse = z.infer<typeof BaseErrorResponseSchema>;

export type UpdateRadioConfigResponse = z.infer<typeof UpdateRadioConfigResponseSchema>;
export type RadioStatusResponse = z.infer<typeof RadioStatusResponseSchema>;
export type ConnectRadioResponse = z.infer<typeof ConnectRadioResponseSchema>;
export type DisconnectRadioResponse = z.infer<typeof DisconnectRadioResponseSchema>;

export type LastFrequencyResponse = z.infer<typeof LastFrequencyResponseSchema>;
export type SetFrequencyResponse = z.infer<typeof SetFrequencyResponseSchema>;

export type SlotPacksResponse = z.infer<typeof SlotPacksResponseSchema>;
export type SlotPackResponse = z.infer<typeof SlotPackResponseSchema>;
export type SlotPackStatsResponse = z.infer<typeof SlotPackStatsResponseSchema>;
