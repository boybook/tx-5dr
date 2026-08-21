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
});
