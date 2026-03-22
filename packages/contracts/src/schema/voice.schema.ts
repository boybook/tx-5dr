import { z } from 'zod';

/**
 * 语音 PTT 锁状态
 * 语音模式下同一时刻只能有一个用户发射，通过独占锁管理
 */
export const VoicePTTLockSchema = z.object({
  /** 是否被锁定（有人在发射） */
  locked: z.boolean(),
  /** 持有锁的客户端 ID */
  lockedBy: z.string().nullable(),
  /** 持有锁的用户显示名（token label 或 "Admin"） */
  lockedByLabel: z.string().nullable(),
  /** 锁定时间戳 */
  lockedAt: z.number().nullable(),
  /** 超时时间（ms），超时后自动释放 */
  timeoutMs: z.number().default(180000),
});

export type VoicePTTLock = z.infer<typeof VoicePTTLockSchema>;

/**
 * 语音 QSO 记录（手动日志）
 * 与 FT8 自动日志不同，语音 QSO 需要用户手动输入
 */
export const VoiceQSORecordSchema = z.object({
  id: z.string(),
  /** 对方呼号 */
  callsign: z.string(),
  /** 通联频率（Hz） */
  frequency: z.number(),
  /** 电台调制模式：USB/LSB/FM/AM */
  radioMode: z.string(),
  /** 波段（如 20m） */
  band: z.string().optional(),
  /** 通联开始时间（UTC timestamp） */
  startTime: z.number(),
  /** 通联结束时间（UTC timestamp） */
  endTime: z.number().optional(),
  /** RST 发送报告（如 "59"） */
  rstSent: z.string().default('59'),
  /** RST 接收报告（如 "59"） */
  rstReceived: z.string().default('59'),
  /** 对方姓名 */
  name: z.string().optional(),
  /** 对方 QTH */
  qth: z.string().optional(),
  /** 对方网格坐标 */
  grid: z.string().optional(),
  /** 备注 */
  notes: z.string().optional(),
  /** 操作员呼号 */
  myCallsign: z.string(),
  /** 操作员网格坐标 */
  myGrid: z.string().optional(),
  /** 关联的日志本 ID */
  logBookId: z.string(),
});

export type VoiceQSORecord = z.infer<typeof VoiceQSORecordSchema>;

/**
 * 引擎模式枚举
 * digital: FT8/FT4 等数字模式
 * voice: 语音通联模式（SSB/FM/AM）
 */
export const EngineModeSchema = z.enum(['digital', 'voice']);
export type EngineMode = z.infer<typeof EngineModeSchema>;
