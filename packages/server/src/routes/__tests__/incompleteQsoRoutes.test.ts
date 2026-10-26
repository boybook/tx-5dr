import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserRole, type IncompleteQsoCandidate } from '@tx5dr/contracts';
import { ADIFLogProvider } from '../../log/ADIFLogProvider.js';
import { registerIncompleteQsoRoutes } from '../incompleteQsoRoutes.js';

let directory: string | undefined;
let provider: ADIFLogProvider | undefined;

afterEach(async () => {
  await provider?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  provider = undefined;
  directory = undefined;
});

function candidate(id: string, callsign: string, startTime: number): IncompleteQsoCandidate {
  return {
    schemaVersion: 1, id, revision: 1, logBookId: 'logbook-W1AAA', operatorId: 'op-1',
    myCallsign: 'W1AAA', callsign, mode: 'FT8', frequency: 14_075_000,
    startTime, endTime: startTime + 15_000, reportSent: '-9', reportReceived: '-12',
    messages: [
      { slotStartMs: startTime, direction: 'rx', text: `W1AAA ${callsign} -12`, audioOffsetHz: 1000 },
      { slotStartMs: startTime + 15_000, direction: 'tx', text: `${callsign} W1AAA R-09`, audioOffsetHz: 1000 },
    ], status: 'pending',
  };
}

describe('incomplete QSO review routes', () => {
  it('previews and commits distinct candidates while skipping a same-batch duplicate', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-review-route-'));
    provider = new ADIFLogProvider({ logFilePath: path.join(directory, 'main.adi'), logFileName: 'main.adi' });
    await provider.initialize();
    const base = Date.UTC(2026, 8, 25, 12, 0, 0);
    const records = new Map([
      candidate('11111111-1111-4111-8111-111111111111', 'K1BBB', base),
      candidate('22222222-2222-4222-8222-222222222222', 'K1BBB', base + 30_000),
      candidate('33333333-3333-4333-8333-333333333333', 'K2CCC', base + 60_000),
    ].map(item => [item.id, item]));
    let failRecordedStatusOnce = true;
    const review = {
      getHealth: () => ({ state: 'ready', dropped: 0 }),
      get: vi.fn(async (id: string) => records.get(id) ?? null),
      list: vi.fn(async (_book: string, query: { status: string }) => ({
        items: [...records.values()].filter(item => item.status === query.status),
        nextCursor: undefined,
      })),
      update: vi.fn(async (id: string, _book: string, revision: number, patch: Partial<IncompleteQsoCandidate>) => {
        const current = records.get(id)!;
        if (current.revision !== revision) throw new Error('REVIEW_CANDIDATE_CHANGED');
        if (patch.status === 'recorded' && id === '11111111-1111-4111-8111-111111111111' && failRecordedStatusOnce) {
          failRecordedStatusOnce = false;
          throw new Error('candidate disk write failed');
        }
        const next = { ...current, ...patch, revision: revision + 1 };
        records.set(id, next);
        return next;
      }),
    };
    const sync = vi.fn().mockResolvedValue(true);
    const engine = {
      getIncompleteQsoService: () => review,
      pluginManager: { logbookSyncHost: { onQSOsComplete: sync } },
      emit: vi.fn(),
    };
    const book = { id: 'logbook-W1AAA', provider, binding: { kind: 'primary', callsign: 'W1AAA' } };
    const logManager = {
      resolveLogBookId: (id: string) => id === 'alias' ? book.id : id,
      getLogBook: (id: string) => id === book.id ? book : null,
      getOperatorIdsForLogBook: () => ['op-1'],
    };
    const app = Fastify();
    app.addHook('preHandler', async request => {
      (request as any).authUser = { role: UserRole.ADMIN, operatorIds: [] };
    });
    registerIncompleteQsoRoutes(app, engine as never, logManager as never);
    expect((await app.inject({ method: 'GET', url: '/alias/review-candidates/health' })).statusCode).toBe(200);
    const selection = { items: [...records.values()].map(item => ({ id: item.id, revision: item.revision })) };
    const preview = await app.inject({ method: 'POST', url: '/logbook-W1AAA/review-candidates/preview', payload: selection });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.items.map((item: { disposition: string }) => item.disposition)).toEqual(['ready', 'ready', 'ready']);

    const accepted = await app.inject({ method: 'POST', url: '/logbook-W1AAA/review-candidates/commit', payload: selection });
    expect(accepted.statusCode).toBe(202);
    const jobId = accepted.json().data.jobId as string;
    await vi.waitFor(async () => {
      const status = await app.inject({ method: 'GET', url: `/logbook-W1AAA/review-candidates/jobs/${jobId}` });
      expect(status.json().data.state).toBe('finished');
    });
    const qsos = await provider.queryQSOs();
    expect(qsos).toHaveLength(2);
    expect(qsos.map(record => record.id)).toContain('tx5dr-review-11111111-1111-4111-8111-111111111111');
    expect(sync).toHaveBeenCalledOnce();
    expect(sync.mock.calls[0]?.[1]).toHaveLength(2);
    const jobResponse = await app.inject({ method: 'GET', url: `/logbook-W1AAA/review-candidates/jobs/${jobId}` });
    expect(jobResponse.json().data.items[0].disposition).toBe('recorded');
    expect(records.get('11111111-1111-4111-8111-111111111111')?.commitRequested).toBe(true);
    await app.inject({ method: 'GET', url: '/logbook-W1AAA/review-candidates' });
    await vi.waitFor(() => {
      expect(records.get('11111111-1111-4111-8111-111111111111')?.status).toBe('recorded');
    });
    expect(await provider.queryQSOs()).toHaveLength(2);
    await app.close();
  });
});
