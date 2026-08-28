import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateDiagnosticUploadRequestSchema } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import {
  DiagnosticLogUploadService,
  DiagnosticUploadError,
  sanitizeDiagnosticRequestUrl,
  type DiagnosticUploadErrorCode,
} from '../diagnostics/DiagnosticLogUploadService.js';
import { createLogger } from '../utils/logger.js';
import { redactSensitiveLogValue, redactSensitiveText } from '../utils/sensitive-log.js';

const logger = createLogger('DiagnosticUpload');

const ERROR_COPY: Record<DiagnosticUploadErrorCode, { message: string; userMessageKey: string }> = {
  DIAGNOSTIC_NO_LOGS: {
    message: 'No matching log entries were found',
    userMessageKey: 'settings:helpImprove.status.noLogs',
  },
  DIAGNOSTIC_RANGE_TOO_LARGE: {
    message: 'The selected log range is too large',
    userMessageKey: 'settings:helpImprove.status.rangeTooLarge',
  },
  DIAGNOSTIC_SERVICE_UNAVAILABLE: {
    message: 'The diagnostic service is temporarily unavailable',
    userMessageKey: 'settings:helpImprove.status.serviceUnavailable',
  },
  DIAGNOSTIC_UPLOAD_FAILED: {
    message: 'The diagnostic log could not be uploaded',
    userMessageKey: 'settings:helpImprove.status.networkFailed',
  },
};

function serializeError(error: unknown, depth = 0): unknown {
  if (depth >= 4) return '<cause-depth-limit>';
  if (!(error instanceof Error)) return redactSensitiveLogValue(error);
  const withCode = error as Error & { code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown };
  return redactSensitiveLogValue({
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(withCode.code !== undefined ? { code: withCode.code } : {}),
    ...(withCode.errno !== undefined ? { errno: withCode.errno } : {}),
    ...(withCode.syscall !== undefined ? { syscall: withCode.syscall } : {}),
    ...(withCode.cause !== undefined ? { cause: serializeError(withCode.cause, depth + 1) } : {}),
  });
}

function sendDiagnosticError(
  request: { id: string; method: string; url: string },
  reply: FastifyReply,
  error: DiagnosticUploadError,
) {
  const copy = ERROR_COPY[error.code];
  const errorId = randomUUID();
  const localRequestUrl = sanitizeDiagnosticRequestUrl(request.url);
  const context = {
    errorId,
    stage: error.stage ?? 'unknown',
    localRequestUrl,
    ...(error.requestUrl ? { downstreamRequestUrl: error.requestUrl } : {}),
    ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}),
    technicalMessage: redactSensitiveText(error.message),
  };

  logger.error('diagnostic upload request failed', {
    ...context,
    requestId: request.id,
    method: request.method,
    code: error.code,
    responseStatus: error.statusCode,
    error: serializeError(error),
    cause: serializeError(error.cause),
  });

  return reply.code(error.statusCode).send({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      userMessage: copy.message,
      userMessageKey: copy.userMessageKey,
      severity: error.code === 'DIAGNOSTIC_NO_LOGS' ? 'warning' : 'error',
      suggestions: [],
      context,
    },
  });
}

export async function diagnosticRoutes(fastify: FastifyInstance) {
  const service = DiagnosticLogUploadService.getInstance();
  const adminOnly = { preHandler: [requireAbility('manage', 'all')] };

  fastify.get('/log-sources', adminOnly, async (_request, reply) => {
    return reply.send(await service.listSources());
  });

  fastify.post('/uploads', adminOnly, async (request, reply) => {
    const input = CreateDiagnosticUploadRequestSchema.parse(request.body);
    try {
      return reply.code(201).send(await service.upload(input));
    } catch (error) {
      if (error instanceof DiagnosticUploadError) return sendDiagnosticError(request, reply, error);
      throw error;
    }
  });
}
