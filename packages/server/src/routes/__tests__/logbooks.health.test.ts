import Fastify, { type FastifyRequest } from 'fastify';
import { UserRole, type LogbookHealth } from '@tx5dr/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installApiErrorHandler } from '../../server.js';

const mocks = vi.hoisted(() => {
  const unavailableHealth: LogbookHealth = {
    state: 'unavailable',
    readable: false,
    writable: false,
    issues: [{
      code: 'LOGBOOK_OPEN_FAILED',
      message: 'The logbook could not be opened',
      occurredAt: 1_700_000_000_000,
    }],
    updatedAt: 1_700_000_000_000,
  };
  const healthyHealth: LogbookHealth = {
    state: 'healthy',
    readable: true,
    writable: true,
    issues: [],
    updatedAt: 1_700_000_000_100,
  };
  const provider = {
    getHealth: vi.fn(() => unavailableHealth),
    retryOpen: vi.fn(async () => healthyHealth),
    getStatistics: vi.fn(),
  };
  const logBook = {
    id: 'logbook-N0CALL',
    name: 'N0CALL QSO Log',
    description: 'Unavailable test logbook',
    filePath: '/tmp/N0CALL.adi',
    provider,
    createdAt: 1_699_999_999_000,
    lastUsed: 1_700_000_000_000,
    isActive: true,
    storageKind: 'managed',
  };
  const logManager = {
    getLogBooks: vi.fn(() => [logBook]),
    getLogBook: vi.fn(() => logBook),
    getOperatorLogBookId: vi.fn(() => null),
    resolveLogBookId: vi.fn((id: string) => id === logBook.id ? id : null),
    getOperatorIdsForLogBook: vi.fn(() => []),
    getCallsignsForLogBook: vi.fn(() => []),
  };
  const engine = {
    operatorManager: {
      getLogManager: () => logManager,
      getAllOperators: vi.fn(() => []),
    },
  };

  return {
    engine,
    healthyHealth,
    logBook,
    logManager,
    provider,
    unavailableHealth,
  };
});

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => mocks.engine,
  },
}));

vi.mock('../../auth/authPlugin.js', () => ({
  requireRole: () => async () => undefined,
  requireExistingLogbookAccess: () => async (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const id = (request.params as { id?: string }).id;
    if (id !== mocks.logBook.id) {
      return reply.code(404).send({ success: false, error: { code: 'RESOURCE_UNAVAILABLE' } });
    }
    request.logBookInstance = mocks.logBook as never;
  },
}));

describe('logbook health routes', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.provider.getHealth.mockReset().mockReturnValue(mocks.unavailableHealth);
    mocks.provider.retryOpen.mockReset().mockResolvedValue(mocks.healthyHealth);
    mocks.provider.getStatistics.mockReset();
    mocks.logManager.getLogBook.mockReset().mockReturnValue(mocks.logBook);
    mocks.logManager.getLogBooks.mockReset().mockReturnValue([mocks.logBook]);

    const { logbookRoutes } = await import('../logbooks.js');
    fastify = Fastify({ logger: false });
    installApiErrorHandler(fastify);
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      request.authUser = {
        tokenId: '__test_admin__',
        role: UserRole.ADMIN,
        operatorIds: [],
        iat: 0,
        exp: Number.MAX_SAFE_INTEGER,
      };
    });
    await fastify.register(logbookRoutes, { prefix: '/api/logbooks' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('keeps an unavailable logbook in list and detail responses with its health', async () => {
    const list = await fastify.inject({ method: 'GET', url: '/api/logbooks' });
    const detail = await fastify.inject({
      method: 'GET',
      url: '/api/logbooks/logbook-N0CALL',
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      success: true,
      data: [{ id: 'logbook-N0CALL', health: mocks.unavailableHealth }],
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      success: true,
      data: {
        id: 'logbook-N0CALL',
        health: mocks.unavailableHealth,
        statistics: { totalQSOs: 0, uniqueCallsigns: 0 },
      },
    });
    expect(mocks.provider.getStatistics).not.toHaveBeenCalled();
  });

  it('exposes an explicit recovery retry endpoint and returns the refreshed health', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/logbooks/logbook-N0CALL/recovery/retry',
      headers: { 'Idempotency-Key': 'recovery-test-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.provider.retryOpen).toHaveBeenCalledOnce();
    expect(response.json()).toEqual({
      success: true,
      data: {
        logBookId: 'logbook-N0CALL',
        health: mocks.healthyHealth,
      },
    });
  });
});
