import Fastify, { type FastifyRequest } from 'fastify';
import { UserRole, type QSORecord } from '@tx5dr/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installApiErrorHandler } from '../../server.js';

const mocks = vi.hoisted(() => {
  const provider = {
    queryQSOs: vi.fn(),
  };
  const logBook = {
    id: 'logbook-N0CALL',
    name: 'N0CALL QSO Log',
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
  return { engine, logBook, provider };
});

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => mocks.engine,
  },
}));

vi.mock('../../auth/authPlugin.js', () => ({
  requireRole: () => async () => undefined,
  requireExistingLogbookAccess: () => async (request: FastifyRequest) => {
    request.logBookInstance = mocks.logBook as never;
  },
}));

function qso(id: string, grid: string, confirmation: Partial<QSORecord> = {}): QSORecord {
  return {
    id,
    callsign: `N${id}`,
    grid,
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: 1_700_000_000_000,
    messageHistory: [],
    ...confirmation,
  } as QSORecord;
}

describe('logbook worked grid route', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.provider.queryQSOs.mockReset();
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

  it('counts confirmed QSOs per grid next to all worked QSOs', async () => {
    mocks.provider.queryQSOs.mockResolvedValue([
      qso('1', 'PM01AA', { lotwQslReceived: 'Y' }),
      qso('2', 'PM01', {}),
      qso('3', 'PM01xx', { qrzQslReceived: 'Y' }),
      qso('4', 'JO22', { lotwQslReceived: 'V' }),
      qso('5', 'FN31', { lotwQslReceived: 'N', qrzQslReceived: 'N' }),
      qso('6', '', {}),
    ]);

    const response = await fastify.inject({ method: 'GET', url: '/api/logbooks/logbook-N0CALL/worked-grids' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([
      { grid: 'PM01', count: 3, confirmedCount: 2 },
      { grid: 'FN31', count: 1, confirmedCount: 0 },
      { grid: 'JO22', count: 1, confirmedCount: 1 },
    ]);
  });

  it('passes the mode filter to the provider and echoes it', async () => {
    mocks.provider.queryQSOs.mockResolvedValue([]);

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/logbooks/logbook-N0CALL/worked-grids?band=20m&mode=FT4',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.provider.queryQSOs).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'FT4',
      frequencyRange: expect.objectContaining({ min: expect.any(Number), max: expect.any(Number) }),
    }));
    expect(response.json().data.meta).toEqual({ band: '20m', mode: 'FT4', total: 0 });
  });
});
