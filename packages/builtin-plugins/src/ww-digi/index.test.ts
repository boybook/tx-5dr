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
    permissions: ['logbook:read', 'operator:transmit-control', 'plugin:event-bus'] as const,
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
  it('reconciles all eligible FT4/FT8 records into a shared callsign/year session', async () => {
    const in2026 = qsoRecord('qso-2026', Date.UTC(2026, 7, 29, 12, 0));
    const in2025 = qsoRecord('qso-2025', Date.UTC(2025, 7, 30, 12, 0));
    const nonContest = qsoRecord('not-ww-digi', Date.UTC(2026, 7, 29, 12, 1), 'OTHER');
    const { ctx, queryQSOs } = createContestContext({ records: [in2025, in2026, nonContest] });
    ctx.store.operator.set(
      wwDigiTestables.ledgerKey(2025),
      [contestQso('retained-2025', Date.UTC(2025, 7, 30, 12))],
    );

    await expect(wwDigiTestables.reconcileLedger(ctx, 2026)).resolves.toEqual({ imported: 1, total: 2 });

    expect(queryQSOs).toHaveBeenCalledWith(expect.objectContaining({
      orderDirection: 'asc',
      limit: 5_000,
      offset: 0,
      timeRange: {
        start: Date.UTC(2026, 7, 29, 12),
        end: Date.UTC(2026, 7, 30, 12) - 1,
      },
    }));
    expect(await wwDigiTestables.readContestRecords(ctx, 2026))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ qsoId: 'qso-2026', source: 'ww-digi' }),
        expect.objectContaining({ qsoId: 'not-ww-digi', source: 'reconciled' }),
      ]));
    expect(ctx.store.operator.get<ContestQso[]>(wwDigiTestables.ledgerKey(2025)))
      .toEqual([expect.objectContaining({ qsoId: 'retained-2025' })]);
    expect(ctx.store.global.get<{ health?: { state?: string } }>(wwDigiTestables.sessionKey('BG5DRB', 2026))?.health)
      .toEqual(expect.objectContaining({ state: 'healthy' }));
  });

  it('marks an unavailable logbook degraded and refuses Cabrillo rendering', async () => {
    const { ctx } = createContestContext({ logBookId: null });

    await expect(wwDigiTestables.reconcileLedgerWithHealth(ctx, 2026))
      .rejects.toThrow(/logbook is unavailable/);
    expect(ctx.store.global.get<{ health?: { state?: string } }>(wwDigiTestables.sessionKey('BG5DRB', 2026))?.health)
      .toEqual(expect.objectContaining({ state: 'degraded' }));
    await expect(wwDigiTestables.renderCabrillo(ctx, 2026))
      .rejects.toThrow(/reconcile it before download/);
  });

  it('migrates a schema v1 session to an unconfirmed v2 session without losing overrides', async () => {
    const record = qsoRecord('legacy-qso', Date.UTC(2026, 7, 29, 12));
    const { ctx } = createContestContext({ records: [record] });
    const key = wwDigiTestables.sessionKey('BG5DRB', 2026);
    ctx.store.global.set(key, {
      schemaVersion: 1,
      revision: 7,
      config: {
        callsign: 'BG5DRB', location: 'DX', categoryBand: 'ALL', categoryPower: 'LOW',
        categoryOperator: 'SINGLE-OP', categoryTransmitter: 'ONE', operators: [], createdBy: 'legacy',
      },
      overrides: { 'legacy-qso': { status: 'x-qso', operatorId: 'operator-0' } },
      operatorTransmitters: {}, migratedOperators: {}, health: { state: 'healthy' },
    });

    await wwDigiTestables.reconcileLedger(ctx, 2026);
    expect(ctx.store.global.get<Record<string, unknown>>(key)).toMatchObject({
      schemaVersion: 2,
      setup: { status: 'unconfirmed' },
      overrides: { 'legacy-qso': { status: 'x-qso', operatorId: 'operator-0' } },
      operatingIndex: { workedByBand: {} },
    });
  });

  it('records per-operator metadata in the shared session for the QSO year', async () => {
    const { ctx } = createContestContext();
    const hook = wwDigiStrategyPlugin.hooks?.onQSOComplete;
    expect(hook).toBeTypeOf('function');

    await hook!(qsoRecord('qso-2025', Date.UTC(2025, 7, 30, 12)), ctx);
    expect(ctx.store.global.get<{ overrides?: Record<string, unknown> }>(wwDigiTestables.sessionKey('BG5DRB', 2025))?.overrides)
      .toEqual(expect.objectContaining({ 'qso-2025': expect.objectContaining({ operatorId: 'operator-0' }) }));

    await hook!(qsoRecord('qso-2026', Date.UTC(2026, 7, 29, 12)), ctx);
    expect(ctx.store.global.get<{ overrides?: Record<string, unknown> }>(wwDigiTestables.sessionKey('BG5DRB', 2026))?.overrides)
      .toEqual(expect.objectContaining({ 'qso-2026': expect.objectContaining({ operatorId: 'operator-0', transmitterId: 0 }) }));
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

  it('defaults to one active QSO while allowing up to three', () => {
    expect(wwDigiStrategyPlugin.settings?.parallelStreams).toMatchObject({
      type: 'number',
      default: 1,
      min: 1,
      max: 3,
    });
  });

  it('opens the contest log through an operator-bound standalone page entry', () => {
    expect(wwDigiStrategyPlugin.panels).toContainEqual(expect.objectContaining({
      id: 'contest-log',
      slot: 'operator-action',
      openMode: 'page',
    }));
    expect(wwDigiStrategyPlugin.ui?.pages).toContainEqual(expect.objectContaining({
      id: 'contest-log',
      accessScope: 'operator',
      resourceBinding: 'operator',
    }));
  });

  it('defaults DX locations while requiring an explicit US or Canadian section', () => {
    expect(wwDigiTestables.resolveContestLocation('BG5DRB', '')).toBe('DX');
    expect(wwDigiTestables.resolveContestLocation('BG5DRB', 'EMA')).toBe('DX');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', '')).toBe('');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', 'DX')).toBe('');
    expect(wwDigiTestables.resolveContestLocation('K1ABC', 'EMA')).toBe('EMA');
    expect(wwDigiTestables.resolveContestLocation('VE3ABC', 'ON')).toBe('ON');
  });

  it('validates Cabrillo location semantics against the entrant callsign', () => {
    const { ctx } = createContestContext();
    const config = {
      callsign: 'BG5DRB', location: 'DX', categoryBand: 'ALL' as const, categoryPower: 'LOW' as const,
      categoryOperator: 'SINGLE-OP' as const, categoryTransmitter: 'ONE' as const, operators: [], createdBy: 'test',
    };
    expect(wwDigiTestables.requiresContestSection('BG5DRB')).toBe(false);
    expect(wwDigiTestables.validateSessionConfig(ctx, config).location).toBe('DX');
    expect(() => wwDigiTestables.validateSessionConfig(ctx, { ...config, location: 'EMA' })).toThrow(/must be DX/);

    const us = createMockContext({ callsign: 'K1ABC', grid: 'FN42' });
    expect(wwDigiTestables.requiresContestSection('K1ABC')).toBe(true);
    expect(() => wwDigiTestables.validateSessionConfig(us, { ...config, callsign: 'K1ABC', location: 'DX' }))
      .toThrow(/ARRL\/RAC section/);
  });

  it('builds one worked identity per callsign and band across FT4 and FT8', () => {
    const records: ContestQso[] = [
      contestQso('ft8', Date.UTC(2026, 7, 29, 12)),
      { ...contestQso('ft4', Date.UTC(2026, 7, 29, 12, 1)), mode: 'FT4' },
      { ...contestQso('review', Date.UTC(2026, 7, 29, 12, 2)), callsign: 'K1ABC', band: '40M', frequencyHz: 7_091_000, status: 'review' },
      { ...contestQso('excluded', Date.UTC(2026, 7, 29, 12, 3)), callsign: 'ZS6AAA', status: 'x-qso' },
    ];
    expect(wwDigiTestables.buildOperatingIndex('BG5DRB', 2026, records, 4)).toMatchObject({
      revision: 4,
      workedByBand: {
        '20M': ['JA1AAA'],
        '40M': ['K1ABC'],
      },
      workedFieldsByBand: {
        '20M': ['PM'],
        '40M': ['PM'],
      },
    });
  });

  it('projects contest worked state and gates transmission until settings are confirmed', () => {
    const { ctx } = createContestContext();
    const config = {
      callsign: 'BG5DRB', location: 'DX', categoryBand: 'ALL' as const, categoryPower: 'LOW' as const,
      categoryOperator: 'SINGLE-OP' as const, categoryTransmitter: 'ONE' as const, operators: [], createdBy: 'test',
    };
    const key = wwDigiTestables.sessionKey('BG5DRB', 2026);
    const base = {
      schemaVersion: 2 as const,
      revision: 0,
      config,
      overrides: {},
      operatorTransmitters: {},
      migratedOperators: {},
      health: { state: 'healthy' as const },
      setup: { status: 'unconfirmed' as const },
      operatingIndex: {
        revision: 3,
        contestYear: 2026,
        callsign: 'BG5DRB',
        workedByBand: { '20M': ['JA1AAA'] },
        workedFieldsByBand: { '20M': ['PM'] },
      },
    };
    ctx.store.global.set(key, base);
    const presentation = wwDigiTestables.runtimePresentation(ctx as never);
    expect(presentation).toMatchObject({
      transmitGate: { allowed: false, reason: 'transmitBlockedSetupUnconfirmed' },
      messagePresentation: {
        revision: 3,
        classes: {
          'contest-new-call': {
            emphasisWhen: expect.arrayContaining([
              { firstTokenIn: ['CQ'] },
              { anyTokenIn: ['RR73', 'RRR', '73'] },
            ]),
          },
          'contest-new-field': {
            emphasisWhen: expect.arrayContaining([
              { firstTokenIn: ['CQ'] },
              { anyTokenIn: ['RR73', 'RRR', '73'] },
            ]),
          },
        },
        assignments: [{ subject: 'JA1AAA', partition: '20M', classId: 'contest-worked' }],
        noveltyRules: [{
          fact: 'grid-field-2',
          knownValuesByPartition: { '20M': ['PM'] },
          classId: 'contest-new-field',
        }],
      },
    });
    expect(presentation.messagePresentation?.tagRules).toBeUndefined();

    ctx.store.global.set(key, {
      ...base,
      setup: {
        status: 'confirmed',
        fingerprint: wwDigiTestables.sessionFingerprint(ctx, 2026, config),
      },
    });
    expect(wwDigiTestables.runtimePresentation(ctx as never).transmitGate).toBeUndefined();

    const changedGrid = createMockContext({
      callsign: 'BG5DRB', grid: 'PM00', config: ctx.config,
      store: { global: ctx.store.global },
    });
    expect(wwDigiTestables.runtimePresentation(changedGrid as never).transmitGate)
      .toMatchObject({ reason: 'transmitBlockedSetupUnconfirmed' });
  });
});
