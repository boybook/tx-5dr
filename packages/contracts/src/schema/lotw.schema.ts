import { z } from 'zod';

// ========== LoTW (Logbook of The World) 配置 ==========

/**
 * LoTW 配置 Schema
 */
export const LoTWConfigSchema = z.object({
  // 下载确认用
  username: z.string().default(''),
  password: z.string().default(''),
  // TQSL 上传用
  tqslPath: z.string().default(''),
  stationCallsign: z.string().default(''),
  autoUploadQSO: z.boolean().default(false),
  lastUploadTime: z.number().optional(),
  lastDownloadTime: z.number().optional(),
});

/**
 * LoTW 测试连接请求 Schema
 */
export const LoTWTestConnectionRequestSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

/**
 * LoTW 测试连接响应 Schema
 */
export const LoTWTestConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

/**
 * LoTW TQSL 检测请求 Schema
 */
export const LoTWTQSLDetectRequestSchema = z.object({
  tqslPath: z.string().optional(),
});

/**
 * LoTW TQSL 检测响应 Schema
 */
export const LoTWTQSLDetectResponseSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
  stations: z.array(z.string()).optional(),
  message: z.string(),
});

/**
 * LoTW 同步请求 Schema
 */
export const LoTWSyncRequestSchema = z.object({
  operation: z.enum(['upload', 'download_confirmations']),
  since: z.string().optional(),
});

/**
 * LoTW 同步响应 Schema
 */
export const LoTWSyncResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  uploadedCount: z.number().default(0),
  downloadedCount: z.number().default(0),
  confirmedCount: z.number().default(0),
  updatedCount: z.number().default(0),
  importedCount: z.number().default(0),
  errorCount: z.number().default(0),
  errors: z.array(z.string()).optional(),
  syncTime: z.number(),
});

// ========== 类型导出 ==========

export type LoTWConfig = z.infer<typeof LoTWConfigSchema>;
export type LoTWTestConnectionRequest = z.infer<typeof LoTWTestConnectionRequestSchema>;
export type LoTWTestConnectionResponse = z.infer<typeof LoTWTestConnectionResponseSchema>;
export type LoTWTQSLDetectRequest = z.infer<typeof LoTWTQSLDetectRequestSchema>;
export type LoTWTQSLDetectResponse = z.infer<typeof LoTWTQSLDetectResponseSchema>;
export type LoTWSyncRequest = z.infer<typeof LoTWSyncRequestSchema>;
export type LoTWSyncResponse = z.infer<typeof LoTWSyncResponseSchema>;
