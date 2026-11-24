import { z } from 'zod';
import { configPatchSchema } from '../utils/configPatchSchema.js';

/**
 * PSKReporter 统计信息 Schema
 */
export const PSKReporterStatsSchema = z.object({
  /** 最后成功上报时间 (Unix毫秒) */
  lastReportTime: z.number().optional(),
  /** 今日上报数量 */
  todayReportCount: z.number().default(0),
  /** 总上报数量 */
  totalReportCount: z.number().default(0),
  /** 最后错误信息 */
  lastError: z.string().optional(),
  /** 连续失败次数 */
  consecutiveFailures: z.number().default(0),
});

/** PSK Reporter publishing identity, antenna metadata, interval and counters. */
export const PSKReporterConfigSchema = z.object({
  /** 是否启用 PSKReporter 上报 */
  enabled: z.boolean().default(false),

  /** 接收电台呼号 (可选，留空时使用第一个操作员的呼号) */
  receiverCallsign: z.string().default(''),

  /** 接收电台网格 (可选，留空时使用第一个操作员的网格) */
  receiverLocator: z.string().default(''),

  /** 解码软件名称 (自动填充) */
  decodingSoftware: z.string().default('TX-5DR'),

  /** 天线信息 (可选，会显示在 PSKReporter 地图上) */
  antennaInformation: z.string().max(64, '天线信息不能超过64字符').default(''),

  /** 上报间隔（秒），最小10秒，最大60秒，默认30秒 */
  reportIntervalSeconds: z.number().min(10).max(60).default(30),

  /** 是否使用测试服务器（仅用于开发调试） */
  useTestServer: z.boolean().default(false),

  /** 上报统计 */
  stats: PSKReporterStatsSchema.prefault({}),
});

/**
 * PSKReporter 上报记录 Schema (用于收集待上报数据)
 */
export const PSKReporterSpotSchema = z.object({
  /** 发送电台呼号 (必填) */
  senderCallsign: z.string(),

  /** 频率 (Hz，可选) */
  frequency: z.number().optional(),

  /** 模式 (FT8, FT4 等) */
  mode: z.string(),

  /** 信噪比 (可选) */
  snr: z.number().optional(),

  /** 接收时间戳 (Unix 秒) */
  flowStartSeconds: z.number(),

  /** 发送电台网格 (可选，从消息中解析) */
  senderLocator: z.string().optional(),

  /** 信息源 (1 = automatic) */
  informationSource: z.number().default(1),
});

/**
 * PSKReporter 上报状态 Schema
 */
export const PSKReporterStatusSchema = z.object({
  /** 是否已启用 */
  enabled: z.boolean(),
  /** 是否配置有效 */
  configValid: z.boolean(),
  /** 当前使用的呼号 */
  activeCallsign: z.string().optional(),
  /** 当前使用的网格 */
  activeLocator: z.string().optional(),
  /** 待上报记录数 */
  pendingSpots: z.number(),
  /** 最后上报时间 (Unix毫秒) */
  lastReportTime: z.number().optional(),
  /** 距离下次上报秒数 */
  nextReportIn: z.number().optional(),
  /** 是否正在上报 */
  isReporting: z.boolean(),
  /** 最后错误 */
  lastError: z.string().optional(),
});

/**
 * Host-only setting for PSK Reporter reception feedback: reports of other
 * stations hearing this station's operator callsigns. It is separate from the
 * upload configuration and is not part of the plugin settings surface.
 */
export const PSKReporterReceptionConfigSchema = z.object({
  /** Follow the callsigns of open logbook pages through PSK Reporter. */
  enabled: z.boolean().default(false),
});

/** Connection state of the reception feedback feed for the Host. */
export const PSKReporterReceptionStateSchema = z.enum([
  /** The setting is off; nothing is requested. */
  'disabled',
  /** Enabled, but no open logbook page needs a callsign. */
  'idle',
  'connecting',
  'live',
  /** The live feed dropped; a delayed reconnect is scheduled. */
  'reconnecting',
]);

/** One station that reported hearing a followed callsign. */
export const PSKReporterReceptionSpotSchema = z.object({
  /** Stable identity: sender, receiver and receiver report second. */
  id: z.string().min(1),
  /** Followed callsign that was heard, upper case. */
  senderCallsign: z.string().min(1),
  receiverCallsign: z.string().min(1),
  receiverLocator: z.string().min(4),
  /** RF frequency in Hz when reported. */
  frequency: z.number().optional(),
  mode: z.string(),
  /** Reported SNR in dB when available. */
  snr: z.number().optional(),
  /** Start of the heard transmission (Unix ms); falls back to the report time. */
  transmittedAt: z.number(),
  /** Time the receiver reported the spot (Unix ms). */
  reportedAt: z.number(),
  /** `live` arrived through the realtime feed, `history` through the backfill query. */
  source: z.enum(['live', 'history']),
});

/** Reception feedback pushed to a logbook page connection. */
export const PSKReporterReceptionUpdateSchema = z.object({
  /** `snapshot` replaces the client view; `append` adds new spots. */
  kind: z.enum(['snapshot', 'append']),
  state: PSKReporterReceptionStateSchema,
  /** Callsigns followed for this connection. */
  callsigns: z.array(z.string()),
  /** Retention window of the spots in ms, measured from `transmittedAt`. */
  windowMs: z.number().positive(),
  spots: z.array(PSKReporterReceptionSpotSchema),
});

// 类型导出
export type PSKReporterReceptionConfig = z.infer<typeof PSKReporterReceptionConfigSchema>;
export type PSKReporterReceptionState = z.infer<typeof PSKReporterReceptionStateSchema>;
export type PSKReporterReceptionSpot = z.infer<typeof PSKReporterReceptionSpotSchema>;
export type PSKReporterReceptionUpdate = z.infer<typeof PSKReporterReceptionUpdateSchema>;
export type PSKReporterStats = z.infer<typeof PSKReporterStatsSchema>;
export type PSKReporterConfig = z.infer<typeof PSKReporterConfigSchema>;

export const PSKReporterConfigPatchSchema = configPatchSchema(PSKReporterConfigSchema);
export type PSKReporterSpot = z.infer<typeof PSKReporterSpotSchema>;
export type PSKReporterStatus = z.infer<typeof PSKReporterStatusSchema>;
