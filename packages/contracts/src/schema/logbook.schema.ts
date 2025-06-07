import { z } from 'zod';

/**
 * 日志本信息Schema
 */
export const LogBookInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  filePath: z.string(),
  createdAt: z.number(),
  lastUsed: z.number(),
  isActive: z.boolean(),
});

/**
 * 创建日志本请求Schema
 */
export const CreateLogBookRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  filePath: z.string().optional(),
  logFileName: z.string().optional(),
  autoCreateFile: z.boolean().optional().default(true),
});

/**
 * 更新日志本请求Schema
 */
export const UpdateLogBookRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

/**
 * 连接操作员到日志本请求Schema
 */
export const ConnectOperatorToLogBookRequestSchema = z.object({
  operatorId: z.string(),
  logBookId: z.string(),
});

/**
 * 日志本统计信息Schema
 */
export const LogBookStatisticsSchema = z.object({
  totalQSOs: z.number(),
  totalOperators: z.number(),
  uniqueCallsigns: z.number(),
  lastQSO: z.string().optional(),
  firstQSO: z.string().optional(),
});

/**
 * 日志本列表响应Schema
 */
export const LogBookListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(LogBookInfoSchema),
});

/**
 * 日志本详情响应Schema
 */
export const LogBookDetailResponseSchema = z.object({
  success: z.boolean(),
  data: LogBookInfoSchema.merge(z.object({
    statistics: LogBookStatisticsSchema,
    connectedOperators: z.array(z.string()),
  })),
});

/**
 * 日志本操作响应Schema
 */
export const LogBookActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: LogBookInfoSchema.optional(),
});

/**
 * 日志本QSO查询选项Schema
 */
export const LogBookQSOQueryOptionsSchema = z.object({
  callsign: z.string().optional(),
  band: z.string().optional(),
  mode: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.number().optional().default(100),
  offset: z.number().optional().default(0),
});

/**
 * 日志本导出选项Schema
 */
export const LogBookExportOptionsSchema = z.object({
  format: z.enum(['adif', 'csv']).default('adif'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  callsign: z.string().optional(),
});

// ========== 类型导出 ==========

export type LogBookInfo = z.infer<typeof LogBookInfoSchema>;
export type CreateLogBookRequest = z.infer<typeof CreateLogBookRequestSchema>;
export type UpdateLogBookRequest = z.infer<typeof UpdateLogBookRequestSchema>;
export type ConnectOperatorToLogBookRequest = z.infer<typeof ConnectOperatorToLogBookRequestSchema>;
export type LogBookStatistics = z.infer<typeof LogBookStatisticsSchema>;
export type LogBookListResponse = z.infer<typeof LogBookListResponseSchema>;
export type LogBookDetailResponse = z.infer<typeof LogBookDetailResponseSchema>;
export type LogBookActionResponse = z.infer<typeof LogBookActionResponseSchema>;
export type LogBookQSOQueryOptions = z.infer<typeof LogBookQSOQueryOptionsSchema>;
export type LogBookExportOptions = z.infer<typeof LogBookExportOptionsSchema>; 