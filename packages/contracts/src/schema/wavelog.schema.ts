import { z } from 'zod';

/**
 * WaveLog Station信息Schema
 */
export const WaveLogStationSchema = z.object({
  station_id: z.string(),
  station_profile_name: z.string(),
  station_callsign: z.string(),
  station_gridsquare: z.string().optional(),
  station_city: z.string().optional(),
  station_country: z.string().optional(),
});

/**
 * WaveLog配置Schema
 */
export const WaveLogConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url('请输入有效的WaveLog URL'),
  apiKey: z.string().min(1, 'API密钥不能为空'),
  stationId: z.string().min(1, 'Station ID不能为空'),
  radioName: z.string().default('TX5DR'),
  autoUploadQSO: z.boolean().default(true),
  lastSyncTime: z.number().optional(), // 时间戳
});

/**
 * WaveLog同步选项Schema
 */
export const WaveLogSyncOptionsSchema = z.object({
  uploadNewQSOs: z.boolean().default(true),
  downloadRemoteQSOs: z.boolean().default(false),
  overwriteLocal: z.boolean().default(false), // true=WaveLog优先，false=本地优先
  syncTimeRange: z.object({
    startDate: z.string().optional(), // ISO日期字符串
    endDate: z.string().optional(),
  }).optional(),
});

/**
 * WaveLog测试连接请求Schema
 */
export const WaveLogTestConnectionRequestSchema = z.object({
  url: z.string().url(),
  apiKey: z.string(),
});

/**
 * WaveLog测试连接响应Schema  
 */
export const WaveLogTestConnectionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  stations: z.array(WaveLogStationSchema).optional(),
});

/**
 * WaveLog同步状态Schema
 */
export const WaveLogSyncStatusSchema = z.object({
  isActive: z.boolean(),
  lastSyncTime: z.number().optional(),
  lastSyncResult: z.enum(['success', 'error', 'partial']).optional(),
  lastSyncMessage: z.string().optional(),
  uploadedCount: z.number().default(0),
  downloadedCount: z.number().default(0),
  errorCount: z.number().default(0),
});

/**
 * WaveLog QSO上传请求Schema
 */
export const WaveLogQSOUploadRequestSchema = z.object({
  qsoIds: z.array(z.string()),
  operatorId: z.string().optional(),
});

/**
 * WaveLog QSO上传响应Schema
 */
export const WaveLogQSOUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  uploadedCount: z.number(),
  failedCount: z.number(),
  errors: z.array(z.string()).optional(),
});

/**
 * WaveLog同步操作请求Schema
 */
export const WaveLogSyncRequestSchema = z.object({
  operation: z.enum(['upload', 'download', 'full_sync']),
  options: WaveLogSyncOptionsSchema.optional(),
});

/**
 * WaveLog同步操作响应Schema
 */
export const WaveLogSyncResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  uploadedCount: z.number().default(0),
  downloadedCount: z.number().default(0),
  skippedCount: z.number().default(0),
  errorCount: z.number().default(0),
  errors: z.array(z.string()).optional(),
  syncTime: z.number(), // 同步完成时间戳
});

// ========== 类型导出 ==========

export type WaveLogStation = z.infer<typeof WaveLogStationSchema>;
export type WaveLogConfig = z.infer<typeof WaveLogConfigSchema>;
export type WaveLogSyncOptions = z.infer<typeof WaveLogSyncOptionsSchema>;
export type WaveLogTestConnectionRequest = z.infer<typeof WaveLogTestConnectionRequestSchema>;
export type WaveLogTestConnectionResponse = z.infer<typeof WaveLogTestConnectionResponseSchema>;
export type WaveLogSyncStatus = z.infer<typeof WaveLogSyncStatusSchema>;
export type WaveLogQSOUploadRequest = z.infer<typeof WaveLogQSOUploadRequestSchema>;
export type WaveLogQSOUploadResponse = z.infer<typeof WaveLogQSOUploadResponseSchema>;
export type WaveLogSyncRequest = z.infer<typeof WaveLogSyncRequestSchema>;
export type WaveLogSyncResponse = z.infer<typeof WaveLogSyncResponseSchema>;