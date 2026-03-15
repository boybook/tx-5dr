import { z } from 'zod';

// ========== QRZ.com Logbook 配置 ==========

/**
 * QRZ.com Logbook 配置 Schema
 */
export const QRZConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().default(''),
  autoUploadQSO: z.boolean().default(false),
  lastSyncTime: z.number().optional(),
});

/**
 * QRZ 测试连接请求 Schema
 */
export const QRZTestConnectionRequestSchema = z.object({
  apiKey: z.string().min(1, 'API密钥不能为空'),
});

/**
 * QRZ 测试连接响应 Schema
 */
export const QRZTestConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  callsign: z.string().optional(),
  logbookCount: z.number().optional(),
});

/**
 * QRZ 同步请求 Schema
 */
export const QRZSyncRequestSchema = z.object({
  operation: z.enum(['upload', 'download', 'full_sync']),
});

/**
 * QRZ 同步响应 Schema
 */
export const QRZSyncResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  uploadedCount: z.number().default(0),
  downloadedCount: z.number().default(0),
  skippedCount: z.number().default(0),
  errorCount: z.number().default(0),
  errors: z.array(z.string()).optional(),
  syncTime: z.number(),
});

// ========== 类型导出 ==========

export type QRZConfig = z.infer<typeof QRZConfigSchema>;
export type QRZTestConnectionRequest = z.infer<typeof QRZTestConnectionRequestSchema>;
export type QRZTestConnectionResponse = z.infer<typeof QRZTestConnectionResponseSchema>;
export type QRZSyncRequest = z.infer<typeof QRZSyncRequestSchema>;
export type QRZSyncResponse = z.infer<typeof QRZSyncResponseSchema>;
