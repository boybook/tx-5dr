import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateDiagnosticUploadRequestSchema } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import {
  DiagnosticLogUploadService,
  DiagnosticUploadError,
  type DiagnosticUploadErrorCode,
} from '../diagnostics/DiagnosticLogUploadService.js';

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

function sendDiagnosticError(reply: FastifyReply, error: DiagnosticUploadError) {
  const copy = ERROR_COPY[error.code];
  return reply.code(error.statusCode).send({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      userMessage: copy.message,
      userMessageKey: copy.userMessageKey,
      severity: error.code === 'DIAGNOSTIC_NO_LOGS' ? 'warning' : 'error',
      suggestions: [],
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
      if (error instanceof DiagnosticUploadError) return sendDiagnosticError(reply, error);
      throw error;
    }
  });
}
