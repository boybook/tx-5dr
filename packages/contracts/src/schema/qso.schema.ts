import { z } from 'zod';
import { ModeDescriptorSchema } from './mode.schema.js';

// 操作配置
export const OperatorConfigSchema = z.object({
  id: z.string(),
  mode: ModeDescriptorSchema,
  myCallsign: z.string(),
  myGrid: z.string(),
  transmitCycles: z.array(z.number()),
  autoReplyToCQ: z.boolean(),
  maxQSOTimeoutCycles: z.number(),
  maxCallAttempts: z.number(),
  frequency: z.number(),
  autoResumeCQAfterFail: z.boolean().default(false),
  autoResumeCQAfterSuccess: z.boolean().default(false),
  replyToWorkedStations: z.boolean().default(false),
  prioritizeNewCalls: z.boolean().default(true)
});

// QSO状态机上下文
export const QSOContextSchema = z.object({
  config: OperatorConfigSchema,
  targetCallsign: z.string().optional(),
  targetGrid: z.string().optional(),
  reportSent: z.number().optional(),
  reportReceived: z.number().optional(),
  actualFrequency: z.number().optional(), // 实际通联频率 (基础频率 + 偏移频率)
});

// QSO命令
export const QSOCommandSchema = z.object({
  command: z.string(),
  args: z.any(),
});

// QSO联系记录
export const QSORecordSchema = z.object({
  id: z.string(),
  callsign: z.string(),        // 对方呼号
  grid: z.string().optional(), // 对方网格定位
  frequency: z.number(),       // 频率
  mode: z.string(),            // 模式（FT8）
  startTime: z.number(),       // 开始时间
  endTime: z.number().optional(), // 结束时间
  reportSent: z.string().optional(),     // 发送的信号报告
  reportReceived: z.string().optional(), // 接收的信号报告
  messages: z.array(z.string()), // 消息历史
});

// 策略执行结果
export const StrategiesResultSchema = z.object({
  stop: z.boolean().optional(),
});

export type OperatorConfig = z.infer<typeof OperatorConfigSchema>;
export type QSOContext = z.infer<typeof QSOContextSchema>;
export type QSOCommand = z.infer<typeof QSOCommandSchema>;
export type QSORecord = z.infer<typeof QSORecordSchema>;
export type StrategiesResult = z.infer<typeof StrategiesResultSchema>; 