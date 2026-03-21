import { z } from 'zod';
import { WaveLogConfigSchema } from './wavelog.schema.js';
import { QRZConfigSchema } from './qrz.schema.js';
import { LoTWConfigSchema } from './lotw.schema.js';

/**
 * 按呼号绑定的同步配置
 * 每个呼号可独立配置 WaveLog / QRZ / LoTW 同步凭据
 */
export const CallsignSyncConfigSchema = z.object({
  callsign: z.string().min(1),
  wavelog: WaveLogConfigSchema.optional(),
  qrz: QRZConfigSchema.optional(),
  lotw: LoTWConfigSchema.optional(),
});

export type CallsignSyncConfig = z.infer<typeof CallsignSyncConfigSchema>;

/**
 * 同步摘要（用于 UI 显示哪些服务已启用）
 */
export const SyncSummarySchema = z.object({
  wavelog: z.boolean(),
  qrz: z.boolean(),
  lotw: z.boolean(),
});

export type SyncSummary = z.infer<typeof SyncSummarySchema>;
