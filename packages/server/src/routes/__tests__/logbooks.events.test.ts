import Fastify, { type FastifyRequest } from 'fastify';
import { UserRole } from '@tx5dr/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const updatedQSO = {
    id: 'qso-1',
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: 1_700_000_000_000,
    messageHistory: [],
  };
  const statistics = {
    totalQSOs: 1,
    uniqueCallsigns: 1,
    uniqueGrids: 0,
    byMode: new Map([['FT8', 1]]),
    byBand: new Map([['20m', 1]]),
  };
  const provider = {
    updateQSO: vi.fn(),
    deleteQSO: vi.fn(),
    getStatistics: vi.fn(),
  };
  const logBook = {
    id: 'logbook-N0CALL',
    provider,
    name: 'N0CALL',
    filePath: '/tmp/N0CALL.adi',
    storageKind: 'managed',
    createdAt: 1,
    lastUsed: 1,
    isActive: true,
  };
  const logManager = {
    getLogBook: vi.fn(),
    getOperatorIdsForLogBook: vi.fn(),
    resolveLogBookId: vi.fn((id: string) => id === logBook.id ? id : null),
  };
  const engine = {
    emit: vi.fn(),
    operatorManager: {
      getLogManager: () => logManager,
    },
  };

  return { engine, logBook, logManager, provider, statistics, updatedQSO };
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

describe('logbook manual mutation events', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.engine.emit.mockReset();
    mocks.provider.updateQSO.mockReset().mockResolvedValue(mocks.updatedQSO);
    mocks.provider.deleteQSO.mockReset().mockResolvedValue(undefined);
    mocks.provider.getStatistics.mockReset().mockResolvedValue(mocks.statistics);
    mocks.logManager.getLogBook.mockReset().mockReturnValue(mocks.logBook);
    mocks.logManager.getOperatorIdsForLogBook.mockReset().mockReturnValue(['operator-1']);

    const { logbookRoutes } = await import('../logbooks.js');
    fastify = Fastify();
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

  it('broadcasts the committed QSO and refreshed statistics after a manual update', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/logbooks/logbook-N0CALL/qsos/qso-1',
      payload: { notes: 'corrected' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.provider.updateQSO).toHaveBeenCalledWith('qso-1', { notes: 'corrected' });
    expect(mocks.engine.emit).toHaveBeenNthCalledWith(1, 'qsoRecordUpdated', {
      operatorId: 'operator-1',
      logBookId: 'logbook-N0CALL',
      qsoRecord: mocks.updatedQSO,
    });
    expect(mocks.engine.emit).toHaveBeenNthCalledWith(2, 'logbookUpdated', {
      operatorId: 'operator-1',
      logBookId: 'logbook-N0CALL',
      statistics: mocks.statistics,
    });
  });

  it('emits no success event when a manual update fails before commit', async () => {
    mocks.provider.updateQSO.mockRejectedValueOnce(new Error('rewrite failed'));

    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/logbooks/logbook-N0CALL/qsos/qso-1',
      payload: { notes: 'must not commit' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.engine.emit).not.toHaveBeenCalled();
    expect(mocks.provider.getStatistics).not.toHaveBeenCalled();
  });

  it('keeps a committed update successful when the best-effort statistics refresh fails', async () => {
    mocks.provider.getStatistics.mockRejectedValueOnce(new Error('statistics unavailable'));

    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/logbooks/logbook-N0CALL/qsos/qso-1',
      payload: { notes: 'committed' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.engine.emit).toHaveBeenCalledOnce();
    expect(mocks.engine.emit).toHaveBeenCalledWith('qsoRecordUpdated', expect.objectContaining({
      qsoRecord: mocks.updatedQSO,
    }));
  });

  it('broadcasts refreshed statistics only after a manual delete commits', async () => {
    const response = await fastify.inject({
      method: 'DELETE',
      url: '/api/logbooks/logbook-N0CALL/qsos/qso-1',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.provider.deleteQSO).toHaveBeenCalledWith('qso-1');
    expect(mocks.engine.emit).toHaveBeenCalledOnce();
    expect(mocks.engine.emit).toHaveBeenCalledWith('logbookUpdated', {
      operatorId: 'operator-1',
      logBookId: 'logbook-N0CALL',
      statistics: mocks.statistics,
    });
  });

  it('emits no success event when a manual delete fails before commit', async () => {
    mocks.provider.deleteQSO.mockRejectedValueOnce(new Error('rewrite failed'));

    const response = await fastify.inject({
      method: 'DELETE',
      url: '/api/logbooks/logbook-N0CALL/qsos/qso-1',
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.engine.emit).not.toHaveBeenCalled();
    expect(mocks.provider.getStatistics).not.toHaveBeenCalled();
  });
});
