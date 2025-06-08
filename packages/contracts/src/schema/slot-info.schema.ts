import { z } from 'zod';

/**
 * 时隙周期（偶数奇数）
 */

/**
 * 时隙信息
 */
export const SlotInfoSchema = z.object({
  /** 时隙唯一标识符 */
  id: z.string(),
  /** 时隙开始时间戳（毫秒） */
  startMs: z.number(),
  /** 相位偏移（毫秒） */
  phaseMs: z.number(),
  /** 时钟漂移（毫秒） */
  driftMs: z.number().default(0),
  /** 时隙周期号 */
  cycleNumber: z.number(),
  /** 时隙UTC时间戳（秒） */
  utcSeconds: z.number(),
  /** 时隙类型（FT8/FT4） */
  mode: z.string()
});

export type SlotInfo = z.infer<typeof SlotInfoSchema>;

/**
 * 基于日志本的消息分析结果
 */
export const LogbookAnalysisSchema = z.object({
  /** 是否为新呼号（之前没有通联过） */
  isNewCallsign: z.boolean().optional(),
  /** 是否为新前缀（之前没有通联过类似前缀） */
  isNewPrefix: z.boolean().optional(),
  /** 是否为新网格（之前没有通联过此网格） */
  isNewGrid: z.boolean().optional(),
  /** 解析出的呼号（如果有） */
  callsign: z.string().optional(),
  /** 解析出的网格（如果有） */
  grid: z.string().optional(),
  /** 解析出的前缀（如果有） */
  prefix: z.string().optional()
});

export type LogbookAnalysis = z.infer<typeof LogbookAnalysisSchema>;

/**
 * FT8 帧数据
 */
export const FrameMessageSchema = z.object({
  /** 信号强度 (dB) */
  snr: z.number(),
  /** 频率偏移 (Hz) */
  freq: z.number(),
  /** 时间偏移 (秒) */
  dt: z.number(),
  /** 解码消息 */
  message: z.string(),
  /** 置信度 0-1 */
  confidence: z.number().min(0).max(1).default(1.0),
  /** 基于日志本的分析结果（可选，仅在客户端定制化数据中提供） */
  logbookAnalysis: LogbookAnalysisSchema.optional()
});

export type FrameMessage = z.infer<typeof FrameMessageSchema>;

/**
 * 解码请求，用于SlotScheduler内部
 */
export const DecodeRequestSchema = z.object({
  /** 关联的时隙ID */
  slotId: z.string(),
  /** 子窗口索引 */
  windowIdx: z.number().int().nonnegative(),
  /** PCM 音频数据 */
  pcm: z.instanceof(ArrayBuffer),
  /** 采样率 */
  sampleRate: z.number().positive().default(12000),
  /** 请求时间戳 */
  timestamp: z.number().default(() => Date.now()),
  /** 窗口时间偏移（毫秒） */
  windowOffsetMs: z.number().default(0)
});

export type DecodeRequest = z.infer<typeof DecodeRequestSchema>;

/**
 * 解码结果，用于SlotScheduler内部
 */
export const DecodeResultSchema = z.object({
  /** 关联的时隙ID */
  slotId: z.string(),
  /** 子窗口索引 */
  windowIdx: z.number().int().nonnegative(),
  /** 解码出的帧数据 */
  frames: z.array(FrameMessageSchema),
  /** 结果时间戳 */
  timestamp: z.number().default(() => Date.now()),
  /** 处理耗时（毫秒） */
  processingTimeMs: z.number().nonnegative().default(0),
  /** 错误信息（如果有） */
  error: z.string().optional(),
  /** 窗口时间偏移（毫秒） */
  windowOffsetMs: z.number().default(0)
});

export type DecodeResult = z.infer<typeof DecodeResultSchema>;

/**
 * 时隙封装信息（去重和多次解码取优）
 */
export const SlotPackSchema = z.object({
  /** 时隙ID */
  slotId: z.string(),
  /** 时隙开始时间戳（毫秒） */
  startMs: z.number(),
  /** 时隙结束时间戳（毫秒） */
  endMs: z.number(),
  /** 去重后的最优解码结果 */
  frames: z.array(FrameMessageSchema),
  /** 解码统计信息 */
  stats: z.object({
    /** 总解码次数 */
    totalDecodes: z.number().default(0),
    /** 成功解码次数 */
    successfulDecodes: z.number().default(0),
    /** 去重前的总帧数 */
    totalFramesBeforeDedup: z.number().default(0),
    /** 去重后的帧数 */
    totalFramesAfterDedup: z.number().default(0),
    /** 最后更新时间戳 */
    lastUpdated: z.number().default(() => Date.now())
  }).default({}),
  /** 解码历史（用于调试） */
  decodeHistory: z.array(z.object({
    windowIdx: z.number(),
    timestamp: z.number(),
    frameCount: z.number(),
    processingTimeMs: z.number()
  })).default([])
});

export type SlotPack = z.infer<typeof SlotPackSchema>;