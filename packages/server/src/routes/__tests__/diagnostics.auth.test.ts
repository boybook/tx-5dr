import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(async () => ({ sources: [], limits: {} })),
  upload: vi.fn(async () => ({ uploadId: '3ac3944d-f99e-47cb-a014-d70245639afc' })),
}));

vi.mock('../../diagnostics/DiagnosticLogUploadService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../diagnostics/DiagnosticLogUploadService.js')>();
  return {
    ...actual,
    DiagnosticLogUploadService: {
      getInstance: () => mocks,
    },
  };
});

describe('diagnostic routes authorization', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.listSources.mockClear();
    mocks.upload.mockClear();
    mocks.upload.mockImplementation(async () => ({ uploadId: '3ac3944d-f99e-47cb-a014-d70245639afc' }));
    const { diagnosticRoutes } = await import('../diagnostics.js');
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.decorateRequest('ability', undefined);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const role = (request.headers['x-role'] as UserRole | undefined) ?? UserRole.ADMIN;
      request.authUser = { tokenId: 'test', role, operatorIds: [], iat: 0, exp: 0 };
      request.ability = buildAbility({ role });
    });
    await app.register(diagnosticRoutes, { prefix: '/api/diagnostics' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects non-admin users before reading log sources', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics/log-sources',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it('allows administrators to list sources and submit a bounded request', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/diagnostics/log-sources' });
    expect(list.statusCode).toBe(200);

    const upload = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/uploads',
      payload: {
        sourceId: 'server',
        fromMs: Date.parse('2026-08-21T00:00:00.000Z'),
        toMs: Date.parse('2026-08-21T01:00:00.000Z'),
        feedback: 'Radio stopped',
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'server' }));
  });

  it('returns a traceable failure stage and sanitized request URLs', async () => {
    const { DiagnosticUploadError } = await import('../../diagnostics/DiagnosticLogUploadService.js');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.upload.mockRejectedValueOnce(new DiagnosticUploadError(
      'DIAGNOSTIC_SERVICE_UNAVAILABLE',
      'Diagnostic gateway rejected authorize with status 503',
      503,
      {
        stage: 'gateway_authorization',
        requestUrl: 'https://gateway.example.test/v1/diagnostics/authorize?signature=secret',
        upstreamStatus: 503,
        cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      },
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/uploads?token=must-not-leak',
      payload: {
        sourceId: 'server',
        fromMs: Date.parse('2026-08-21T00:00:00.000Z'),
        toMs: Date.parse('2026-08-21T01:00:00.000Z'),
      },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.context).toMatchObject({
      stage: 'gateway_authorization',
      localRequestUrl: '/api/diagnostics/uploads',
      downstreamRequestUrl: 'https://gateway.example.test/v1/diagnostics/authorize',
      upstreamStatus: 503,
      technicalMessage: 'Diagnostic gateway rejected authorize with status 503',
    });
    expect(body.error.context.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('signature=secret');
    expect(consoleError).toHaveBeenCalledWith(
      '[DiagnosticUpload] diagnostic upload request failed',
      expect.objectContaining({
        stage: 'gateway_authorization',
        requestId: expect.any(String),
        cause: expect.objectContaining({ code: 'ECONNRESET' }),
      }),
    );
  });
});
