import { describe, expect, it, vi } from 'vitest';
import type {
  LogbookBatchMutation,
  LogbookBatchResult,
  PluginLogbookSessions,
  QSORecord,
} from '@tx5dr/plugin-api';
import { migrateWWDigiContestEntries } from '../builtin-migrations/ww-digi-contest-entry-migration.js';

function record(overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id: 'legacy-qso',
    callsign: 'JA1AAA',
    grid: 'PM95',
    frequency: 14_091_000,
    mode: 'FT8',
    startTime: Date.UTC(2026, 7, 29, 12),
    messageHistory: ['CQ JA1AAA PM95'],
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    contestId: 'WW-DIGI',
    ...overrides,
  };
}

function mockStore() {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback?: T): T { return (data.has(key) ? structuredClone(data.get(key)) : fallback) as T; },
    set(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    update<T>(key: string, reducer: (current: T | undefined) => T | undefined): T | undefined {
      const next = reducer(this.get<T | undefined>(key));
      if (next === undefined) data.delete(key); else this.set(key, next);
      return next;
    },
    delete(key: string) { data.delete(key); },
    getAll() { return Object.fromEntries([...data].map(([key, value]) => [key, structuredClone(value)])); },
    async flush() {},
  };
}

function createContext(options: {
  logbookSessions: PluginLogbookSessions;
  contestYear?: number;
}) {
  const global = mockStore();
  const operator = mockStore();
  const files = new Map<string, Buffer>();
  const writeFile = vi.fn(async (path: string, value: Buffer) => {
    files.set(path, Buffer.from(value));
  });
  return {
    config: { contestYear: options.contestYear ?? 2026 },
    operator: { id: 'operator-0', callsign: 'BG5DRB' },
    store: { global, operator },
    files: {
      async read(path: string) { return files.get(path) ?? null; },
      write: writeFile,
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    logbook: { sessions: options.logbookSessions },
  };
}

describe('WW Digi contest-entry built-in migration', () => {
  it('backs up legacy state and revision-retries an envelope backfill without deleting sidecars', async () => {
    const records = [record()];
    let revision = 0;
    let attempt = 0;
    const applyQsoBatch = vi.fn(async (
      mutations: readonly LogbookBatchMutation[],
    ): Promise<LogbookBatchResult> => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error('revision changed'), { code: 'LOGBOOK_REVISION_CONFLICT' });
      }
      const outcomes = mutations.map((mutation, inputIndex) => {
        if (mutation.type !== 'update') throw new Error('expected update');
        const index = records.findIndex((candidate) => candidate.id === mutation.qsoId);
        records[index] = { ...records[index]!, ...structuredClone(mutation.updates) };
        return { inputIndex, status: 'updated' as const, record: structuredClone(records[index]!) };
      });
      revision += 1;
      return { revision: `r${revision}`, outcomes };
    });
    const ctx = createContext({
      logbookSessions: {
        async open(descriptor) {
          return {
            id: 'ww-digi-session', title: descriptor.title, callsign: 'BG5DRB',
            getLogBookId: async () => 'ww-digi-session', awaitReady: async () => {},
            queryQSOs: async () => structuredClone(records),
            readQsoSnapshot: async () => ({ revision: `r${revision}`, records: structuredClone(records) }),
            countQSOs: async () => records.length, getStatistics: async () => null,
            addQSO: async (qso) => qso, updateQSO: async (_id, updates) => ({ ...records[0]!, ...updates }),
            applyQsoBatch, notifyUpdated: async () => {}, destroy: async () => {},
          };
        },
        async destroy() {},
      },
    });
    const legacySessionKey = 'contestSession:BG5DRB:2026';
    const legacySession = {
      config: { categoryTransmitter: 'TWO' },
      overrides: {
        'legacy-qso': {
          status: 'included', source: 'imported', operatorId: 'operator-0', transmitterId: 1,
        },
      },
    };
    ctx.store.global.set(legacySessionKey, legacySession);
    ctx.store.operator.set('contestQsos:2026', [{ qsoId: 'orphan' }]);
    ctx.store.operator.set('ledgerHealth:2026', { state: 'healthy' });

    await migrateWWDigiContestEntries(ctx as never);

    expect(applyQsoBatch).toHaveBeenCalledTimes(2);
    expect(records[0]!.contestEntry).toMatchObject({
      contestId: 'WW-DIGI',
      editionId: 'ww-digi-2026',
      rulesetVersion: 'tx5dr-ww-digi-v1',
      sent: { grid: 'OL32' },
      received: { grid: 'PM95' },
      annotations: {
        status: 'included', source: 'imported', operatorId: 'operator-0', transmitterId: 1,
      },
    });
    expect(ctx.store.global.get(legacySessionKey)).toEqual(legacySession);
    const journal = await ctx.files.read('migration/ww-digi-contest-entry/BG5DRB-2026-journal.json');
    expect(JSON.parse(journal!.toString('utf8'))).toMatchObject({
      phase: 'completed',
      migratedRecordIds: ['legacy-qso'],
      sourceRecordCount: 1,
      targetRecordCount: 1,
      sourceRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTargetRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const orphanBackup = await ctx.files.read(
      'migration/ww-digi-contest-entry/BG5DRB-orphan-operator-kv.json',
    );
    expect(JSON.parse(orphanBackup!.toString('utf8')).entries).toMatchObject({
      'contestQsos:2026': [{ qsoId: 'orphan' }],
      'ledgerHealth:2026': { state: 'healthy' },
    });

    const writesAfterCompletion = ctx.files.write.mock.calls.length;
    await migrateWWDigiContestEntries(ctx as never);
    expect(applyQsoBatch).toHaveBeenCalledTimes(2);
    expect(ctx.files.write).toHaveBeenCalledTimes(writesAfterCompletion);

    records[0] = record();
    await migrateWWDigiContestEntries(ctx as never);

    expect(applyQsoBatch).toHaveBeenCalledTimes(3);
    expect(records[0]!.contestEntry).toMatchObject({
      contestId: 'WW-DIGI',
      editionId: 'ww-digi-2026',
      rulesetVersion: 'tx5dr-ww-digi-v1',
    });
    expect(JSON.parse((await ctx.files.read(
      'migration/ww-digi-contest-entry/BG5DRB-2026-journal.json',
    ))!.toString('utf8'))).toMatchObject({
      phase: 'completed',
      sourceRecordCount: 1,
      targetRecordCount: 1,
    });
  });

  it('fails closed to review when a legacy received exchange is not a four-character Maidenhead grid', async () => {
    const records = [record({ grid: '????' })];
    const ctx = createContext({
      logbookSessions: {
        async open(descriptor) {
          return {
            id: 'ww-digi-session', title: descriptor.title, callsign: 'BG5DRB',
            getLogBookId: async () => 'ww-digi-session', awaitReady: async () => {},
            queryQSOs: async () => structuredClone(records),
            readQsoSnapshot: async () => ({ revision: 'r0', records: structuredClone(records) }),
            countQSOs: async () => records.length, getStatistics: async () => null,
            addQSO: async (qso) => qso, updateQSO: async (_id, updates) => ({ ...records[0]!, ...updates }),
            async applyQsoBatch(mutations) {
              const mutation = mutations[0]!;
              if (mutation.type !== 'update') throw new Error('expected update');
              records[0] = { ...records[0]!, ...structuredClone(mutation.updates) };
              return { revision: 'r1', outcomes: [{ inputIndex: 0, status: 'updated', record: records[0]! }] };
            },
            notifyUpdated: async () => {}, destroy: async () => {},
          };
        },
        async destroy() {},
      },
    });
    ctx.store.global.set('contestSession:BG5DRB:2026', { overrides: {} });

    await migrateWWDigiContestEntries(ctx as never);

    expect(records[0]!.contestEntry?.annotations?.status).toBe('review');
    expect(records[0]!.contestEntry?.received).toEqual({});
  });

  it('fails closed to review when a legacy sent exchange is not a four-character Maidenhead grid', async () => {
    const records = [record({ myGrid: 'BAD!' })];
    const ctx = createContext({
      logbookSessions: {
        async open(descriptor) {
          return {
            id: 'ww-digi-session', title: descriptor.title, callsign: 'BG5DRB',
            getLogBookId: async () => 'ww-digi-session', awaitReady: async () => {},
            queryQSOs: async () => structuredClone(records),
            readQsoSnapshot: async () => ({ revision: 'r0', records: structuredClone(records) }),
            countQSOs: async () => records.length, getStatistics: async () => null,
            addQSO: async (qso) => qso, updateQSO: async (_id, updates) => ({ ...records[0]!, ...updates }),
            async applyQsoBatch(mutations) {
              const mutation = mutations[0]!;
              if (mutation.type !== 'update') throw new Error('expected update');
              records[0] = { ...records[0]!, ...structuredClone(mutation.updates) };
              return { revision: 'r1', outcomes: [{ inputIndex: 0, status: 'updated', record: records[0]! }] };
            },
            notifyUpdated: async () => {}, destroy: async () => {},
          };
        },
        async destroy() {},
      },
    });
    ctx.store.global.set('contestSession:BG5DRB:2026', { overrides: {} });

    await migrateWWDigiContestEntries(ctx as never);

    expect(records[0]!.contestEntry?.annotations?.status).toBe('review');
    expect(records[0]!.contestEntry?.sent).toEqual({});
  });

  it('fails content verification when the written envelope is changed before the receipt is finalized', async () => {
    const records = [record()];
    let revision = 0;
    let targetWritten = false;
    const ctx = createContext({
      logbookSessions: {
        async open(descriptor) {
          return {
            id: 'ww-digi-session', title: descriptor.title, callsign: 'BG5DRB',
            getLogBookId: async () => 'ww-digi-session', awaitReady: async () => {},
            queryQSOs: async () => structuredClone(records),
            readQsoSnapshot: async () => {
              const snapshot = structuredClone(records);
              if (targetWritten && snapshot[0]?.contestEntry) {
                snapshot[0].contestEntry.received.grid = 'AA00';
              }
              return { revision: `r${revision}`, records: snapshot };
            },
            countQSOs: async () => records.length, getStatistics: async () => null,
            addQSO: async (qso) => qso, updateQSO: async (_id, updates) => ({ ...records[0]!, ...updates }),
            async applyQsoBatch(mutations) {
              const mutation = mutations[0]!;
              if (mutation.type !== 'update') throw new Error('expected update');
              records[0] = { ...records[0]!, ...structuredClone(mutation.updates) };
              targetWritten = true;
              revision += 1;
              return {
                revision: `r${revision}`,
                outcomes: [{ inputIndex: 0, status: 'updated', record: structuredClone(records[0]!) }],
              };
            },
            notifyUpdated: async () => {}, destroy: async () => {},
          };
        },
        async destroy() {},
      },
    });
    ctx.store.global.set('contestSession:BG5DRB:2026', { overrides: {} });

    await expect(migrateWWDigiContestEntries(ctx as never))
      .rejects.toThrow(/content hash mismatch/);

    const journal = await ctx.files.read('migration/ww-digi-contest-entry/BG5DRB-2026-journal.json');
    expect(JSON.parse(journal!.toString('utf8'))).toMatchObject({
      phase: 'target_written',
      sourceRecordCount: 1,
      targetRecordCount: 1,
      expectedTargetRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const receipt = JSON.parse(journal!.toString('utf8')) as {
      expectedTargetRecordHash: string;
      targetRecordHash: string;
    };
    expect(receipt.targetRecordHash).not.toBe(receipt.expectedTargetRecordHash);
  });
});
