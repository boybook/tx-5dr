import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import {
  LogBookListResponseSchema,
  LogBookDetailResponseSchema,
  LogBookActionResponseSchema,
  LogbookRecoveryRetryResponseSchema,
  LogbookBackupStatusResponseSchema,
  LogbookRestorePreflightResponseSchema,
  LogbookUnsavedQsoRetryResponseSchema,
  LogbookUnsavedQsoDiscardResponseSchema,
  CreateLogbookBackupRequestSchema,
  PrepareLogbookRestoreRequestSchema,
  RestoreLogbookRequestSchema,
  LogbookConditionalMutationHeadersSchema,
  LogBookImportResponseSchema,
  CreateLogBookRequestSchema,
  UpdateLogBookRequestSchema,
  ConnectOperatorToLogBookRequestSchema,
  LogBookQSOQueryOptionsSchema,
  LogBookRecentGlobeQuerySchema,
  LogBookRecentGlobeResponseSchema,
  LogBookWorkedGridQuerySchema,
  LogBookWorkedGridResponseSchema,
  LogBookExportOptionsSchema,
  UpdateQSORequestSchema,
  CreateQSORequestSchema,
  getFourCharacterGrid,
  UserRole,
  type LogBookInfo,
  type LogbookBackupStatus,
  type CreateLogBookRequest,
  type UpdateLogBookRequest,
  type ConnectOperatorToLogBookRequest,
  type LogBookQSOQueryOptions,
  type LogBookRecentGlobeQuery,
  type LogBookWorkedGridQuery,
  type LogBookExportOptions,
  type LogBookImportFormat,
  type UpdateQSORequest,
  type CreateQSORequest,
  type QSORecord,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { gridToCoordinates, LogbookOperationError, LogQueryOptions } from "@tx5dr/core";
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { requireRole, requireExistingLogbookAccess } from '../auth/authPlugin.js';
import { AuthManager } from '../auth/AuthManager.js';
import { normalizeCallsign } from '../utils/callsign.js';
import { detectLogImportFormat, normalizeImportText } from '../log/logImportUtils.js';
import { safeBackupErrorMessage } from '../log/backup/AdifBackupService.js';

const logger = createLogger('LogbooksRoute');
const LOGBOOK_IMPORT_FILE_SIZE_LIMIT_MB = 100;
const LOGBOOK_IMPORT_FILE_SIZE_LIMIT_BYTES = LOGBOOK_IMPORT_FILE_SIZE_LIMIT_MB * 1024 * 1024;

function toLogbookRouteError(error: unknown, fallbackCode: RadioErrorCode): RadioError {
  if (error instanceof RadioError) return error;
  if (error instanceof LogbookOperationError) {
    return new RadioError({
      code: error.code as RadioErrorCode,
      message: error.message,
      userMessage: error.message,
      severity: RadioErrorSeverity.ERROR,
      suggestions: error.code === 'LOGBOOK_WRITE_FAILED'
        ? ['Free disk space or verify the logbook directory, then retry']
        : ['Review the logbook status and use Retry after resolving the reported issue'],
      cause: error,
      context: error.systemCode ? { systemCode: error.systemCode } : undefined,
    });
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && error.code.startsWith('LOGBOOK_')) {
    const systemCode = findSystemErrorCode(error);
    const message = isBackupOperationCode(error.code)
      ? safeBackupErrorMessage(error.code)
      : error instanceof Error ? error.message : error.code;
    return new RadioError({
      code: error.code as RadioErrorCode,
      message,
      userMessage: message,
      severity: RadioErrorSeverity.ERROR,
      suggestions: ['Refresh the logbook recovery status and retry'],
      cause: error,
      context: systemCode ? { systemCode } : undefined,
    });
  }
  return RadioError.from(error, fallbackCode);
}

function isBackupOperationCode(code: string): boolean {
  return code === 'LOGBOOK_BACKUP_UNAVAILABLE'
    || code === 'LOGBOOK_BACKUP_FAILED'
    || code === 'LOGBOOK_BACKUP_CHANGED'
    || code === 'LOGBOOK_RESTORE_PRECONDITION_FAILED'
    || code === 'LOGBOOK_REVISION_MISMATCH'
    || code === 'LOGBOOK_MAINTENANCE';
}

function toBackupRouteError(error: unknown): RadioError {
  if (error instanceof Error && error.name === 'ZodError') {
    return new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Invalid logbook backup request',
      userMessage: 'Check the backup request and try again',
      severity: RadioErrorSeverity.WARNING,
      cause: error,
    });
  }

  const routed = toLogbookRouteError(error, RadioErrorCode.LOGBOOK_BACKUP_FAILED);
  if (
    routed.code === RadioErrorCode.AUTH_FAILED
    || routed.code === RadioErrorCode.LOGBOOK_PRECONDITION_REQUIRED
    || routed.code === RadioErrorCode.LOGBOOK_IDEMPOTENCY_CONFLICT
  ) return routed;

  const code = isBackupOperationCode(routed.code)
    ? routed.code
    : RadioErrorCode.LOGBOOK_BACKUP_FAILED;
  const systemCode = findSystemErrorCode(error) ?? (
    typeof routed.context?.systemCode === 'string' ? routed.context.systemCode : undefined
  );
  const message = safeBackupErrorMessage(code);
  return new RadioError({
    code: code as RadioErrorCode,
    message,
    userMessage: message,
    severity: RadioErrorSeverity.ERROR,
    suggestions: ['Refresh the logbook recovery status and retry'],
    cause: error,
    context: systemCode ? { systemCode } : undefined,
  });
}

function safeBackupStatusForClient(status: LogbookBackupStatus): LogbookBackupStatus {
  return {
    ...status,
    mainHealth: {
      ...status.mainHealth,
      issues: status.mainHealth.issues.map(issue => ({
        ...issue,
        message: safeLogbookHealthIssueMessage(issue.code),
      })),
    },
    error: status.error
      ? {
          code: status.error.code,
          message: safeBackupErrorMessage(status.error.code),
        }
      : undefined,
  };
}

function safeLogbookHealthIssueMessage(code: string): string {
  switch (code) {
    case 'ADIF_INCOMPLETE_TAIL':
      return 'The ADIF has an incomplete tail; complete records remain readable but writes are paused.';
    case 'MAIN_FILE_MISSING':
      return 'The formal ADIF file is missing.';
    case 'MAIN_SCAN_FAILED':
      return 'The formal ADIF file could not be read safely.';
    case 'GENERATION_CONFLICT':
      return 'The ADIF content changed outside this process; reopen the logbook before writing.';
    default:
      return 'The logbook reported a persistence issue.';
  }
}

function findSystemErrorCode(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && !candidate.code.startsWith('LOGBOOK_')) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function toLogBookInfo(logBook: NonNullable<FastifyRequest['logBookInstance']>): LogBookInfo {
  return {
    id: logBook.id,
    name: logBook.name,
    description: logBook.description,
    fileName: path.basename(logBook.filePath),
    storageKind: logBook.storageKind === 'ephemeral' ? 'managed' : logBook.storageKind,
    createdAt: logBook.createdAt,
    lastUsed: logBook.lastUsed,
    isActive: logBook.isActive,
    health: logBook.provider.getHealth(),
  };
}

function boundLogBook(request: FastifyRequest) {
  if (!request.logBookInstance) {
    throw new RadioError({
      code: RadioErrorCode.RESOURCE_UNAVAILABLE,
      message: 'Logbook not found',
      userMessage: 'Logbook not found',
      severity: RadioErrorSeverity.WARNING,
    });
  }
  return request.logBookInstance;
}

function requireConditionalHeaders(request: FastifyRequest) {
  const revision = request.headers['if-match'];
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof revision !== 'string' || typeof idempotencyKey !== 'string') {
    throw new RadioError({
      code: RadioErrorCode.LOGBOOK_PRECONDITION_REQUIRED,
      message: 'If-Match and Idempotency-Key headers are required',
      userMessage: 'Refresh the logbook status before retrying this operation',
      severity: RadioErrorSeverity.WARNING,
    });
  }
  return LogbookConditionalMutationHeadersSchema.parse({ revision, idempotencyKey });
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string') {
    throw new RadioError({
      code: RadioErrorCode.LOGBOOK_PRECONDITION_REQUIRED,
      message: 'Idempotency-Key header is required',
      userMessage: 'Retry this operation from the refreshed logbook page',
      severity: RadioErrorSeverity.WARNING,
    });
  }
  return LogbookConditionalMutationHeadersSchema.shape.idempotencyKey.parse(idempotencyKey);
}

function idempotencyScope(request: FastifyRequest, logBookId: string, operation: string): string {
  return `${request.authUser?.tokenId ?? 'anonymous'}:${logBookId}:${operation}`;
}

function revisionSummary(revision?: string): string | undefined {
  return revision
    ? createHash('sha256').update(revision).digest('hex').slice(0, 16)
    : undefined;
}

function auditLogbookOperation(
  request: FastifyRequest,
  logBookId: string,
  operation: string,
  outcome: 'requested' | 'succeeded' | 'failed',
  details: {
    startedAt: number;
    revision?: string;
    operationId?: string;
    bytes?: number;
    records?: number;
    errorCode?: string;
  },
): void {
  logger.info('Logbook recovery audit', {
    requestId: request.id,
    tokenId: request.authUser?.tokenId ?? null,
    role: request.authUser?.role ?? null,
    logBookId,
    operation,
    outcome,
    operationId: details.operationId,
    revision: revisionSummary(details.revision),
    bytes: details.bytes,
    records: details.records,
    durationMs: Date.now() - details.startedAt,
    remoteAddress: request.ip,
    errorCode: details.errorCode,
  });
}

function assertRestoreConfirmation(logBookId: string, confirmation: string, callsigns: string[]): void {
  const confirmed = confirmation === logBookId || callsigns.includes(confirmation);
  if (!confirmed) {
    throw new RadioError({
      code: RadioErrorCode.LOGBOOK_RESTORE_PRECONDITION_FAILED,
      message: 'Restore confirmation does not match this logbook',
      userMessage: 'Enter the exact logbook ID or associated callsign to confirm recovery',
      severity: RadioErrorSeverity.WARNING,
    });
  }
}

function assertCurrentAdmin(tokenId: string): Promise<void> {
  const authManager = AuthManager.getInstance();
  if (!authManager.isAuthEnabled()) return Promise.resolve();
  const permissions = authManager.getTokenCurrentPermissions(tokenId);
  if (!authManager.isTokenStillValid(tokenId) || permissions?.role !== UserRole.ADMIN) {
    return Promise.reject(new RadioError({
      code: RadioErrorCode.AUTH_FAILED,
      message: 'Administrator authorization changed before the logbook replace step',
      userMessage: 'Administrator access is required to restore this logbook',
      severity: RadioErrorSeverity.WARNING,
    }));
  }
  return Promise.resolve();
}

function requireAdminPreHandler() {
  const roleCheck = requireRole(UserRole.ADMIN);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser?.role !== UserRole.ADMIN) {
      return roleCheck(request, reply);
    }
  };
}

function sendBackupDownload(reply: FastifyReply, download: {
  stream: NodeJS.ReadableStream;
  fileName: string;
  size: number;
  close(): Promise<void>;
}, onSettled: (outcome: 'succeeded' | 'failed', error?: unknown) => void): FastifyReply {
  const safeFileName = download.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  let settled = false;
  const settle = (outcome: 'succeeded' | 'failed', error?: unknown) => {
    if (settled) return;
    settled = true;
    void download.close().catch(error => logger.warn('Failed to close logbook download handle', {
      error: error instanceof Error ? error.message : String(error),
    }));
    onSettled(outcome, error);
  };
  reply.raw.once('finish', () => settle('succeeded'));
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) {
      settle('failed', new Error('The backup download connection closed before completion'));
    }
  });
  (download.stream as Readable).once('error', error => settle('failed', error));
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Length', download.size);
  reply.header('Content-Disposition', `attachment; filename="${safeFileName}"`);
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  try {
    return reply.send(download.stream);
  } catch (error) {
    settle('failed', error);
    throw error;
  }
}

function operatorScopeForRequest(request: FastifyRequest, logBookId: string): ReadonlySet<string> | undefined {
  return request.authUser?.role === UserRole.ADMIN
    ? undefined
    : new Set(request.authUser?.operatorIds.filter(operatorId =>
      DigitalRadioEngine.getInstance().operatorManager.getLogManager()
        .getOperatorIdsForLogBook(logBookId).includes(operatorId)) ?? []);
}

type IdempotencyEntry = {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<unknown>;
};

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 256;

class LogbookIdempotencyCache {
  private readonly entries = new Map<string, IdempotencyEntry>();

  run<T>(scope: string, key: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    this.prune();
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const cacheKey = `${scope}:${key}`;
    const existing = this.entries.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new RadioError({
          code: RadioErrorCode.LOGBOOK_IDEMPOTENCY_CONFLICT,
          message: 'The idempotency key was already used with a different request',
          userMessage: 'Refresh the recovery status and retry',
          severity: RadioErrorSeverity.WARNING,
        }));
      }
      return existing.promise as Promise<T>;
    }

    // Cache rejected promises as well: a retry with the same key must replay
    // the same result instead of executing a destructive operation again.
    const promise = operation();
    this.entries.set(cacheKey, {
      fingerprint,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      promise,
    });
    this.prune();
    return promise;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > IDEMPOTENCY_MAX_ENTRIES) {
      const firstKey = this.entries.keys().next().value;
      if (!firstKey) break;
      this.entries.delete(firstKey);
    }
  }
}

const logbookIdempotency = new LogbookIdempotencyCache();

const BAND_FREQUENCY_RANGES: Record<string, { min: number; max: number }> = {
  '160m': { min: 1800000, max: 2000000 },
  '80m': { min: 3500000, max: 4000000 },
  '60m': { min: 5000000, max: 5500000 },
  '40m': { min: 7000000, max: 7300000 },
  '30m': { min: 10100000, max: 10150000 },
  '20m': { min: 14000000, max: 14350000 },
  '17m': { min: 18068000, max: 18168000 },
  '15m': { min: 21000000, max: 21450000 },
  '12m': { min: 24890000, max: 24990000 },
  '10m': { min: 28000000, max: 29700000 },
  '6m': { min: 50000000, max: 54000000 },
  '4m': { min: 70000000, max: 71000000 },
  '2m': { min: 144000000, max: 148000000 },
  '1.25m': { min: 222000000, max: 225000000 },
  '70cm': { min: 420000000, max: 450000000 },
  '33cm': { min: 902000000, max: 928000000 },
  '23cm': { min: 1240000000, max: 1300000000 },
};

function normalizeGridQuery(grid?: string): string | undefined {
  if (!grid) {
    return undefined;
  }

  const normalized = grid.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function getBandFrequencyRange(band?: string): { min: number; max: number } | undefined {
  return band ? BAND_FREQUENCY_RANGES[band] : undefined;
}

function parseUtcDateOnlyStart(date: string): number {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (!year || !month || !day) {
    return new Date(date).getTime();
  }
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

function parseUtcDateOnlyEnd(date: string): number {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (!year || !month || !day) {
    return new Date(date).getTime();
  }
  return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
}

function getImportPayloadFromBody(body: unknown): {
  content: string;
  format: LogBookImportFormat;
} {
  const payload = body as { adifContent?: string } | undefined;
  const content = payload?.adifContent ?? '';
  if (!normalizeImportText(content)) {
    throw new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Missing logbook import content',
      userMessage: 'Import file content is empty',
      severity: RadioErrorSeverity.WARNING,
      suggestions: ['Select a non-empty ADIF file and try again'],
    });
  }

  return {
    // JSON has already decoded the text; preserve its exact UTF-8 content so
    // untouched external records can be appended byte-for-byte by Provider.
    content,
    format: 'adif',
  };
}

function isMultipartFileTooLargeError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE';
}

function createImportFileTooLargeError(): RadioError {
  return new RadioError({
    code: RadioErrorCode.INVALID_OPERATION,
    message: `Import file exceeds ${LOGBOOK_IMPORT_FILE_SIZE_LIMIT_MB}MB limit`,
    userMessage: `The selected import file is too large (max ${LOGBOOK_IMPORT_FILE_SIZE_LIMIT_MB}MB)`,
    severity: RadioErrorSeverity.WARNING,
    suggestions: [
      `Keep the import file under ${LOGBOOK_IMPORT_FILE_SIZE_LIMIT_MB}MB and try again`,
      'Split the ADI/ADIF file by date range and import it in multiple batches',
    ],
  });
}

/**
 * 日志本管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function logbookRoutes(fastify: FastifyInstance) {
  const digitalRadioEngine = DigitalRadioEngine.getInstance();
  const logManager = digitalRadioEngine.operatorManager.getLogManager();
  const existingLogbookAccess = requireExistingLogbookAccess(logManager);
  // ADMIN only preHandler
  const adminOnly = requireAdminPreHandler();

  /**
   * 获取所有日志本列表（按角色过滤）
   * GET /api/logbooks
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // ADMIN 看全部（含孤儿日志本），OPERATOR 只看自己呼号关联的日志本
      const authUser = request.authUser!;
      let logBooks;
      if (authUser.role === UserRole.ADMIN) {
        logBooks = logManager.getLogBooks();
      } else {
        // 构建用户归一化呼号集合
        const operatorsConfig = ConfigManager.getInstance().getOperatorsConfig();
        const userCallsigns = new Set<string>();
        for (const op of operatorsConfig) {
          if (authUser.operatorIds.includes(op.id)) {
            userCallsigns.add(normalizeCallsign(op.myCallsign));
          }
        }
        logBooks = logManager.getAccessibleLogBooksByCallsigns(userCallsigns);
      }

      // 转换为API格式
      const logBookInfos: LogBookInfo[] = logBooks.map(toLogBookInfo);

      const response = LogBookListResponseSchema.parse({
        success: true,
        data: logBookInfos
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取特定日志本详情
   * GET /api/logbooks/:id
   */
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);

      const health = logBook.provider.getHealth();
      const statistics = health.readable
        ? await logBook.provider.getStatistics()
        : {
          totalQSOs: 0,
          uniqueCallsigns: 0,
          uniqueGrids: 0,
          byMode: new Map<string, number>(),
          byBand: new Map<string, number>(),
        };
      
      // 获取连接的操作员
      const connectedOperators = digitalRadioEngine.operatorManager.getAllOperators()
        .filter(op => {
          const logBookId = logManager.getOperatorLogBookId(op.config.id);
          return logBookId === logBook.id;
        })
        .map(op => op.config.id);

      const response = LogBookDetailResponseSchema.parse({
        success: true,
        data: {
          ...toLogBookInfo(logBook),
          statistics: {
            totalQSOs: statistics.totalQSOs || 0,
            totalOperators: connectedOperators.length,
            uniqueCallsigns: statistics.uniqueCallsigns || 0,
            lastQSO: statistics.lastQSOTime ? new Date(statistics.lastQSOTime).toISOString() : undefined,
            firstQSO: statistics.firstQSOTime ? new Date(statistics.firstQSOTime).toISOString() : undefined,
            dxcc: statistics.dxcc,
          },
          connectedOperators
        }
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.post<{ Params: { id: string } }>('/:id/recovery/retry', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const response = await logbookIdempotency.run(
        idempotencyScope(request, logBook.id, 'recovery-retry'),
        idempotencyKey,
        {},
        async () => {
          const health = await logBook.provider.retryOpen();
          return LogbookRecoveryRetryResponseSchema.parse({
            success: true,
            data: { logBookId: logBook.id, health },
          });
        },
      );
      return reply.send(response);
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/backup', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);
      const operatorScope = operatorScopeForRequest(request, logBook.id);
      const unsaved = digitalRadioEngine.operatorManager.listUnsavedQsos(logBook.id, operatorScope);
      const status = await logBook.provider.getBackupStatus({
        admin: request.authUser?.role === UserRole.ADMIN,
        tokenId: request.authUser?.tokenId,
        unsaved,
      });
      return reply.send(LogbookBackupStatusResponseSchema.parse({
        success: true,
        data: safeBackupStatusForClient(status),
      }));
    } catch (error) {
      throw toBackupRouteError(error);
    }
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/:id/backup', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    const startedAt = Date.now();
    const logBook = boundLogBook(request);
    let idempotencyKey: string | undefined;
    try {
      const body = CreateLogbookBackupRequestSchema.parse(request.body ?? {});
      idempotencyKey = requireIdempotencyKey(request);
      auditLogbookOperation(request, logBook.id, 'backup-create', 'requested', { startedAt });
      const response = await logbookIdempotency.run(
        idempotencyScope(request, logBook.id, 'backup-create'),
        idempotencyKey,
        body,
        async () => {
          await logBook.provider.createBackup();
          const operatorScope = operatorScopeForRequest(request, logBook.id);
          const status = await logBook.provider.getBackupStatus({
            admin: request.authUser?.role === UserRole.ADMIN,
            tokenId: request.authUser?.tokenId,
            unsaved: digitalRadioEngine.operatorManager.listUnsavedQsos(logBook.id, operatorScope),
          });
          return LogbookBackupStatusResponseSchema.parse({
            success: true,
            data: safeBackupStatusForClient(status),
          });
        },
      );
      auditLogbookOperation(request, logBook.id, 'backup-create', 'succeeded', {
        startedAt,
        revision: response.data.revision,
        operationId: response.data.operation?.id,
        bytes: response.data.latest?.size,
        records: response.data.latest?.recordCount,
      });
      return reply.send(response);
    } catch (error) {
      const routed = toBackupRouteError(error);
      auditLogbookOperation(request, logBook.id, 'backup-create', 'failed', {
        startedAt,
        errorCode: routed.code,
      });
      throw routed;
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/backup/download', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    const startedAt = Date.now();
    const logBook = boundLogBook(request);
    try {
      auditLogbookOperation(request, logBook.id, 'backup-download', 'requested', { startedAt });
      const download = await logBook.provider.openBackupDownload('latest');
      return sendBackupDownload(reply, download, (outcome) => {
        auditLogbookOperation(request, logBook.id, 'backup-download', outcome, {
          startedAt,
          bytes: download.size,
          errorCode: outcome === 'failed' ? 'LOGBOOK_BACKUP_FAILED' : undefined,
        });
      });
    } catch (error) {
      const routed = toBackupRouteError(error);
      auditLogbookOperation(request, logBook.id, 'backup-download', 'failed', {
        startedAt,
        errorCode: routed.code,
      });
      throw routed;
    }
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/:id/backup/restore/prepare', {
    preHandler: [existingLogbookAccess, adminOnly],
  }, async (request, reply) => {
    const startedAt = Date.now();
    const logBook = boundLogBook(request);
    try {
      const body = PrepareLogbookRestoreRequestSchema.parse(request.body ?? {});
      const headers = requireConditionalHeaders(request);
      const tokenId = request.authUser!.tokenId;
      auditLogbookOperation(request, logBook.id, 'restore-prepare', 'requested', {
        startedAt,
        revision: headers.revision,
      });
      const preflight = await logbookIdempotency.run(
        idempotencyScope(request, logBook.id, 'restore-prepare'),
        headers.idempotencyKey,
        { body, revision: headers.revision },
        () => logBook.provider.prepareBackupRestore(tokenId, headers.revision),
      );
      auditLogbookOperation(request, logBook.id, 'restore-prepare', 'succeeded', {
        startedAt,
        revision: preflight.revision,
        bytes: preflight.backup.size,
        records: preflight.backup.recordCount,
      });
      return reply.send(LogbookRestorePreflightResponseSchema.parse({ success: true, data: preflight }));
    } catch (error) {
      const routed = toBackupRouteError(error);
      auditLogbookOperation(request, logBook.id, 'restore-prepare', 'failed', {
        startedAt,
        errorCode: routed.code,
      });
      throw routed;
    }
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/:id/backup/restore', {
    preHandler: [existingLogbookAccess, adminOnly],
  }, async (request, reply) => {
    const startedAt = Date.now();
    const logBook = boundLogBook(request);
    try {
      const body = RestoreLogbookRequestSchema.parse(request.body ?? {});
      const headers = requireConditionalHeaders(request);
      const tokenId = request.authUser!.tokenId;
      assertRestoreConfirmation(logBook.id, body.confirmation, logManager.getCallsignsForLogBook(logBook.id));
      auditLogbookOperation(request, logBook.id, 'restore', 'requested', {
        startedAt,
        revision: headers.revision,
      });
      const status = await logbookIdempotency.run(
        idempotencyScope(request, logBook.id, 'restore'),
        headers.idempotencyKey,
        { body, revision: headers.revision },
        () => logBook.provider.restoreBackup({
          tokenId,
          preflightToken: body.preflightToken,
          expectedRevision: headers.revision,
          beforeReplace: () => assertCurrentAdmin(tokenId),
        }),
      );
      auditLogbookOperation(request, logBook.id, 'restore', 'succeeded', {
        startedAt,
        revision: status.revision,
        operationId: status.operation?.id,
        bytes: status.latest?.size,
        records: status.latest?.recordCount,
      });
      return reply.send(LogbookBackupStatusResponseSchema.parse({
        success: true,
        data: safeBackupStatusForClient(status),
      }));
    } catch (error) {
      const routed = toBackupRouteError(error);
      auditLogbookOperation(request, logBook.id, 'restore', 'failed', {
        startedAt,
        errorCode: routed.code,
      });
      throw routed;
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/backup/pre-restore/download', {
    preHandler: [existingLogbookAccess, adminOnly],
  }, async (request, reply) => {
    const startedAt = Date.now();
    const logBook = boundLogBook(request);
    try {
      auditLogbookOperation(request, logBook.id, 'pre-restore-download', 'requested', { startedAt });
      const download = await logBook.provider.openBackupDownload('pre-restore');
      return sendBackupDownload(reply, download, (outcome) => {
        auditLogbookOperation(request, logBook.id, 'pre-restore-download', outcome, {
          startedAt,
          bytes: download.size,
          errorCode: outcome === 'failed' ? 'LOGBOOK_BACKUP_FAILED' : undefined,
        });
      });
    } catch (error) {
      const routed = toBackupRouteError(error);
      auditLogbookOperation(request, logBook.id, 'pre-restore-download', 'failed', {
        startedAt,
        errorCode: routed.code,
      });
      throw routed;
    }
  });

  fastify.post<{ Params: { id: string; attemptId: string } }>('/:id/unsaved-qsos/:attemptId/retry', {
    preHandler: [existingLogbookAccess],
  }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const operatorScope = operatorScopeForRequest(request, logBook.id);
      const record = await logbookIdempotency.run(
        idempotencyScope(request, logBook.id, `unsaved-retry:${request.params.attemptId}`),
        idempotencyKey,
        { attemptId: request.params.attemptId },
        () => digitalRadioEngine.operatorManager.retryUnsavedQso(
          logBook.id,
          request.params.attemptId,
          operatorScope,
        ),
      );
      return reply.send(LogbookUnsavedQsoRetryResponseSchema.parse({ success: true, data: record }));
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.delete<{ Params: { id: string; attemptId: string } }>('/:id/unsaved-qsos/:attemptId', {
    preHandler: [existingLogbookAccess],
  }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);
      const operatorScope = operatorScopeForRequest(request, logBook.id);
      digitalRadioEngine.operatorManager.discardUnsavedQso(
        logBook.id,
        request.params.attemptId,
        operatorScope,
      );
      return reply.send(LogbookUnsavedQsoDiscardResponseSchema.parse({
        success: true,
        data: { attemptId: request.params.attemptId },
      }));
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 创建新日志本
   * POST /api/logbooks
   */
  fastify.post<{ Body: CreateLogBookRequest }>('/', { preHandler: [adminOnly] }, async (request, reply) => {
    try {
      const requestData = CreateLogBookRequestSchema.parse(request.body);
      
      const logBook = await logManager.createLogBook(requestData);

      const response = LogBookActionResponseSchema.parse({
        success: true,
        message: 'Logbook created successfully',
        data: toLogBookInfo(logBook),
      });

      return reply.status(201).send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 更新日志本信息
   * PUT /api/logbooks/:id
   */
  fastify.put<{ Params: { id: string }; Body: UpdateLogBookRequest }>('/:id', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const updates = UpdateLogBookRequestSchema.parse(request.body);
      const logBook = boundLogBook(request);

      // 更新日志本属性
      if (updates.name !== undefined) {
        logBook.name = updates.name;
      }
      if (updates.description !== undefined) {
        logBook.description = updates.description;
      }
      if (updates.isActive !== undefined) {
        logBook.isActive = updates.isActive;
      }

      const response = LogBookActionResponseSchema.parse({
        success: true,
        message: 'Logbook updated successfully',
        data: toLogBookInfo(logBook),
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  /**
   * 删除日志本（仅 ADMIN）
   * DELETE /api/logbooks/:id
   */
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [existingLogbookAccess, adminOnly] }, async (request, reply) => {
    try {
      await logManager.deleteLogBook(boundLogBook(request).id);

      return reply.send({
        success: true,
        message: 'Logbook deleted successfully'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 连接操作员到日志本（仅 ADMIN）
   * POST /api/logbooks/:id/connect
   */
  fastify.post<{ Params: { id: string }; Body: ConnectOperatorToLogBookRequest }>('/:id/connect', { preHandler: [existingLogbookAccess, adminOnly] }, async (request, reply) => {
    try {
      const logBookId = boundLogBook(request).id;
      const { operatorId } = ConnectOperatorToLogBookRequestSchema.parse(request.body);
      
      await digitalRadioEngine.operatorManager.connectOperatorToLogBook(operatorId, logBookId);

      return reply.send({
        success: true,
        message: `Operator ${operatorId} connected to logbook ${logBookId}`
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 断开操作员与日志本的连接（仅 ADMIN）
   * POST /api/logbooks/disconnect/:operatorId
   */
  fastify.post<{ Params: { operatorId: string } }>('/disconnect/:operatorId', { preHandler: [adminOnly] }, async (request, reply) => {
    try {
      const { operatorId } = request.params;
      
      digitalRadioEngine.operatorManager.disconnectOperatorFromLogBook(operatorId);

      return reply.send({
        success: true,
        message: `Operator ${operatorId} disconnected from logbook`
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 查询日志本中的QSO记录
   * GET /api/logbooks/:id/qsos
   */
  fastify.get<{ Params: { id: string }; Querystring: LogBookQSOQueryOptions }>('/:id/qsos', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const options = LogBookQSOQueryOptionsSchema.parse(request.query);
      const logBook = boundLogBook(request);

      // 转换查询选项格式以匹配LogQueryOptions接口
      const queryOptions: LogQueryOptions = {
        callsign: options.callsign,
        grid: normalizeGridQuery(options.grid),
        mode: options.mode,
        dxccStatus: options.dxccStatus,
        qslFlow: options.qslFlow,
        excludeModes: options.excludeModes
          ? options.excludeModes.split(',').map(m => m.trim()).filter(Boolean)
          : undefined,
        qslStatus: options.qslStatus,
        limit: options.limit,
        offset: options.offset,
        orderBy: 'time',
        orderDirection: 'desc'
      };

      // 处理频段过滤（转换为频率范围）
      if (options.band) {
        const bandFrequencyRange = getBandFrequencyRange(options.band);
        if (bandFrequencyRange) {
          queryOptions.frequencyRange = bandFrequencyRange;
        }
      }

      // 处理日期范围过滤（转换为时间戳）
      if (options.startDate || options.endDate) {
        const startTime = options.startDate ? new Date(options.startDate).getTime() : 0;
        let endTime = Date.now();
        
        if (options.endDate) {
          // 结束日期包含整天，所以设置为当天23:59:59
          const endDate = new Date(options.endDate);
          endDate.setHours(23, 59, 59, 999);
          endTime = endDate.getTime();
        }
        
        queryOptions.timeRange = {
          start: startTime,
          end: endTime
        };
      }

      // 分离分页参数和筛选参数
      const { limit: requestLimit, offset: requestOffset, ...filterOptions } = queryOptions;

      logger.debug('Pagination request params:', {
        requestLimit,
        requestOffset,
        filterOptions: Object.keys(filterOptions),
      });

      const offset = requestOffset || 0;
      const limit = requestLimit || 100;

      // 带分页的查询 + 两次轻量 count（避免全量扫描+排序）
      const paginatedQsos = await logBook.provider.queryQSOs({ ...filterOptions, limit, offset });
      const totalFiltered = await logBook.provider.countQSOs(filterOptions);
      const totalRecords = await logBook.provider.countQSOs();

      logger.debug('Pagination result:', {
        totalFiltered,
        offset,
        limit,
        paginatedCount: paginatedQsos.length,
        firstRecordId: paginatedQsos[0]?.id,
        firstRecordCallsign: paginatedQsos[0]?.callsign,
      });

      return reply.send({
        success: true,
        data: paginatedQsos,
        meta: {
          total: totalFiltered,
          totalRecords,
          offset,
          limit,
          hasFilters: Object.keys(filterOptions).some(key =>
            key !== 'operatorId' && filterOptions[key as keyof typeof filterOptions] !== undefined
          )
        }
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.get<{ Params: { id: string }; Querystring: LogBookRecentGlobeQuery }>('/:id/recent-globe', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const options = LogBookRecentGlobeQuerySchema.parse(request.query);
      const logBook = boundLogBook(request);
      const startedAt = Date.now();

      logger.info('Building recent globe payload', {
        logBookId: logBook.id,
        operatorId: options.operatorId || null,
        hours: options.hours,
        limit: options.limit,
      });

      const now = Date.now();
      const windowStart = now - options.hours * 60 * 60 * 1000;
      const recentQsos = await logBook.provider.queryQSOs({
        timeRange: { start: windowStart, end: now },
        orderBy: 'time',
        orderDirection: 'desc',
      });

      const stationInfo = ConfigManager.getInstance().getStationInfo();
      const requestedOperator = options.operatorId
        ? digitalRadioEngine.operatorManager.getOperator(options.operatorId)
        : undefined;

      let home: {
        source: 'operator_grid' | 'station_coordinates' | 'station_grid';
        grid?: string;
        latitude: number;
        longitude: number;
      } | null = null;

      if (requestedOperator?.config.myGrid) {
        const coords = gridToCoordinates(requestedOperator.config.myGrid);
        if (coords) {
          home = {
            source: 'operator_grid',
            grid: requestedOperator.config.myGrid,
            latitude: coords.lat,
            longitude: coords.lon,
          };
        }
      }

      if (!home && stationInfo.qth?.latitude != null && stationInfo.qth?.longitude != null) {
        home = {
          source: 'station_coordinates',
          latitude: stationInfo.qth.latitude,
          longitude: stationInfo.qth.longitude,
        };
      }

      if (!home && stationInfo.qth?.grid) {
        const coords = gridToCoordinates(stationInfo.qth.grid);
        if (coords) {
          home = {
            source: 'station_grid',
            grid: stationInfo.qth.grid,
            latitude: coords.lat,
            longitude: coords.lon,
          };
        }
      }

      const items: Array<{
        id: string;
        callsign: string;
        startTime: number;
        mode: string;
        frequency: number;
        grid: string;
      }> = [];
      let droppedInvalidGrid = 0;
      let limited = false;

      for (const qso of recentQsos) {
        const normalizedGrid = normalizeGridQuery(qso.grid);
        if (!normalizedGrid || !gridToCoordinates(normalizedGrid)) {
          droppedInvalidGrid += 1;
          continue;
        }

        items.push({
          id: qso.id,
          callsign: qso.callsign,
          startTime: qso.startTime,
          mode: qso.mode,
          frequency: qso.frequency,
          grid: normalizedGrid,
        });

        if (items.length >= options.limit) {
          limited = true;
          break;
        }
      }

      const response = LogBookRecentGlobeResponseSchema.parse({
        success: true,
        data: {
          home,
          items,
          meta: {
            hours: options.hours,
            totalReturned: items.length,
            droppedInvalidGrid,
            limited,
          },
        },
      });

      logger.info('Recent globe payload ready', {
        logBookId: logBook.id,
        sourceQsoCount: recentQsos.length,
        returnedCount: items.length,
        droppedInvalidGrid,
        limited,
        hasHome: !!home,
        elapsedMs: Date.now() - startedAt,
      });

      return reply.send(response);
    } catch (error) {
      logger.error('Failed to build recent globe payload', error);
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.get<{ Params: { id: string }; Querystring: LogBookWorkedGridQuery }>('/:id/worked-grids', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const options = LogBookWorkedGridQuerySchema.parse(request.query);
      const logBook = boundLogBook(request);

      const queryOptions: LogQueryOptions = {
        orderBy: 'time',
        orderDirection: 'desc',
      };

      const bandFrequencyRange = getBandFrequencyRange(options.band);
      if (bandFrequencyRange) {
        queryOptions.frequencyRange = bandFrequencyRange;
      }

      const qsos = await logBook.provider.queryQSOs(queryOptions);
      const workedGridMap = new Map<string, number>();

      for (const qso of qsos) {
        const workedGrid = getFourCharacterGrid(qso.grid);
        if (!workedGrid) {
          continue;
        }

        workedGridMap.set(workedGrid, (workedGridMap.get(workedGrid) || 0) + 1);
      }

      const items = Array.from(workedGridMap.entries())
        .map(([grid, count]) => ({ grid, count }))
        .sort((left, right) => {
          if (right.count !== left.count) {
            return right.count - left.count;
          }
          return left.grid.localeCompare(right.grid);
        });

      return reply.send(LogBookWorkedGridResponseSchema.parse({
        success: true,
        data: {
          items,
          meta: {
            band: options.band,
            total: items.length,
          },
        },
      }));
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 导出日志本数据
   * GET /api/logbooks/:id/export
   */
  fastify.get<{ Params: { id: string }; Querystring: LogBookExportOptions }>('/:id/export', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const options = LogBookExportOptionsSchema.parse(request.query);
      const logBook = boundLogBook(request);

      // 将LogBookExportOptions转换为LogQueryOptions
      const queryOptions: import('@tx5dr/core').LogQueryOptions = {
        callsign: options.callsign,
        grid: normalizeGridQuery(options.grid),
        mode: options.mode,
        dxccStatus: options.dxccStatus,
        qslFlow: options.qslFlow,
        excludeModes: options.excludeModes
          ? options.excludeModes.split(',').map(m => m.trim()).filter(Boolean)
          : undefined,
        qslStatus: options.qslStatus,
        orderBy: 'time',
        orderDirection: 'desc'
      };

      // 处理频段过滤（转换为频率范围）
      if (options.band) {
        const bandFrequencyRange = getBandFrequencyRange(options.band);
        if (bandFrequencyRange) {
          queryOptions.frequencyRange = bandFrequencyRange;
        }
      }
      
      // 处理日期范围过滤（UTC 自然日，结束日期包含整天）
      if (options.startDate || options.endDate) {
        const startTime = options.startDate ? parseUtcDateOnlyStart(options.startDate) : 0;
        let endTime = Date.now();
        
        if (options.endDate) {
          endTime = parseUtcDateOnlyEnd(options.endDate);
        }
        
        queryOptions.timeRange = {
          start: startTime,
          end: endTime
        };
      }

      // 根据格式选择导出方法
      let exportedData: string;
      if (options.format === 'csv') {
        exportedData = await logBook.provider.exportCSV(queryOptions);
      } else {
        const stationGrid = ConfigManager.getInstance().getStationInfo().qth?.grid;
        exportedData = await logBook.provider.exportADIF(queryOptions, { fallbackGrid: stationGrid });
      }
      
      // 确保返回的是字符串
      if (typeof exportedData !== 'string') {
        fastify.log.error({ type: typeof exportedData }, 'Export method returned non-string type');
        throw new Error('Export data format error');
      }

      // 设置正确的MIME类型和文件扩展名
      const fileExtension = options.format === 'csv' ? 'csv' : 'adi';
      const mimeType = options.format === 'csv' ? 'text/csv' : 'application/octet-stream';
      
      // 清理文件名中的非ASCII字符，避免Content-Disposition头部错误
      const sanitizedFileName = logBook.name.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '_') || 'logbook';
      const fileName = `${sanitizedFileName}.${fileExtension}`;
      
      reply.header('Content-Type', mimeType);
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);

      return reply.send(exportedData);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 导入数据到日志本
   * POST /api/logbooks/:id/import
   */
  fastify.post<{ Params: { id: string }; Body: { adifContent?: string } }>('/:id/import', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const logBook = boundLogBook(request);
      let content: string | Uint8Array;
      let format: LogBookImportFormat;

      if (request.isMultipart()) {
        try {
          const file = await request.file({
            limits: {
              fileSize: LOGBOOK_IMPORT_FILE_SIZE_LIMIT_BYTES,
              files: 1,
            },
          });

          if (!file) {
            throw new RadioError({
              code: RadioErrorCode.INVALID_OPERATION,
              message: 'Missing import file',
              userMessage: 'Please select an import file',
              severity: RadioErrorSeverity.WARNING,
              suggestions: ['Choose an ADI, ADIF, or CSV file and try again'],
            });
          }

          const buffer = await file.toBuffer();
          const detectionText = normalizeImportText(buffer.toString('utf-8'));
          if (!detectionText) {
            throw new RadioError({
              code: RadioErrorCode.INVALID_OPERATION,
              message: 'Import file is empty',
              userMessage: 'The selected import file is empty',
              severity: RadioErrorSeverity.WARNING,
              suggestions: ['Choose a non-empty ADI, ADIF, or CSV file'],
            });
          }
          format = detectLogImportFormat(detectionText, file.filename);
          content = format === 'adif' ? new Uint8Array(buffer) : detectionText;
        } catch (error) {
          if (isMultipartFileTooLargeError(error)) {
            throw createImportFileTooLargeError();
          }
          throw error;
        }
      } else {
        const payload = getImportPayloadFromBody(request.body);
        content = payload.content;
        format = payload.format;
      }

      const result = format === 'csv'
        ? await logBook.provider.importCSV(typeof content === 'string' ? content : Buffer.from(content).toString('utf8'))
        : await logBook.provider.importADIF(content);

      if (result.imported > 0 || result.merged > 0) {
        try {
          const statistics = await logBook.provider.getStatistics();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          digitalRadioEngine.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
          });
        } catch (statsError) {
          logger.warn('Failed to emit logbook update after import:', statsError);
        }
      }

      const response = LogBookImportResponseSchema.parse({
        success: true,
        message: 'Logbook import completed',
        data: result,
      });

      return reply.send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 手动补录 QSO 记录
   * POST /api/logbooks/:id/qsos
   */
  fastify.post<{ Params: { id: string }; Body: CreateQSORequest }>('/:id/qsos', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const body = CreateQSORequestSchema.parse(request.body);
      const logBook = boundLogBook(request);

      const logbookCallsign = logManager.getCallsignsForLogBook(logBook.id)[0];
      const linkedOperator = logbookCallsign
        ? digitalRadioEngine.operatorManager.getAllOperators()
          .find(op => normalizeCallsign(op.config.myCallsign) === logbookCallsign)
        : undefined;
      const operatorId = linkedOperator?.config.id;
      const myCallsign = logbookCallsign || linkedOperator?.config.myCallsign;
      const stationGrid = ConfigManager.getInstance().getStationInfo().qth?.grid;
      const myGrid = linkedOperator?.config.myGrid || stationGrid;

      // 构造 QSORecord，id 格式与自动记录保持一致
      const ownerKey = myCallsign ? normalizeCallsign(myCallsign) : 'manual';
      const newId = `${body.callsign}_${body.startTime}_${Date.now()}_${ownerKey}`;
      const record: QSORecord = {
        id: newId,
        ...body,
        myCallsign,
        myGrid,
        messageHistory: body.messageHistory ?? [],
      };

      const createdRecord = await logBook.provider.addQSO(record, operatorId);

      logger.info('QSO record created manually', { logBookId: logBook.id, callsign: body.callsign, operatorId });

      // 广播 qsoRecordAdded 事件（触发 WS 推送和前端实时更新）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      digitalRadioEngine.emit('qsoRecordAdded' as any, {
        operatorId: operatorId || '',
        logBookId: logBook.id,
        qsoRecord: createdRecord,
      });
      try {
        const statistics = await logBook.provider.getStatistics();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        digitalRadioEngine.emit('logbookUpdated' as any, {
          logBookId: logBook.id,
          statistics,
          operatorId: operatorId || '',
        });
      } catch (statsError) {
        logger.warn('Failed to get logbook statistics after manual QSO creation:', statsError);
      }

      // 自动同步到外部服务（WaveLog / QRZ / LoTW）
      if (myCallsign && operatorId) {
        digitalRadioEngine.operatorManager.triggerAutoSync(createdRecord, myCallsign, operatorId).catch((err) => {
          logger.warn('Auto-sync failed for manually created QSO:', err);
        });
      }

      return reply.status(201).send({
        success: true,
        message: 'QSO record created',
        data: createdRecord,
      });
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 更新单条QSO记录
   * PUT /api/logbooks/:id/qsos/:qsoId
   */
  fastify.put<{ Params: { id: string; qsoId: string }; Body: UpdateQSORequest }>('/:id/qsos/:qsoId', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const { qsoId } = request.params;
      const updates = UpdateQSORequestSchema.parse(request.body);
      const logBook = boundLogBook(request);

      const updatedQSO = await logBook.provider.updateQSO(qsoId, updates);
      const operatorId = logManager.getOperatorIdsForLogBook(logBook.id)[0] ?? '';

      // Provider resolves only after the rewritten ADIF is durably committed.
      // Keep every success notification strictly after that commit point.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      digitalRadioEngine.emit('qsoRecordUpdated' as any, {
        operatorId,
        logBookId: logBook.id,
        qsoRecord: updatedQSO,
      });
      try {
        const statistics = await logBook.provider.getStatistics();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        digitalRadioEngine.emit('logbookUpdated' as any, {
          logBookId: logBook.id,
          statistics,
          operatorId,
        });
      } catch (statsError) {
        logger.warn('Failed to get logbook statistics after manual QSO update:', statsError);
      }

      return reply.send({
        success: true,
        message: 'QSO record updated successfully',
        data: updatedQSO
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 删除单条QSO记录
   * DELETE /api/logbooks/:id/qsos/:qsoId
   */
  fastify.delete<{ Params: { id: string; qsoId: string } }>('/:id/qsos/:qsoId', { preHandler: [existingLogbookAccess] }, async (request, reply) => {
    try {
      const { qsoId } = request.params;
      const logBook = boundLogBook(request);

      // 删除QSO记录
      await logBook.provider.deleteQSO(qsoId);

      try {
        const statistics = await logBook.provider.getStatistics();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        digitalRadioEngine.emit('logbookUpdated' as any, {
          logBookId: logBook.id,
          statistics,
          operatorId: logManager.getOperatorIdsForLogBook(logBook.id)[0] ?? '',
        });
      } catch (statsError) {
        logger.warn('Failed to get logbook statistics after manual QSO deletion:', statsError);
      }

      return reply.send({
        success: true,
        message: 'QSO record deleted successfully'
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  /**
   * 获取日志本数据目录路径（仅 ADMIN）
   * GET /api/logbooks/data-path
   */
  fastify.get('/data-path', { preHandler: [adminOnly] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { tx5drPaths } = await import('../utils/app-paths.js');
      const dataDir = await tx5drPaths.getDataDir();
      const logbookDir = (await import('path')).join(dataDir, 'logbook');

      return reply.send({
        success: true,
        path: logbookDir
      });
    } catch (error) {
      throw toLogbookRouteError(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
