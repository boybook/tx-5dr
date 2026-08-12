import { z } from 'zod';
import { QSORecordSchema } from './qso.schema.js';

export const LOGBOOK_OPERATION_ERROR_CODES = [
  'LOGBOOK_LOADING',
  'LOGBOOK_READ_ONLY',
  'LOGBOOK_UNAVAILABLE',
  'LOGBOOK_WRITE_FAILED',
  'LOGBOOK_WRITE_STATE_UNCERTAIN',
  'LOGBOOK_UNSAVED_QSO_NOT_FOUND',
  'LOGBOOK_BACKUP_FAILED',
  'LOGBOOK_BACKUP_UNAVAILABLE',
  'LOGBOOK_BACKUP_CHANGED',
  'LOGBOOK_MAINTENANCE',
  'LOGBOOK_REVISION_MISMATCH',
  'LOGBOOK_RESTORE_PRECONDITION_FAILED',
  'LOGBOOK_PRECONDITION_REQUIRED',
  'LOGBOOK_IDEMPOTENCY_CONFLICT',
] as const;

export const LogbookOperationErrorCodeSchema = z.enum(LOGBOOK_OPERATION_ERROR_CODES);

export const LogbookHealthStateSchema = z.enum([
  'loading',
  'healthy',
  'degraded',
  'read_only',
  'unavailable',
]);

export const LogbookHealthIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  affectedRecords: z.number().int().nonnegative().optional(),
  affectedBytes: z.number().int().nonnegative().optional(),
  recoveryFileName: z.string().optional(),
  occurredAt: z.number(),
});

export const LogbookHealthSchema = z.object({
  state: LogbookHealthStateSchema,
  readable: z.boolean(),
  writable: z.boolean(),
  issues: z.array(LogbookHealthIssueSchema),
  updatedAt: z.number(),
});

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
  fileName: z.string().min(1).max(255),
  storageKind: z.enum(['managed', 'custom']),
  createdAt: z.number(),
  lastUsed: z.number(),
  isActive: z.boolean(),
  health: LogbookHealthSchema,
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

export const LogbookRecoveryRetryResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    logBookId: z.string(),
    health: LogbookHealthSchema,
  }),
});

const LogbookRevisionSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:"-]+$/);
const LogbookIdempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const LogbookRecoveryTokenSchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const UnsavedQsoAttemptIdSchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const LogbookUnsavedQsoSummarySchema = z.object({
  attemptId: UnsavedQsoAttemptIdSchema,
  operatorId: z.string().min(1).max(128),
  createdAt: z.number(),
  callsign: z.string().max(64),
  mode: z.string().max(32),
});

export const LogbookBackupArtifactSchema = z.object({
  createdAt: z.number(),
  size: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative().optional(),
  opaqueRecordCount: z.number().int().nonnegative().optional(),
});

export const LogbookBackupOperationSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['backup', 'restore-prepare', 'restore']),
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  phase: z.string().min(1).max(128),
  processedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  errorCode: z.string().min(1).max(128).optional(),
});

export const LogbookBackupStatusSchema = z.object({
  logBookId: z.string(),
  revision: LogbookRevisionSchema,
  mainHealth: LogbookHealthSchema,
  dirty: z.boolean(),
  pendingMutations: z.number().int().nonnegative(),
  latest: LogbookBackupArtifactSchema.optional(),
  preRestore: LogbookBackupArtifactSchema.optional(),
  operation: LogbookBackupOperationSchema.optional(),
  unsaved: z.array(LogbookUnsavedQsoSummarySchema).optional(),
  capabilities: z.object({
    canCreate: z.boolean(),
    canDownload: z.boolean(),
    canRestore: z.boolean(),
    canDownloadPreRestore: z.boolean(),
  }),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string(),
  }).optional(),
});

export const LogbookBackupStatusResponseSchema = z.object({
  success: z.literal(true),
  data: LogbookBackupStatusSchema,
});

export const CreateLogbookBackupRequestSchema = z.object({
}).strict();

export const PrepareLogbookRestoreRequestSchema = z.object({
}).strict();

export const RestoreLogbookRequestSchema = z.object({
  preflightToken: LogbookRecoveryTokenSchema,
  confirmation: z.string().min(1).max(128),
}).strict();

export const LogbookConditionalMutationHeadersSchema = z.object({
  revision: LogbookRevisionSchema,
  idempotencyKey: LogbookIdempotencyKeySchema,
}).strict();

export const LogbookIdempotentMutationHeadersSchema = z.object({
  idempotencyKey: LogbookIdempotencyKeySchema,
}).strict();

export const LogbookRestoreFileSummarySchema = z.object({
  size: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  opaqueRecordCount: z.number().int().nonnegative(),
  incompleteTail: z.boolean(),
  issueCount: z.number().int().nonnegative(),
});

export const LogbookRestorePreflightSchema = z.object({
  preflightToken: LogbookRecoveryTokenSchema,
  expiresAt: z.number(),
  revision: LogbookRevisionSchema,
  main: LogbookRestoreFileSummarySchema,
  backup: LogbookRestoreFileSummarySchema,
  recordDelta: z.number().int(),
  estimatedLoss: z.number().int().nonnegative(),
  highRisk: z.boolean(),
});

export const LogbookRestorePreflightResponseSchema = z.object({
  success: z.literal(true),
  data: LogbookRestorePreflightSchema,
});

export const LogbookUnsavedQsoRetryResponseSchema = z.object({
  success: z.literal(true),
  data: QSORecordSchema,
});

export const LogbookUnsavedQsoDiscardResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ attemptId: UnsavedQsoAttemptIdSchema }),
});

export const LogbookUnsavedQsoAttemptParamsSchema = z.object({
  attemptId: UnsavedQsoAttemptIdSchema,
}).strict();

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

export const LogBookWorkedGridQuerySchema = z.object({
  band: z.string().optional(),
});

export const LogBookWorkedGridItemSchema = z.object({
  grid: z.string().regex(/^[A-R]{2}[0-9]{2}$/),
  count: z.number().int().positive(),
});

export const LogBookWorkedGridResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    items: z.array(LogBookWorkedGridItemSchema),
    meta: z.object({
      band: z.string().optional(),
      total: z.number().int().nonnegative(),
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
  grid: z.string().optional(),
  band: z.string().optional(),
  mode: z.string().optional(),
  dxccStatus: z.enum(['deleted']).optional(),
  qslFlow: z.enum(['two_way_confirmed', 'not_two_way_confirmed']).optional(),
  /** 排除的模式列表，逗号分隔，如 "FT8,FT4" */
  excludeModes: z.string().optional(),
  qslStatus: z.enum(['confirmed', 'uploaded', 'none']).optional(),
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
  messageHistory: z.array(z.string()).optional(),
  comment: z.string().optional(),
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
  notes: z.string().optional(),
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
  messageHistory: z.array(z.string()).optional().default([]),
  comment: z.string().optional(),
  notes: z.string().optional(),
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
    messageHistory: z.array(z.string()),
    comment: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
});

// ========== 类型导出 ==========

export type LogBookInfo = z.infer<typeof LogBookInfoSchema>;
export type LogbookOperationErrorCode = z.infer<typeof LogbookOperationErrorCodeSchema>;
export type LogbookHealthState = z.infer<typeof LogbookHealthStateSchema>;
export type LogbookHealthIssue = z.infer<typeof LogbookHealthIssueSchema>;
export type LogbookHealth = z.infer<typeof LogbookHealthSchema>;
export type CreateLogBookRequest = z.infer<typeof CreateLogBookRequestSchema>;
export type UpdateLogBookRequest = z.infer<typeof UpdateLogBookRequestSchema>;
export type ConnectOperatorToLogBookRequest = z.infer<typeof ConnectOperatorToLogBookRequestSchema>;
export type LogBookStatistics = z.infer<typeof LogBookStatisticsSchema>;
export type LogBookDxccSummary = z.infer<typeof LogBookDxccSummarySchema>;
export type LogBookListResponse = z.infer<typeof LogBookListResponseSchema>;
export type LogBookDetailResponse = z.infer<typeof LogBookDetailResponseSchema>;
export type LogBookActionResponse = z.infer<typeof LogBookActionResponseSchema>;
export type LogbookRecoveryRetryResponse = z.infer<typeof LogbookRecoveryRetryResponseSchema>;
export type LogbookUnsavedQsoSummary = z.infer<typeof LogbookUnsavedQsoSummarySchema>;
export type LogbookBackupArtifact = z.infer<typeof LogbookBackupArtifactSchema>;
export type LogbookBackupOperation = z.infer<typeof LogbookBackupOperationSchema>;
export type LogbookBackupStatus = z.infer<typeof LogbookBackupStatusSchema>;
export type LogbookBackupStatusResponse = z.infer<typeof LogbookBackupStatusResponseSchema>;
export type CreateLogbookBackupRequest = z.infer<typeof CreateLogbookBackupRequestSchema>;
export type PrepareLogbookRestoreRequest = z.infer<typeof PrepareLogbookRestoreRequestSchema>;
export type RestoreLogbookRequest = z.infer<typeof RestoreLogbookRequestSchema>;
export type LogbookConditionalMutationHeaders = z.infer<typeof LogbookConditionalMutationHeadersSchema>;
export type LogbookIdempotentMutationHeaders = z.infer<typeof LogbookIdempotentMutationHeadersSchema>;
export type LogbookRestoreFileSummary = z.infer<typeof LogbookRestoreFileSummarySchema>;
export type LogbookRestorePreflight = z.infer<typeof LogbookRestorePreflightSchema>;
export type LogbookRestorePreflightResponse = z.infer<typeof LogbookRestorePreflightResponseSchema>;
export type LogbookUnsavedQsoRetryResponse = z.infer<typeof LogbookUnsavedQsoRetryResponseSchema>;
export type LogbookUnsavedQsoDiscardResponse = z.infer<typeof LogbookUnsavedQsoDiscardResponseSchema>;
export type LogbookUnsavedQsoAttemptParams = z.infer<typeof LogbookUnsavedQsoAttemptParamsSchema>;
export type LogBookQSOQueryOptions = z.infer<typeof LogBookQSOQueryOptionsSchema>;
export type LogBookRecentGlobeQuery = z.infer<typeof LogBookRecentGlobeQuerySchema>;
export type LogBookRecentGlobeHomeSource = z.infer<typeof LogBookRecentGlobeHomeSourceSchema>;
export type LogBookRecentGlobeHome = z.infer<typeof LogBookRecentGlobeHomeSchema>;
export type LogBookRecentGlobeItem = z.infer<typeof LogBookRecentGlobeItemSchema>;
export type LogBookRecentGlobeResponse = z.infer<typeof LogBookRecentGlobeResponseSchema>;
export type LogBookWorkedGridQuery = z.infer<typeof LogBookWorkedGridQuerySchema>;
export type LogBookWorkedGridItem = z.infer<typeof LogBookWorkedGridItemSchema>;
export type LogBookWorkedGridResponse = z.infer<typeof LogBookWorkedGridResponseSchema>;
export type LogBookExportOptions = z.infer<typeof LogBookExportOptionsSchema>;
export type LogBookImportFormat = z.infer<typeof LogBookImportFormatSchema>;
export type LogBookImportResult = z.infer<typeof LogBookImportResultSchema>;
export type LogBookImportResponse = z.infer<typeof LogBookImportResponseSchema>;
export type UpdateQSORequest = z.infer<typeof UpdateQSORequestSchema>;
export type QSOActionResponse = z.infer<typeof QSOActionResponseSchema>; 
