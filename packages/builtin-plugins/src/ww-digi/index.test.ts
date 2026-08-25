import { describe, expect, it, vi } from 'vitest';
import type { QSORecord } from '@tx5dr/contracts';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import {
  wwDigiStrategyPlugin,
  wwDigiTestables,
} from './index.js';
import type { ContestQso } from './contest-log.js';

function qsoRecord(id: string, startTime: number, contestId = 'WW-DIGI'): QSORecord {
  return {
    id,
    callsign: 'JA1AAA',
    grid: 'PM95',
    frequency: 14_091_000,
    mode: 'FT8',
    startTime,
    messageHistory: [],
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    contestId,
  };
}

function contestQso(id: string, startTime: number): ContestQso {
  return {
    qsoId: id,
    callsign: 'JA1AAA',
    myCallsign: 'BG5DRB',
    sentGrid: 'OL32',
    receivedGrid: 'PM95',
    frequencyHz: 14_091_000,
    band: '20M',
    mode: 'FT8',
    startTime,
    status: 'included',
  };
}

function createContestContext(options: {
  contestYear?: number;
  logBookId?: string | null;
  records?: QSORecord[];
} = {}) {
  const queryQSOs = vi.fn(async () => options.records ?? []);
  const ctx = createMockContext({
    permissions: ['logbook:read', 'operator:transmit-control'] as const,
    callsign: 'BG5DRB',
    grid: 'OL32',
    config: {
      contestYear: options.contestYear ?? 2026,
      location: 'DX',
      categoryBand: 'ALL',
      categoryPower: 'LOW',
    },
    logbook: {
      forCallsign: () => ({
        callsign: 'BG5DRB',
        getLogBookId: async () => options.logBookId === undefined ? 'logbook-BG5DRB' : options.logBookId,
        queryQSOs,
        readQsoSnapshot: async () => ({ revision: 'revision-1', records: [] }),
        countQSOs: async () => 0,
        getStatistics: async () => null,
        addQSO: async (record: QSORecord) => record,
        updateQSO: async (_id: string, updates: Partial<QSORecord>) => qsoRecord('updated', 0, updates.contestId),
        applyQsoBatch: async () => ({ revision: 'revision-1', outcomes: [] }),
        notifyUpdated: async () => {},
      }),
    },
  });
  return { ctx, queryQSOs };
}

describe('WW Digi contest edition persistence', () => {
  it('reconciles only the selected edition into year-scoped ledger and health keys', async () => {
    const in2026 = qsoRecord('qso-2026', Date.UTC(2026, 7, 29, 12, 0));
    const in2025 = qsoRecord('qso-2025', Date.UTC(2025, 7, 30, 12, 0));
    const nonContest = qsoRecord('not-ww-digi', Date.UTC(2026, 7, 29, 12, 1), 'OTHER');
    const { ctx, queryQSOs } = createContestContext({ records: [in2025, in2026, nonContest] });
    ctx.store.operator.set(
      wwDigiTestables.ledgerKey(2025),
      [contestQso('retained-2025', Date.UTC(2025, 7, 30, 12))],
    );

    await expect(wwDigiTestables.reconcileLedger(ctx, 2026)).resolves.toEqual({ imported: 1, total: 1 });

    expect(queryQSOs).toHaveBeenCalledWith(expect.objectContaining({
      orderDirection: 'asc',
      limit: 5_000,
      offset: 0,
      timeRange: {
        start: Date.UTC(2026, 7, 29, 12),
        end: Date.UTC(2026, 7, 30, 12) - 1,
      },
    }));
    expect(ctx.store.operator.get<ContestQso[]>(wwDigiTestables.ledgerKey(2026)))
      .toEqual([expect.objectContaining({ qsoId: 'qso-2026' })]);
    expect(ctx.store.operator.get<ContestQso[]>(wwDigiTestables.ledgerKey(2025)))
      .toEqual([expect.objectContaining({ qsoId: 'retained-2025' })]);
    expect(ctx.store.operator.get(wwDigiTestables.healthKey(2026)))
      .toEqual(expect.objectContaining({ state: 'healthy' }));
  });

  it('marks an unavailable logbook degraded and refuses Cabrillo rendering', async () => {
    const { ctx } = createContestContext({ logBookId: null });

    await expect(wwDigiTestables.reconcileLedgerWithHealth(ctx, 2026))
      .rejects.toThrow(/logbook is unavailable/);
    expect(ctx.store.operator.get(wwDigiTestables.healthKey(2026)))
      .toEqual(expect.objectContaining({ state: 'degraded' }));
    expect(() => wwDigiTestables.renderCabrillo(ctx, 2026))
      .toThrow(/reconcile it before download/);
  });

  it('projects live completions only into the configured contest year', async () => {
    const { ctx } = createContestContext();
    const hook = wwDigiStrategyPlugin.hooks?.onQSOComplete;
    expect(hook).toBeTypeOf('function');

    await hook!(qsoRecord('qso-2025', Date.UTC(2025, 7, 30, 12)), ctx);
    expect(ctx.store.operator.get(wwDigiTestables.ledgerKey(2026), [])).toEqual([]);

    await hook!(qsoRecord('qso-2026', Date.UTC(2026, 7, 29, 12)), ctx);
    expect(ctx.store.operator.get<ContestQso[]>(wwDigiTestables.ledgerKey(2026)))
      .toEqual([expect.objectContaining({ qsoId: 'qso-2026' })]);
    expect(ctx.store.operator.get(wwDigiTestables.ledgerKey(2025))).toBeUndefined();
  });

  it('defaults the setting to the current UTC year with bounded input', () => {
    const descriptor = wwDigiStrategyPlugin.settings?.contestYear;
    expect(descriptor).toMatchObject({
      type: 'number',
      default: new Date().getUTCFullYear(),
      min: 2019,
      max: 2100,
    });
  });

  it('defaults DX locations while requiring an explicit US or Canadian section', () => {
    expect(wwDigiTestables.resolveContestLocation('BG5DRB', '')).toBe('DX');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', '')).toBe('');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', 'DX')).toBe('');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', 'EMA')).toBe('EMA');
    expect(wwDigiTestables.resolveContestLocation('VE3ABC', 'ON')).toBe('ON');
  });
});
