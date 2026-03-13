import { z } from 'zod';

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

/**
 * PSKReporter 配置 Schema
 */
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
  stats: PSKReporterStatsSchema.default({}),
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

// 类型导出
export type PSKReporterStats = z.infer<typeof PSKReporterStatsSchema>;
export type PSKReporterConfig = z.infer<typeof PSKReporterConfigSchema>;
export type PSKReporterSpot = z.infer<typeof PSKReporterSpotSchema>;
export type PSKReporterStatus = z.infer<typeof PSKReporterStatusSchema>;
