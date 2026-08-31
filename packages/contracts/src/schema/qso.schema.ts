import { z } from 'zod';
import { ModeDescriptorSchema } from './mode.schema.js';

/**
 * Candidate-ranking policy used when choosing which station to answer first.
 *
 * - `balanced`: combine multiple heuristics without strongly favoring one.
 * - `dxcc_first`: prioritize entities that advance DXCC goals.
 * - `new_callsign_first`: prioritize callsigns not yet worked before.
 */
export const TargetSelectionPriorityModeSchema = z.enum([
  'balanced',
  'dxcc_first',
  'new_callsign_first',
]);

/**
 * Current work status of a resolved DXCC entity in local logbook context.
 *
 * - `current`: active/current DXCC entity.
 * - `deleted`: historically valid but deleted DXCC entity.
 * - `none`: no DXCC entity could be associated.
 * - `unknown`: resolution has not completed or confidence is insufficient.
 */
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

export const SubdivisionConfidenceSchema = z.enum([
  'high',
  'low',
]);

/** Maximum UTF-8 JSON size of contest-owned data persisted with one QSO. */
export const CONTEST_QSO_ENVELOPE_MAX_BYTES = 8 * 1024;

const ContestQsoExchangeSchema = z.record(z.string(), z.string());
const ContestQsoAnnotationValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

function durableContestQsoJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>\u007f-\uffff]/g, character => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

/**
 * Versioned contest facts that must be committed atomically with their QSO.
 *
 * The shape is deliberately shallow and bounded. Contest plugins may choose
 * their exchange and annotation keys, but cannot persist arbitrary object
 * graphs or binary payloads in the logbook record.
 */
export const ContestQsoEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  contestId: z.string().min(1),
  editionId: z.string().min(1),
  rulesetVersion: z.string().min(1),
  sent: ContestQsoExchangeSchema,
  received: ContestQsoExchangeSchema,
  annotations: z.record(z.string(), ContestQsoAnnotationValueSchema).optional(),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(durableContestQsoJson(value)).byteLength > CONTEST_QSO_ENVELOPE_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Contest QSO envelope must not exceed ${CONTEST_QSO_ENVELOPE_MAX_BYTES} UTF-8 JSON bytes`,
    });
  }
});

/**
 * Serialize a validated contest envelope as ASCII-only JSON for durable ADIF
 * private fields. Escaping non-ASCII and angle brackets keeps legacy string
 * ADIF readers byte-safe without changing the decoded data.
 */
export function serializeContestQsoEnvelope(value: ContestQsoEnvelope): string {
  return durableContestQsoJson(ContestQsoEnvelopeSchema.parse(value));
}

/** Parse and validate an envelope read from a durable private field. */
export function parseContestQsoEnvelope(value: string): ContestQsoEnvelope | undefined {
  try {
    const parsed = ContestQsoEnvelopeSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

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
  maxConcurrentStreams: z.number().int().min(1).max(5).optional(),
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

// QSL 确认状态枚举（参考 ADIF 3.1.4 规范）
export const QslSentStatusSchema = z.enum(['Y', 'N', 'R', 'Q', 'I']).optional(); // Y=yes, N=no, R=requested, Q=queued, I=invalid
export const QslReceivedStatusSchema = z.enum(['Y', 'N', 'R', 'I', 'V']).optional(); // Y=yes, V=validated
export const QslSimpleStatusSchema = z.enum(['Y', 'N']).optional();

/**
 * Canonical persisted QSO record used by TX-5DR logbooks and plugin hooks.
 *
 * The schema intentionally spans multiple layers of information:
 * - core contact details such as callsign, grid, frequency and timestamps;
 * - message-level exchange details such as reports and raw message history;
 * - DXCC enrichment and review metadata;
 * - LoTW / QRZ confirmation state;
 * - station-location metadata used when exporting ADIF-like records.
 *
 * `frequency` is the RF frequency in hertz; `startTime`/`endTime` and QSL dates
 * are Unix epoch milliseconds. `mode` is the ADIF main mode and `submode` is the
 * optional ADIF submode. `messageHistory` contains the raw digital-mode exchange.
 * Sync providers update the service-specific LoTW/QRZ fields using ADIF status
 * codes (`Y`, `N`, `R`, `Q`, `I`, and received-only `V`) rather than a generic
 * `qslStatus` field.
 */
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
  messageHistory: z.array(z.string()), // 内部消息历史（FT8 等数字模式）
  comment: z.string().optional(), // 标准 ADIF COMMENT 字段
  contestId: z.string().optional(), // ADIF CONTEST_ID
  contestEntry: ContestQsoEnvelopeSchema.optional(), // TX-5DR atomic contest facts
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

  // 附注（对应 ADIF NOTES 字段）
  notes: z.string().optional(),
}).superRefine((value, context) => {
  if (value.contestId && value.contestEntry && value.contestId !== value.contestEntry.contestId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contestEntry', 'contestId'],
      message: 'contestEntry.contestId must match contestId',
    });
  }
});

/** Host persistence behavior for an automatically completed QSO. */
export const QSOPersistencePolicySchema = z.enum(['merge-nearby', 'preserve-distinct']);

// 策略执行结果
export const StrategiesResultSchema = z.object({
  stop: z.boolean().optional(),
});

export type OperatorConfig = z.infer<typeof OperatorConfigSchema>;

/**
 * Candidate-ranking policy used when choosing which station to answer first.
 */
export type TargetSelectionPriorityMode = z.infer<typeof TargetSelectionPriorityModeSchema>;

/**
 * Current work status of a resolved DXCC entity in local logbook context.
 */
export type DxccStatus = z.infer<typeof DxccStatusSchema>;
export type DxccSource = z.infer<typeof DxccSourceSchema>;
export type DxccConfidence = z.infer<typeof DxccConfidenceSchema>;
export type QSOContext = z.infer<typeof QSOContextSchema>;
export type ContestQsoEnvelope = z.infer<typeof ContestQsoEnvelopeSchema>;

/**
 * Canonical persisted QSO record used by TX-5DR logbooks and plugin hooks.
 *
 * Plugin authors will most commonly encounter this in completion hooks and
 * logbook queries.
 */
export type QSORecord = z.infer<typeof QSORecordSchema>;
export type QSOPersistencePolicy = z.infer<typeof QSOPersistencePolicySchema>;
export type StrategiesResult = z.infer<typeof StrategiesResultSchema>; 
