import { z } from 'zod';

export const DxccCountSummarySchema = z.object({
  current: z.number().default(0),
  total: z.number().default(0),
  deleted: z.number().default(0),
});

export const DxccBucketItemSchema = z.object({
  key: z.string(),
  worked: z.number().default(0),
  confirmed: z.number().default(0),
});

export const LogBookDxccSummarySchema = z.object({
  worked: DxccCountSummarySchema,
  confirmed: DxccCountSummarySchema,
  reviewCount: z.number().default(0),
  byBand: z.array(DxccBucketItemSchema).default([]),
  byMode: z.array(DxccBucketItemSchema).default([]),
});

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
  dxcc: LogBookDxccSummarySchema.optional(),
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
  grid: z.string().optional(),
  band: z.string().optional(),
  mode: z.string().optional(),
  dxccStatus: z.enum(['deleted']).optional(),
  qslFlow: z.enum(['two_way_confirmed', 'not_two_way_confirmed']).optional(),
  /** 排除的模式列表，逗号分隔，如 "FT8,FT4" */
  excludeModes: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  qslStatus: z.enum(['confirmed', 'uploaded', 'none']).optional(),
  limit: z.coerce.number().optional().default(100),
  offset: z.coerce.number().optional().default(0),
});

export const LogBookRecentGlobeQuerySchema = z.object({
  operatorId: z.string().optional(),
  hours: z.coerce.number().int().min(1).max(168).optional().default(24),
  limit: z.coerce.number().int().min(1).max(500).optional().default(300),
});

export const LogBookRecentGlobeHomeSourceSchema = z.enum([
  'operator_grid',
  'station_coordinates',
  'station_grid',
]);

export const LogBookRecentGlobeHomeSchema = z.object({
  source: LogBookRecentGlobeHomeSourceSchema,
  grid: z.string().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const LogBookRecentGlobeItemSchema = z.object({
  id: z.string(),
  callsign: z.string(),
  startTime: z.number(),
  mode: z.string(),
  frequency: z.number(),
  grid: z.string(),
});

export const LogBookRecentGlobeResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    home: LogBookRecentGlobeHomeSchema.nullable(),
    items: z.array(LogBookRecentGlobeItemSchema),
    meta: z.object({
      hours: z.number().int().min(1),
      totalReturned: z.number().int().nonnegative(),
      droppedInvalidGrid: z.number().int().nonnegative(),
      limited: z.boolean(),
    }),
  }),
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

export const LogBookImportFormatSchema = z.enum(['adif', 'csv']);

export const LogBookImportResultSchema = z.object({
  detectedFormat: LogBookImportFormatSchema,
  totalRead: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const LogBookImportResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: LogBookImportResultSchema,
});

/**
 * 更新QSO记录请求Schema
 */
export const UpdateQSORequestSchema = z.object({
  callsign: z.string().optional(),
  grid: z.string().optional(),
  qth: z.string().optional(),
  frequency: z.number().optional(),
  mode: z.string().optional(),
  submode: z.string().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  reportSent: z.string().optional(),
  reportReceived: z.string().optional(),
  messages: z.array(z.string()).optional(),
  myGrid: z.string().optional(),
  myCallsign: z.string().optional(),
  // QSL 确认状态
  lotwQslSent: z.enum(['Y', 'N', 'R', 'Q', 'I']).optional(),
  lotwQslReceived: z.enum(['Y', 'N', 'R', 'I', 'V']).optional(),
  lotwQslSentDate: z.number().optional(),
  lotwQslReceivedDate: z.number().optional(),
  qrzQslSent: z.enum(['Y', 'N']).optional(),
  qrzQslReceived: z.enum(['Y', 'N']).optional(),
  qrzQslSentDate: z.number().optional(),
  qrzQslReceivedDate: z.number().optional(),
  remarks: z.string().optional(),
});

/**
 * 手动补录QSO记录请求Schema
 */
export const CreateQSORequestSchema = z.object({
  callsign: z.string().min(1),
  frequency: z.number().positive(),
  mode: z.string().min(1),
  submode: z.string().optional(),
  startTime: z.number().positive(),
  endTime: z.number().optional(),
  grid: z.string().optional(),
  qth: z.string().optional(),
  reportSent: z.string().optional(),
  reportReceived: z.string().optional(),
  messages: z.array(z.string()).optional().default([]),
  remarks: z.string().optional(),
});
export type CreateQSORequest = z.infer<typeof CreateQSORequestSchema>;

/**
 * QSO操作响应Schema
 */
export const QSOActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    id: z.string(),
    callsign: z.string(),
    grid: z.string().optional(),
    frequency: z.number(),
    mode: z.string(),
    submode: z.string().optional(),
    startTime: z.number(),
    endTime: z.number().optional(),
    reportSent: z.string().optional(),
    reportReceived: z.string().optional(),
    messages: z.array(z.string()),
  }).optional(),
});

// ========== 类型导出 ==========

export type LogBookInfo = z.infer<typeof LogBookInfoSchema>;
export type CreateLogBookRequest = z.infer<typeof CreateLogBookRequestSchema>;
export type UpdateLogBookRequest = z.infer<typeof UpdateLogBookRequestSchema>;
export type ConnectOperatorToLogBookRequest = z.infer<typeof ConnectOperatorToLogBookRequestSchema>;
export type LogBookStatistics = z.infer<typeof LogBookStatisticsSchema>;
export type LogBookDxccSummary = z.infer<typeof LogBookDxccSummarySchema>;
export type LogBookListResponse = z.infer<typeof LogBookListResponseSchema>;
export type LogBookDetailResponse = z.infer<typeof LogBookDetailResponseSchema>;
export type LogBookActionResponse = z.infer<typeof LogBookActionResponseSchema>;
export type LogBookQSOQueryOptions = z.infer<typeof LogBookQSOQueryOptionsSchema>;
export type LogBookRecentGlobeQuery = z.infer<typeof LogBookRecentGlobeQuerySchema>;
export type LogBookRecentGlobeHomeSource = z.infer<typeof LogBookRecentGlobeHomeSourceSchema>;
export type LogBookRecentGlobeHome = z.infer<typeof LogBookRecentGlobeHomeSchema>;
export type LogBookRecentGlobeItem = z.infer<typeof LogBookRecentGlobeItemSchema>;
export type LogBookRecentGlobeResponse = z.infer<typeof LogBookRecentGlobeResponseSchema>;
export type LogBookExportOptions = z.infer<typeof LogBookExportOptionsSchema>;
export type LogBookImportFormat = z.infer<typeof LogBookImportFormatSchema>;
export type LogBookImportResult = z.infer<typeof LogBookImportResultSchema>;
export type LogBookImportResponse = z.infer<typeof LogBookImportResponseSchema>;
export type UpdateQSORequest = z.infer<typeof UpdateQSORequestSchema>;
export type QSOActionResponse = z.infer<typeof QSOActionResponseSchema>; 
