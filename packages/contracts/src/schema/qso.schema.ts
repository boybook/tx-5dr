import { z } from 'zod';
import { ModeDescriptorSchema } from './mode.schema.js';

export const TargetSelectionPriorityModeSchema = z.enum([
  'balanced',
  'dxcc_first',
  'new_callsign_first',
]);

export const DxccStatusSchema = z.enum([
  'current',
  'deleted',
  'none',
  'unknown',
]);

export const DxccSourceSchema = z.enum([
  'resolver',
  'adif',
  'lotw',
  'manual_override',
]);

export const DxccConfidenceSchema = z.enum([
  'exception',
  'prefix',
  'heuristic',
  'manual',
  'unknown',
]);

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
  prioritizeNewCalls: z.boolean().default(true),
  targetSelectionPriorityMode: TargetSelectionPriorityModeSchema.default('dxcc_first'),
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

// QSL 确认状态枚举（参考 ADIF 3.1.4 规范）
export const QslSentStatusSchema = z.enum(['Y', 'N', 'R', 'Q', 'I']).optional(); // Y=yes, N=no, R=requested, Q=queued, I=invalid
export const QslReceivedStatusSchema = z.enum(['Y', 'N', 'R', 'I', 'V']).optional(); // Y=yes, V=validated
export const QslSimpleStatusSchema = z.enum(['Y', 'N']).optional();

// QSO联系记录
export const QSORecordSchema = z.object({
  id: z.string(),
  callsign: z.string(),        // 对方呼号
  grid: z.string().optional(), // 对方网格定位
  frequency: z.number(),       // 频率
  mode: z.string(),            // 模式（FT8）
  submode: z.string().optional(), // ADIF 子模式（如 FT4）
  startTime: z.number(),       // 开始时间
  endTime: z.number().optional(), // 结束时间
  reportSent: z.string().optional(),     // 发送的信号报告
  reportReceived: z.string().optional(), // 接收的信号报告
  messages: z.array(z.string()), // 消息历史
  myCallsign: z.string().optional(), // 我的呼号（操作员呼号）
  myGrid: z.string().optional(), // 我的网格定位（操作员网格）
  qth: z.string().optional(), // 对方 QTH（地点，语音通联常用）
  dxccId: z.number().int().positive().optional(),
  dxccEntity: z.string().optional(),
  dxccStatus: DxccStatusSchema.optional(),
  countryCode: z.string().optional(),
  cqZone: z.number().int().positive().optional(),
  ituZone: z.number().int().positive().optional(),
  dxccSource: DxccSourceSchema.optional(),
  dxccConfidence: DxccConfidenceSchema.optional(),
  dxccResolvedAt: z.number().optional(),
  dxccResolverVersion: z.string().optional(),
  dxccNeedsReview: z.boolean().optional(),
  stationLocationId: z.string().optional(),
  myDxccId: z.number().int().positive().optional(),
  myCqZone: z.number().int().positive().optional(),
  myItuZone: z.number().int().positive().optional(),
  myState: z.string().optional(),
  myCounty: z.string().optional(),
  myIota: z.string().optional(),

  // LoTW QSL 确认状态
  lotwQslSent: QslSentStatusSchema,
  lotwQslReceived: QslReceivedStatusSchema,
  lotwQslSentDate: z.number().optional(),     // 发送日期 (timestamp)
  lotwQslReceivedDate: z.number().optional(), // 确认日期 (timestamp)

  // QRZ QSL 确认状态
  qrzQslSent: QslSimpleStatusSchema,
  qrzQslReceived: QslSimpleStatusSchema,
  qrzQslSentDate: z.number().optional(),
  qrzQslReceivedDate: z.number().optional(),

  // 备注（对应 ADIF NOTES 字段）
  remarks: z.string().optional(),
});

// 策略执行结果
export const StrategiesResultSchema = z.object({
  stop: z.boolean().optional(),
});

export type OperatorConfig = z.infer<typeof OperatorConfigSchema>;
export type TargetSelectionPriorityMode = z.infer<typeof TargetSelectionPriorityModeSchema>;
export type DxccStatus = z.infer<typeof DxccStatusSchema>;
export type DxccSource = z.infer<typeof DxccSourceSchema>;
export type DxccConfidence = z.infer<typeof DxccConfidenceSchema>;
export type QSOContext = z.infer<typeof QSOContextSchema>;
export type QSOCommand = z.infer<typeof QSOCommandSchema>;
export type QSORecord = z.infer<typeof QSORecordSchema>;
export type StrategiesResult = z.infer<typeof StrategiesResultSchema>; 
