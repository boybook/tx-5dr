import { z } from 'zod';
import { ModeDescriptorSchema } from './mode.schema.js';

// 操作员配置 Schema (重命名以避免冲突)
export const RadioOperatorConfigSchema = z.object({
  id: z.string().min(1, '操作员ID不能为空'),
  createdByTokenId: z.string().optional(), // 创建者 Token ID（仅用于审计，不参与权限判断）
  myCallsign: z.string().min(1, '呼号不能为空').max(10, '呼号不能超过10个字符'),
  myGrid: z.string().min(4, '网格坐标至少4位').max(8, '网格坐标不能超过8位').optional(),
  frequency: z.number().min(0).max(1000000000, '频率必须在0-1GHz之间').default(1000), // 音频偏移频率（Hz），默认1000Hz，创建时自动分配不重复值
  transmitCycles: z.array(z.number().min(0).max(1)).default([0]), // 0=偶数周期，1=奇数周期
  mode: ModeDescriptorSchema.optional(),
  logBookId: z.string().optional(), // 连接的日志本ID，如果未指定则使用默认日志本
});

// 创建操作员请求（客户端不能指定 id 和 createdByTokenId，由服务端自动设置）
export const CreateRadioOperatorRequestSchema = RadioOperatorConfigSchema.omit({
  id: true,
  createdByTokenId: true,
});

// 更新操作员请求（客户端不能修改 id 和 createdByTokenId）
export const UpdateRadioOperatorRequestSchema = RadioOperatorConfigSchema.partial().omit({
  id: true,
  createdByTokenId: true,
});

// 操作员列表响应
export const RadioOperatorListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(RadioOperatorConfigSchema),
});

// 操作员详情响应
export const RadioOperatorDetailResponseSchema = z.object({
  success: z.boolean(),
  data: RadioOperatorConfigSchema,
});

// 操作员操作响应
export const RadioOperatorActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: RadioOperatorConfigSchema.optional(),
});

// 操作员状态响应（从websocket.schema.ts导入）
export const RadioOperatorStatusResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    id: z.string(),
    isActive: z.boolean(),
    isTransmitting: z.boolean(),
    currentSlot: z.string().optional(),
    context: z.object({
      myCall: z.string(),
      myGrid: z.string(),
      targetCall: z.string(),
      targetGrid: z.string().optional(),
      frequency: z.number().optional(),
      reportSent: z.number().optional(),
      reportReceived: z.number().optional(),
    }),
    strategy: z.object({
      name: z.string(),
      state: z.string(),
      availableSlots: z.array(z.string()),
    }),
    runtime: z.object({
      currentState: z.string(),
      slots: z.object({
        TX1: z.string().optional(),
        TX2: z.string().optional(),
        TX3: z.string().optional(),
        TX4: z.string().optional(),
        TX5: z.string().optional(),
        TX6: z.string().optional(),
      }).optional(),
      context: z.object({
        targetCallsign: z.string().optional(),
        targetGrid: z.string().optional(),
        reportSent: z.number().optional(),
        reportReceived: z.number().optional(),
        actualFrequency: z.number().optional(),
      }).optional(),
      availableSlots: z.array(z.string()).optional(),
    }).optional(),
    slots: z.object({
      TX1: z.string().optional(),
      TX2: z.string().optional(),
      TX3: z.string().optional(),
      TX4: z.string().optional(),
      TX5: z.string().optional(),
      TX6: z.string().optional(),
    }).optional(),
    transmitCycles: z.array(z.number()).optional(),
  }),
});

// TypeScript 类型导出
export type RadioOperatorConfig = z.infer<typeof RadioOperatorConfigSchema>;
export type CreateRadioOperatorRequest = z.infer<typeof CreateRadioOperatorRequestSchema>;
export type UpdateRadioOperatorRequest = z.infer<typeof UpdateRadioOperatorRequestSchema>;
export type RadioOperatorListResponse = z.infer<typeof RadioOperatorListResponseSchema>;
export type RadioOperatorDetailResponse = z.infer<typeof RadioOperatorDetailResponseSchema>;
export type RadioOperatorActionResponse = z.infer<typeof RadioOperatorActionResponseSchema>;
export type RadioOperatorStatusResponse = z.infer<typeof RadioOperatorStatusResponseSchema>; 
