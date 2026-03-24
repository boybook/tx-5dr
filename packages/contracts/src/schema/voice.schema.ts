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
 * 引擎模式枚举
 * digital: FT8/FT4 等数字模式
 * voice: 语音通联模式（SSB/FM/AM）
 */
export const EngineModeSchema = z.enum(['digital', 'voice']);
export type EngineMode = z.infer<typeof EngineModeSchema>;
