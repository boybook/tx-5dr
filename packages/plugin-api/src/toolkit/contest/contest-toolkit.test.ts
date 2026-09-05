import { describe, expect, it } from 'vitest';
import type { QSORecord } from '@tx5dr/contracts';
import {
  createMockContext,
  createMockEventBus,
  createMockKVStore,
  createMockLogbookAccess,
} from '../../testing/index.js';
import { buildCabrilloDocument } from './CabrilloBuilder.js';
import { ContestSessionRepository } from './ContestSessionRepository.js';
import {
  defineFT8Contest,
  fixedWeekendEdition,
  formatFT8ContestSubmission,
  projectFT8ContestQsos,
} from './FT8ContestDefinition.js';
import {
  cabrilloSubmission,
  defineCompletionModule,
  defineFT8ExchangeModule,
  distancePoints,
  fixedPoints,
  gridAndSnrExchange,
  gridExchange,
  gridFieldMultiplier,
  maidenheadDistanceKm,
  nextContestSerial,
  multiplierKeysFrom,
  oncePerBand,
  scoreBy,
  requireExchangeAndFinalAck,
  type FT8ContestQso,
  type GridExchange,
} from './FT8ContestModules.js';
import { composeFT8ContestPlugin, defineContestSessionModule } from './FT8ContestPlugin.js';
import { createFT8ContestTestKit } from './FT8ContestTestKit.js';
import type { StrategyPluginContext } from '../../context.js';
import type { StrategyRuntime } from '../../runtime.js';
import {
  CONTEST_SESSION_PERMISSIONS,
  defaultContestSession,
} from './DefaultContestSession.js';
import { defaultContestWorkbench } from './DefaultContestWorkbench.js';
import { CONTEST_WORKBENCH_ACTIONS } from './DefaultContestWorkbench.js';
import { createContestQsoEnvelopeAdapter } from './ContestQsoEnvelopeAdapter.js';
import {
  CONTEST_LOGBOOK_PERMISSIONS,
  defaultContestLogbook,
  standardFT8ContestLogbook,
  type ContestLogbookAdapter,
  type ContestLogbookReviewIssue,
} from './ContestLogbook.js';
import type {
  PluginLogbookSessionAccess,
  PluginLogbookSessionDescriptor,
  PluginLogbookSessions,
  PluginUIHandler,
  PluginUIRequestContext,
} from '../../helpers.js';

interface ExampleQso extends FT8ContestQso<GridExchange> {
  frequencyKhz: number;
  at: string;
}

function createExampleContest() {
  return defineFT8Contest<GridExchange, ExampleQso>({
    id: 'example-ft8',
    rulesetVersion: '2026.1',
    edition: fixedWeekendEdition({
      id: '2026',
      startAt: '2026-08-29T00:00:00Z',
      endAt: '2026-08-30T00:00:00Z',
      source: { url: 'https://example.test/rules', confirmedAt: '2026-08-01T00:00:00Z' },
    }),
    bands: ['20m', '40m'],
    exchange: gridExchange(),
    completion: requireExchangeAndFinalAck(),
    dupe: oncePerBand(),
    scoring: distancePoints<ExampleQso>({
      stepKm: 3000,
      multiplierKeys: gridFieldMultiplier({
        grid: (qso) => qso.receivedExchange?.grid,
        band: (qso) => qso.band,
      }),
    }),
    submission: cabrilloSubmission<ExampleQso>({
      headers: () => [['CONTEST', 'EXAMPLE-FT8']],
      qsoLine: (qso) => `QSO: ${qso.frequencyKhz} DG ${qso.at} ${qso.callsign}`,
    }),
  });
}

describe('contest toolkit', () => {
  it('serializes shared session updates inside one Host process', () => {
    const store = createMockKVStore();
    const create = () => ({ schemaVersion: 1, revision: 0, ids: [] as string[] });
    const first = new ContestSessionRepository(store, 'session', create);
    const second = new ContestSessionRepository(store, 'session', create);
    first.update((session) => ({ ...session, ids: [...session.ids, 'a'] }));
    second.update((session) => ({ ...session, ids: [...session.ids, 'b'] }));
    expect(first.read()).toEqual({ schemaVersion: 1, revision: 2, ids: ['a', 'b'] });
  });

  it('builds deterministic Cabrillo with CRLF endings', () => {
    expect(buildCabrilloDocument({
      headers: [['CONTEST', 'EXAMPLE']],
      qsoLines: ['QSO: 14000 DG 2026-01-01 0000 A A B B 0'],
    })).toBe('START-OF-LOG: 3.0\r\nCONTEST: EXAMPLE\r\nQSO: 14000 DG 2026-01-01 0000 A A B B 0\r\nEND-OF-LOG:\r\n');
  });

  it('composes safe FT8 defaults while keeping modules replaceable', () => {
    const contest = createExampleContest();
    expect(contest.modes).toEqual(['FT8']);
    expect(contest.bands).toEqual(['20M', '40M']);
    expect(contest.operating).toEqual({
      humanInitiation: 'required',
      maxConcurrentQsos: 1,
      maxSimultaneousSignals: 1,
      cycleRelation: 'single',
    });
    expect(contest.exchange.id).toBe('grid-4');
    expect(contest.dupe.id).toBe('callsign-band');
  });

  it('snapshots contest identity and rule modules against caller mutation', () => {
    const edition = {
      id: 'mutable-edition',
      startAt: '2026-08-29T00:00:00Z',
      endAt: '2026-08-30T00:00:00Z',
      source: { url: 'https://example.test/original' },
    };
    const grid = gridExchange();
    const exchange = {
      id: 'mutable-exchange',
      decode: grid.decode,
      encode: grid.encode,
      validate: grid.validate,
    };
    const contest = defineFT8Contest({
      id: 'immutable-contest',
      rulesetVersion: '2026.1',
      edition,
      bands: ['20M'],
      exchange,
      completion: requireExchangeAndFinalAck(),
      scoring: distancePoints({ stepKm: 3000 }),
      submission: cabrilloSubmission({
        headers: () => [['CONTEST', 'IMMUTABLE']],
        qsoLine: (qso) => `QSO: ${qso.callsign}`,
      }),
    });

    edition.id = 'changed-edition';
    edition.source.url = 'https://example.test/changed';
    exchange.id = 'changed-exchange';

    expect(contest.edition).toMatchObject({
      id: 'mutable-edition',
      source: { url: 'https://example.test/original' },
    });
    expect(contest.exchange.id).toBe('mutable-exchange');
    expect(Object.isFrozen(contest.edition)).toBe(true);
    expect(Object.isFrozen(contest.edition.source)).toBe(true);
    expect(Object.isFrozen(contest.exchange)).toBe(true);
  });

  it('rejects operating limits above the Host stream ceiling', () => {
    const contest = createExampleContest();
    const input = {
      id: 'too-many-streams',
      rulesetVersion: contest.rulesetVersion,
      edition: contest.edition,
      bands: contest.bands,
      exchange: contest.exchange,
      completion: contest.completion,
      scoring: contest.scoring,
      submission: contest.submission,
    };
    expect(() => defineFT8Contest({
      ...input,
      operating: { maxConcurrentQsos: 6 },
    })).toThrow('contest_operating_invalid_concurrent_qsos');
    expect(() => defineFT8Contest({
      ...input,
      operating: { maxConcurrentQsos: 5, maxSimultaneousSignals: 6 },
    })).toThrow('contest_operating_invalid_simultaneous_signals');
  });

  it('maps operating safety into Host strategy capabilities and rejects contradictions', () => {
    const contest = createExampleContest();
    const plugin = composeFT8ContestPlugin({
      name: 'safe-defaults',
      version: '1.0.0',
      contest,
      runtime: () => ({}) as StrategyRuntime,
    });
    expect(plugin.minPluginApiVersion).toBe('2.5.0');
    expect(() => plugin.createStrategyRuntime?.({
      ...(createMockContext() as unknown as StrategyPluginContext),
      pluginApiVersion: '2.0.0',
    })).toThrow('PLUGIN_API_VERSION_UNSUPPORTED');
    expect(plugin.strategyFeatures).toMatchObject({
      manualInitiation: 1,
      maxConcurrentStreams: 1,
      maxSimultaneousSignals: 1,
    });
    expect(() => composeFT8ContestPlugin({
      name: 'unsafe-override',
      version: '1.0.0',
      contest,
      strategyFeatures: { maxConcurrentStreams: 2 },
      runtime: () => ({}) as StrategyRuntime,
    })).toThrow('contest_operating_strategy_feature_conflict:maxConcurrentStreams');

    const singleQueue = composeFT8ContestPlugin({
      name: 'single-queue',
      version: '1.0.0',
      contest,
      strategyFeatures: { targetQueue: 1, queueActivation: 'operator-toggle' },
      runtime: () => ({}) as StrategyRuntime,
    });
    expect(singleQueue.strategyFeatures).toMatchObject({
      targetQueue: 1,
      queueActivation: 'operator-toggle',
      maxConcurrentStreams: 1,
    });
    expect(() => singleQueue.createStrategyRuntime?.(
      createMockContext() as unknown as StrategyPluginContext,
    )).toThrow('contest_runtime_target_queue_requires_queued_strategy');

    const parallelContest = defineFT8Contest<GridExchange, ExampleQso>({
      id: 'parallel-contest',
      rulesetVersion: contest.rulesetVersion,
      edition: contest.edition,
      bands: contest.bands,
      exchange: contest.exchange,
      completion: contest.completion,
      dupe: contest.dupe,
      scoring: contest.scoring,
      submission: contest.submission,
      operating: { maxConcurrentQsos: 2, maxSimultaneousSignals: 1 },
    });
    const queuedWithoutParallel = {
      observeDecodedMessages() { return false; },
      enqueueTarget() { return {} as never; },
      reorderTarget() { return {} as never; },
      removeTarget() { return {} as never; },
      getQueueSnapshot() { return {} as never; },
    } as unknown as StrategyRuntime;
    const parallelPlugin = composeFT8ContestPlugin({
      name: 'parallel-queue',
      version: '1.0.0',
      contest: parallelContest,
      runtime: () => queuedWithoutParallel,
    });
    expect(parallelPlugin.strategyFeatures).toMatchObject({
      targetQueue: 1,
      parallelTargetQueue: 1,
      maxConcurrentStreams: 2,
    });
    expect(() => parallelPlugin.createStrategyRuntime?.(
      createMockContext() as unknown as StrategyPluginContext,
    )).toThrow('contest_runtime_parallel_queue_requires_parallel_runtime');
  });

  it('infers the quickstart definition without generic annotations', () => {
    const contest = defineFT8Contest({
      id: 'quickstart',
      rulesetVersion: '2026.1',
      edition: fixedWeekendEdition({
        id: '2026',
        startAt: '2026-08-29T00:00:00Z',
        endAt: '2026-08-30T00:00:00Z',
      }),
      bands: ['20M'],
      exchange: gridExchange(),
      completion: requireExchangeAndFinalAck(),
      scoring: distancePoints({ stepKm: 3000 }),
      submission: cabrilloSubmission({
        headers: () => [['CONTEST', 'QUICKSTART']],
        qsoLine: (qso) => `QSO: ${qso.callsign}`,
      }),
    });
    expect(contest.id).toBe('quickstart');
  });

  it('covers exchange, completion, dupe, scoring and submission golden paths', () => {
    const contest = createExampleContest();
    const kit = createFT8ContestTestKit(contest);
    const first: ExampleQso = {
      callsign: 'w1aw',
      band: '20m',
      mode: 'FT8',
      startTime: Date.parse('2026-08-29T00:00:00Z'),
      receivedExchange: { grid: 'FN31' },
      distanceKm: 5541,
      frequencyKhz: 14074,
      at: '2026-08-29 0000',
    };
    const dupe = { ...first, callsign: 'W1AW', distanceKm: 9000 };

    kit.exchange({ grid: 'fn31' }, { grid: 'FN31' }, { grid: 'FN31' });
    kit.invalidExchange({ grid: 'ZZ99' }, 'invalid_grid');
    kit.completion({
      sentExchange: { grid: 'PL04' },
      receivedExchange: { grid: 'FN31' },
      receivedFinalAck: true,
    }, true);
    kit.dupe(first, dupe);
    kit.score([first, dupe], {
      qsoCount: 1,
      qsoPoints: 2,
      multiplierCount: 1,
      total: 2,
    });
    kit.submission(
      [first],
      undefined,
      'START-OF-LOG: 3.0\r\nCONTEST: EXAMPLE-FT8\r\nQSO: 14074 DG 2026-08-29 0000 w1aw\r\nEND-OF-LOG:\r\n',
    );
  });

  it('applies edition, mode, band, review and dupe rules before score or export', () => {
    const contest = createExampleContest();
    const first: ExampleQso = {
      callsign: 'K1ABC', band: '20M', mode: 'FT8',
      startTime: Date.parse('2026-08-29T01:00:00Z'),
      distanceKm: 1_000, receivedExchange: { grid: 'FN31' },
      frequencyKhz: 14_074, at: '2026-08-29 0100',
    };
    const rows = projectFT8ContestQsos(contest, [
      first,
      { ...first, callsign: 'K2OUT', startTime: Date.parse('2026-08-30T01:00:00Z') },
      { ...first, callsign: 'K3MODE', mode: 'FT4' },
      { ...first, callsign: 'K4BAND', band: '6M' },
      { ...first, callsign: 'K5REVIEW', status: 'review' },
      { ...first, callsign: 'K6XQSO', status: 'x-qso' },
      { ...first, startTime: first.startTime + 1_000 },
    ]);

    expect(rows.map((row) => ({ callsign: row.qso.callsign, eligible: row.eligible, issues: row.issues })))
      .toEqual([
        { callsign: 'K1ABC', eligible: true, issues: [] },
        { callsign: 'K3MODE', eligible: false, issues: ['unsupported_mode'] },
        { callsign: 'K4BAND', eligible: false, issues: ['unsupported_band'] },
        { callsign: 'K5REVIEW', eligible: false, issues: ['review'] },
        { callsign: 'K6XQSO', eligible: false, issues: ['x_qso'] },
        { callsign: 'K1ABC', eligible: false, issues: ['dupe'] },
        { callsign: 'K2OUT', eligible: false, issues: ['outside_edition'] },
      ]);
    expect(rows.find((row) => row.qso.callsign === 'K6XQSO')?.submissionEligible).toBe(true);
    expect(rows.find((row) => row.dupe)?.submissionEligible).toBe(true);
    expect(formatFT8ContestSubmission(
      contest,
      [first, { ...first, startTime: first.startTime + 1 }],
      undefined,
    ).match(/^QSO:/gm) ?? []).toHaveLength(2);
  });

  it('creates and validates typed contest QSO envelopes with frozen identity', () => {
    const contest = createExampleContest();
    const adapter = createContestQsoEnvelopeAdapter(contest);
    const envelope = adapter.create({
      sent: { grid: 'pl04' },
      received: { grid: 'fn31' },
      annotations: { status: 'review', transmitterId: 1 },
    });

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      contestId: contest.id,
      editionId: contest.edition.id,
      rulesetVersion: contest.rulesetVersion,
      sent: { grid: 'PL04' },
      received: { grid: 'FN31' },
    });
    expect(adapter.validate(envelope)).toEqual({
      ok: true,
      envelope,
      facts: {
        sent: { grid: 'PL04' },
        received: { grid: 'FN31' },
        annotations: { status: 'review', transmitterId: 1 },
      },
    });
    expect(adapter.validate({ ...envelope, rulesetVersion: '2026.2' })).toMatchObject({
      ok: false,
      code: 'contest_qso_envelope_identity_mismatch',
    });
  });

  it('supports the ARRL distance rounding vector without multipliers', () => {
    const scoring = distancePoints<FT8ContestQso>({
      stepKm: 500,
      rounding: 'ceil',
      minimumDistanceSteps: 1,
    });
    const arrl = defineFT8Contest({
      id: 'arrl-digital',
      rulesetVersion: '2026.1',
      edition: fixedWeekendEdition({
        id: '2026',
        startAt: '2026-06-06T00:00:00Z',
        endAt: '2026-06-07T06:00:00Z',
      }),
      modes: ['FT8'],
      bands: ['160M', '80M', '40M', '20M', '15M', '10M', '6M'],
      exchange: gridExchange(),
      completion: requireExchangeAndFinalAck(),
      scoring,
      submission: cabrilloSubmission({
        headers: () => [['CONTEST', 'ARRL-DIGITAL']],
        qsoLine: (qso) => `QSO: ${qso.callsign}`,
      }),
    });
    const qso: FT8ContestQso = {
      callsign: 'K1ABC',
      band: '6M',
      mode: 'FT8',
      startTime: Date.parse('2026-06-06T00:00:00Z'),
      distanceKm: 1565,
    };
    createFT8ContestTestKit(arrl).score([qso], {
      qsoCount: 1,
      qsoPoints: 5,
      multiplierCount: 0,
      total: 5,
    });
    expect(scoring.score({
      callsign: 'K2DEF',
      band: '6M',
      mode: 'FT8',
      startTime: Date.parse('2026-06-06T00:01:00Z'),
      distanceKm: 0,
    }).points).toBe(2);
  });

  it('assembles fixed-point and zero-point multiplier contests from shared helpers', () => {
    type SprintQso = FT8ContestQso<{ grid: string }>;
    const sprintScoring = fixedPoints<SprintQso>(1, {
      multiplierKeys: gridFieldMultiplier({
        grid: (qso) => qso.receivedExchange?.grid,
        band: (qso) => qso.band,
      }),
    });
    const sprintRows: SprintQso[] = [
      {
        callsign: 'K1ABC',
        band: '20M',
        mode: 'FT4',
        startTime: Date.now(),
        receivedExchange: { grid: 'FN31' },
      },
      {
        callsign: 'K2DEF',
        band: '20M',
        mode: 'FT4',
        startTime: Date.now(),
        receivedExchange: { grid: 'FN31' },
      },
    ];
    const sprintSummary = sprintScoring.aggregate(
      sprintRows.map((qso) => sprintScoring.score(qso)),
    );
    expect(sprintSummary).toMatchObject({
      qsoCount: 2,
      qsoPoints: 2,
      multiplierCount: 1,
      total: 2,
    });

    type BataviaQso = FT8ContestQso & {
      prefix: string;
      dxcc: string;
      ybMember: boolean;
      sameCountry: boolean;
    };
    const bataviaScoring = scoreBy<BataviaQso>({
      id: 'batavia-like',
      points(qso) {
        if (qso.ybMember) return qso.sameCountry ? 5 : 5;
        if (qso.sameCountry) return 0;
        return qso.dxcc === 'YB' ? 2 : 1;
      },
      eligible: () => true,
      multiplierKeys: multiplierKeysFrom({
        key: (qso: BataviaQso) => qso.prefix,
        band: (qso) => qso.band,
      }),
    });
    const bataviaSummary = bataviaScoring.aggregate([
      bataviaScoring.score({
        callsign: 'YB1AAA',
        band: '20M',
        mode: 'FT8',
        startTime: Date.now(),
        prefix: 'YB',
        dxcc: 'YB',
        ybMember: true,
        sameCountry: true,
      }),
      bataviaScoring.score({
        callsign: 'K1ABC',
        band: '20M',
        mode: 'FT8',
        startTime: Date.now(),
        prefix: 'K',
        dxcc: 'K',
        ybMember: false,
        sameCountry: true,
      }),
    ]);
    expect(bataviaSummary).toMatchObject({
      qsoCount: 2,
      qsoPoints: 5,
      multiplierCount: 2,
      total: 10,
    });
  });

  it('covers FT Challenge Grid, SNR, ZZ00 and completion rules', () => {
    type ChallengeQso = FT8ContestQso<{ grid: string; snr: number }>;
    const exchange = gridAndSnrExchange({ missingGrid: 'ZZ00' });
    const scoring = distancePoints<ChallengeQso>({
      stepKm: 3000,
      missingDistancePoints: 1,
      multiplierKeys: gridFieldMultiplier({
        grid: (qso) => qso.receivedExchange?.grid,
        band: (qso) => qso.band,
      }),
    });
    const challenge = defineFT8Contest({
      id: 'ft-challenge',
      rulesetVersion: '2026.1',
      edition: fixedWeekendEdition({
        id: '2026',
        startAt: '2026-12-05T00:00:00Z',
        endAt: '2026-12-06T06:00:00Z',
      }),
      modes: ['FT4', 'FT8'],
      bands: ['80M', '40M', '20M', '15M', '10M'],
      exchange,
      completion: requireExchangeAndFinalAck(),
      scoring,
      submission: cabrilloSubmission<ChallengeQso>({
        headers: () => [['CONTEST', 'FT-CHALLENGE']],
        qsoLine: (qso) => `QSO: ${qso.callsign}`,
      }),
    });
    const kit = createFT8ContestTestKit(challenge);
    kit.exchange({ grid: 'ZZ00', snr: '-12' }, { grid: 'ZZ00', snr: -12 });
    const missingGrid = scoring.score({
      callsign: 'N0CALL',
      band: '20M',
      mode: 'FT8',
      startTime: Date.parse('2026-12-05T01:00:00Z'),
      receivedExchange: { grid: 'ZZ00', snr: -12 },
    });
    expect(missingGrid).toMatchObject({ points: 1, multiplierKeys: [] });
    expect(challenge.completion.evaluate({
      sentExchange: { grid: 'PL04', snr: -5 },
      receivedExchange: { grid: 'ZZ00', snr: -12 },
      sentFinalAck: true,
    }).complete).toBe(true);
  });

  it('covers the FT Roundup report, regional exchange and snapshot-based serial vector', () => {
    type RegionalExchange =
      | { kind: 'region'; report: string; value: string }
      | { kind: 'serial'; report: string; value: string };
    const exchange = defineFT8ExchangeModule<RegionalExchange>({
      id: 'region-or-serial',
      decode(fields) {
        const report = fields.report?.trim();
        if (!report || !/^[+-]\d{2}$/.test(report)) {
          return { ok: false, issues: [{ code: 'report_required', field: 'report' }] };
        }
        const region = fields.region?.trim().toUpperCase();
        if (region && /^[A-Z]{2,3}$/.test(region)) {
          return { ok: true, value: { kind: 'region', report, value: region } };
        }
        const serial = fields.serial?.trim();
        if (serial && /^[0-9]{3,4}$/.test(serial)) {
          return { ok: true, value: { kind: 'serial', report, value: serial } };
        }
        return { ok: false, issues: [{ code: 'region_or_serial_required' }] };
      },
      encode(value): Readonly<Record<string, string>> {
        if (value.kind === 'region') return { report: value.report, region: value.value };
        return { report: value.report, serial: value.value };
      },
      validate(value) {
        const valid = value.kind === 'region'
          ? /^[A-Z]{2,3}$/.test(value.value)
          : /^[0-9]{3,4}$/.test(value.value);
        return valid ? [] : [{ code: 'region_or_serial_invalid' }];
      },
    });
    const completion = defineCompletionModule<RegionalExchange>({
      id: 'received-exchange',
      evaluate(evidence) {
        return evidence.receivedExchange
          ? { complete: true, missing: [] }
          : { complete: false, missing: ['received_exchange'] };
      },
    });

    expect(exchange.decode({ report: '-10', region: 'ca' })).toEqual({
      ok: true,
      value: { kind: 'region', report: '-10', value: 'CA' },
    });
    expect(exchange.decode({ report: '-12', serial: '001' })).toEqual({
      ok: true,
      value: { kind: 'serial', report: '-12', value: '001' },
    });
    expect(nextContestSerial(
      [{ serial: '001' }, { serial: '002' }],
      { serial: (record) => record.serial },
    )).toBe('003');
    expect(completion.evaluate({
      receivedExchange: { kind: 'serial', report: '-12', value: '001' },
    }).complete)
      .toBe(true);
    expect(maidenheadDistanceKm('OL32', 'FN31')).toBeGreaterThan(0);
  });

  it('provides a conventional versioned session facade without claiming a QSO transaction', async () => {
    const contest = createExampleContest();
    const session = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0, qsoIds: [] as string[] }),
    });
    const plugin = composeFT8ContestPlugin({
      name: 'session-example',
      version: '1.0.0',
      permissions: CONTEST_SESSION_PERMISSIONS,
      contest,
      session,
      runtime: () => ({}) as StrategyRuntime,
    });
    const context = createMockContext({ permissions: CONTEST_SESSION_PERMISSIONS });
    await plugin.onLoad?.(context);
    session.forOperator(context.operator.id).update((current) => ({
      ...current,
      qsoIds: [...current.qsoIds, 'qso-1'],
    }));
    expect(session.forOperator(context.operator.id).read().qsoIds).toEqual(['qso-1']);
    await plugin.onUnload?.(context);
    expect(() => session.forOperator(context.operator.id)).toThrow('contest_session_not_open');
  });

  it('hides Host session conventions and retries snapshot-planned QSO transactions', async () => {
    const contest = createExampleContest();
    const base = createMockLogbookAccess().forCallsign('W1AW');
    const descriptors: PluginLogbookSessionDescriptor[] = [];
    const plannerRevisions: string[] = [];
    const events: string[] = [];
    const eventOwners: string[] = [];
    let snapshotNumber = 0;
    let applyCalls = 0;
    let notifyCalls = 0;
    const persisted = {
      id: 'qso-1',
      callsign: 'K1ABC',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: 1,
      messageHistory: [],
    };
    const access: PluginLogbookSessionAccess = {
      ...base,
      id: 'opaque-session-id',
      title: 'Example session',
      async queryQSOs() { return [persisted]; },
      async readQsoSnapshot() {
        return { revision: `r${snapshotNumber++}`, records: [] };
      },
      async applyQsoBatch(_mutations, _options) {
        applyCalls += 1;
        if (applyCalls === 1) {
          throw Object.assign(new Error('conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' });
        }
        return {
          revision: 'r3',
          outcomes: [{ inputIndex: 0, status: 'added', record: persisted }],
        };
      },
      async notifyUpdated() { notifyCalls += 1; },
      async destroy() {},
    };
    const logbookSessions: PluginLogbookSessions = {
      async open(descriptor) {
        descriptors.push(descriptor);
        return access;
      },
      async destroy() {},
    };
    const eventBus = createMockEventBus({
      owner: { pluginName: 'application-session-example' },
    });
    const session = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
      maxTransactionAttempts: 3,
    });
    const plugin = composeFT8ContestPlugin({
      name: 'application-session-example',
      version: '1.0.0',
      permissions: CONTEST_SESSION_PERMISSIONS,
      contest,
      session,
      runtime: () => ({}) as StrategyRuntime,
    });
    const context = createMockContext({
      permissions: CONTEST_SESSION_PERMISSIONS,
      logbookSessions,
      eventBus,
    });
    await plugin.onLoad?.(context);
    const application = session.access(context);
    application.subscribe((event) => {
      events.push(event.reason);
      eventOwners.push(`${event.pluginName}:${event.stationCallsign}`);
    });

    const result = await application.transact((snapshot) => {
      plannerRevisions.push(snapshot.revision);
      return [{ type: 'add', record: persisted }];
    }, { reason: 'import' });

    expect(result).toMatchObject({ attempts: 2, batch: { revision: 'r3' } });
    expect(plannerRevisions).toEqual(['r1', 'r2']);
    expect(await application.query()).toEqual([persisted]);
    expect(application.getHealth()).toMatchObject({
      state: 'healthy',
      readable: true,
      writable: true,
      revision: 'r3',
      qsoCount: 1,
    });
    expect(notifyCalls).toBe(1);
    expect(events).toEqual(['import']);
    expect(eventOwners).toEqual(['application-session-example:W1AW']);
    const [topic, subscribers] = [...eventBus._subscriptions.entries()][0]!;
    await subscribers[0]?.({
      ...eventBus._published[0]!,
      topic,
      publisher: {
        pluginName: 'spoofed-plugin',
        instanceScope: 'operator',
        operatorId: 'operator-9',
      },
    });
    expect(events).toEqual(['import']);
    expect(new Set(descriptors.map((descriptor) => descriptor.sessionKey)).size).toBe(1);
    expect(descriptors.every((descriptor) => descriptor.retention === undefined)).toBe(true);
    expect(eventBus._subscriptions.size).toBe(1);

    await plugin.onUnload?.(context);
    expect(eventBus._subscriptions.size).toBe(0);
    expect(session.getHealth(context.operator.id).state).toBe('closed');
  });

  it('encodes contest identity segments in hidden session keys and event topics', async () => {
    const baseContest = createExampleContest();
    const firstContest = {
      ...baseContest,
      id: 'example:edition',
      edition: { ...baseContest.edition, id: '2026.1' },
    };
    const secondContest = {
      ...baseContest,
      id: 'example',
      edition: { ...baseContest.edition, id: 'edition:2026.1' },
    };
    const descriptors: PluginLogbookSessionDescriptor[] = [];
    const bound = createMockLogbookAccess().forCallsign('W1AW');
    const logbookSessions: PluginLogbookSessions = {
      async open(descriptor) {
        descriptors.push(descriptor);
        return { ...bound, id: descriptor.sessionKey, title: descriptor.title, async destroy() {} };
      },
      async destroy() {},
    };
    const firstBus = createMockEventBus();
    const secondBus = createMockEventBus();
    const firstContext = createMockContext({
      permissions: CONTEST_SESSION_PERMISSIONS,
      logbookSessions,
      eventBus: firstBus,
    });
    const secondContext = createMockContext({
      permissions: CONTEST_SESSION_PERMISSIONS,
      logbookSessions,
      eventBus: secondBus,
    });
    const firstSession = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    });
    const secondSession = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    });
    const firstCleanup = await firstSession.setup({
      contest: firstContest,
      context: firstContext,
      pluginName: 'example-plugin',
    });
    const secondCleanup = await secondSession.setup({
      contest: secondContest,
      context: secondContext,
      pluginName: 'example-plugin',
    });
    firstSession.access(firstContext).subscribe(() => {});
    secondSession.access(secondContext).subscribe(() => {});

    expect(descriptors[0]?.sessionKey).toContain('_3a');
    expect(descriptors[0]?.sessionKey).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(descriptors[0]?.sessionKey).not.toBe(descriptors[1]?.sessionKey);
    expect([...firstBus._subscriptions.keys()][0]).not.toBe([...secondBus._subscriptions.keys()][0]);

    if (typeof firstCleanup === 'function') await firstCleanup(firstContext);
    if (typeof secondCleanup === 'function') await secondCleanup(secondContext);
  });

  it('isolates Host sessions and event topics by ruleset version', async () => {
    const firstContest = createExampleContest();
    const secondContest = { ...firstContest, rulesetVersion: '2026.2' };
    const descriptors: PluginLogbookSessionDescriptor[] = [];
    const bound = createMockLogbookAccess().forCallsign('W1AW');
    const logbookSessions: PluginLogbookSessions = {
      async open(descriptor) {
        descriptors.push(descriptor);
        return { ...bound, id: descriptor.sessionKey, title: descriptor.title, async destroy() {} };
      },
      async destroy() {},
    };
    const firstBus = createMockEventBus();
    const secondBus = createMockEventBus();
    const firstContext = createMockContext({
      permissions: CONTEST_SESSION_PERMISSIONS,
      logbookSessions,
      eventBus: firstBus,
    });
    const secondContext = createMockContext({
      permissions: CONTEST_SESSION_PERMISSIONS,
      logbookSessions,
      eventBus: secondBus,
    });
    const firstSession = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    });
    const secondSession = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    });
    const firstCleanup = await firstSession.setup({
      contest: firstContest,
      context: firstContext,
      pluginName: 'example-plugin',
    });
    const secondCleanup = await secondSession.setup({
      contest: secondContest,
      context: secondContext,
      pluginName: 'example-plugin',
    });
    firstSession.access(firstContext).subscribe(() => {});
    secondSession.access(secondContext).subscribe(() => {});

    expect(descriptors[0]?.sessionKey).not.toBe(descriptors[1]?.sessionKey);
    expect([...firstBus._subscriptions.keys()][0]).not.toBe([...secondBus._subscriptions.keys()][0]);

    if (typeof firstCleanup === 'function') await firstCleanup(firstContext);
    if (typeof secondCleanup === 'function') await secondCleanup(secondContext);
  });

  it('isolates event routes by plugin owner and station callsign', async () => {
    const contest = createExampleContest();
    const bound = createMockLogbookAccess().forCallsign('W1AW');
    const descriptors: PluginLogbookSessionDescriptor[] = [];
    const logbookSessions: PluginLogbookSessions = {
      async open(descriptor) {
        descriptors.push(descriptor);
        return { ...bound, id: descriptor.sessionKey, title: descriptor.title, async destroy() {} };
      },
      async destroy() {},
    };
    const eventBus = createMockEventBus();
    const contexts = [
      createMockContext({
        permissions: CONTEST_SESSION_PERMISSIONS,
        logbookSessions,
        eventBus,
        callsign: 'W1AW',
      }),
      createMockContext({
        permissions: CONTEST_SESSION_PERMISSIONS,
        logbookSessions,
        eventBus,
        callsign: 'W1AW',
      }),
      createMockContext({
        permissions: CONTEST_SESSION_PERMISSIONS,
        logbookSessions,
        eventBus,
        callsign: 'K1ABC',
      }),
    ] as const;
    const sessions = contexts.map(() => defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    }));
    const cleanups = await Promise.all([
      sessions[0]!.setup({ contest, context: contexts[0], pluginName: 'owner-a' }),
      sessions[1]!.setup({ contest, context: contexts[1], pluginName: 'owner-b' }),
      sessions[2]!.setup({ contest, context: contexts[2], pluginName: 'owner-a' }),
    ]);
    sessions[0]!.access(contexts[0]).subscribe(() => {});
    sessions[1]!.access(contexts[1]).subscribe(() => {});
    sessions[2]!.access(contexts[2]).subscribe(() => {});

    expect(new Set(eventBus._subscriptions.keys()).size).toBe(3);
    expect(descriptors.map((descriptor) => descriptor.stationCallsign))
      .toEqual(['W1AW', 'W1AW', 'K1ABC']);

    for (const [index, cleanup] of cleanups.entries()) {
      if (typeof cleanup === 'function') await cleanup(contexts[index]!);
    }
  });

  it('rejects runtime retention in the durable default session facade', () => {
    const options = {
      create: () => ({ schemaVersion: 1, revision: 0 }),
      retention: 'runtime' as const,
    };
    expect(() => defaultContestSession(options))
      .toThrow('contest_session_runtime_retention_not_supported');
  });

  it('composes the default session with additional plugin permissions', () => {
    const contest = createExampleContest();
    const permissions = [
      ...CONTEST_SESSION_PERMISSIONS,
      'network',
    ] as const;
    const session = defaultContestSession({
      create: () => ({ schemaVersion: 1, revision: 0 }),
    });
    const plugin = composeFT8ContestPlugin({
      name: 'extended-permission-contest',
      version: '1.0.0',
      permissions,
      contest,
      session,
      runtime: () => ({}) as StrategyRuntime,
    });

    expect(plugin.permissions).toEqual(permissions);
  });

  it('composes the logbook bundle and keeps public settings, ui and hooks merged', () => {
    const contest = createExampleContest();
    const adapter: ContestLogbookAdapter<typeof contest, { schemaVersion: 1; revision: number; settings: { draft: string } }, { draft: string }> = {
      settings: {
        settings: {
          draft: {
            type: 'string',
            default: '',
            label: 'draft',
            description: 'draft',
            scope: 'operator',
          },
        },
        seed: () => ({ schemaVersion: 1, revision: 0, settings: { draft: 'seed' } }),
        validate(session) {
          return session.settings.draft ? [] : [{ code: 'missing-draft', message: 'draft required' }];
        },
        title: () => 'contest-logbook',
      },
      getState: (_contest, session) => ({
        schemaVersion: 1,
        contest: { id: contest.id, editionId: contest.edition.id, rulesetVersion: contest.rulesetVersion },
        health: { state: 'healthy', readable: true, writable: true, updatedAt: 1 },
        settings: { value: session.settings, valid: true, issues: [] },
        score: { claimedScore: 0, qsoPoints: 0, multiplierCount: 0 },
        qsos: [],
        review: { pendingCount: 0, issues: [] as ContestLogbookReviewIssue[] },
        import: { state: 'idle' },
        export: { formats: [] },
      }),
      decode(action, data) {
        return { action, payload: data };
      },
      handle(request) {
        return { action: request.action };
      },
      hooks: {
        onConfigChange(changes, ctx) {
          ctx.log.info('logbook-config', { keys: Object.keys(changes) });
        },
      },
      panels: [{
        id: 'contest-log-panel',
        title: 'contestLogTitle',
        component: 'iframe',
        pageId: 'contest-log',
        slot: 'operator-action',
        openMode: 'page',
        icon: 'file-lines',
      }],
      ui: {
        dir: 'ui',
        pages: [{
          id: 'contest-log',
          title: 'contestLogTitle',
          entry: 'contest-log.html',
          accessScope: 'operator',
          resourceBinding: 'operator',
        }],
      },
    };
    const plugin = composeFT8ContestPlugin({
      name: 'logbook-example',
      version: '1.0.0',
      permissions: CONTEST_LOGBOOK_PERMISSIONS,
      contest,
      logbook: defaultContestLogbook({
        contest,
        pageId: 'contest-log',
        adapter,
      }),
      runtime: () => ({}) as StrategyRuntime,
      settings: {
        extra: {
          type: 'boolean',
          default: true,
          label: 'extra',
          description: 'extra',
          scope: 'operator',
        },
      },
      hooks: {
        onConfigChange(changes) {
          expect(changes).toHaveProperty('extra');
        },
      },
    });

    expect(plugin.settings).toMatchObject({
      draft: expect.any(Object),
      extra: expect.any(Object),
    });
    expect(plugin.quickSettings).toBeUndefined();
    expect(plugin.panels?.map((panel) => panel.id)).toContain('contest-log-panel');
    expect(plugin.ui?.pages?.map((page) => page.id)).toContain('contest-log');
    expect(plugin.hooks?.onConfigChange).toBeDefined();
  });

  it('routes contest QSO completion effects into the contest session', async () => {
    const contest = createExampleContest();
    const ctx = createMockContext({ permissions: CONTEST_LOGBOOK_PERMISSIONS });
    const record: QSORecord = {
      id: 'qso-1',
      callsign: 'JA1AAA',
      grid: 'PM95',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: Date.parse('2026-08-29T01:00:00Z'),
      messageHistory: [],
      myCallsign: 'W1AW',
      myGrid: 'FN31',
    };
    const plugin = composeFT8ContestPlugin({
      name: 'completion-contest',
      version: '1.0.0',
      permissions: CONTEST_LOGBOOK_PERMISSIONS,
      contest,
      logbook: standardFT8ContestLogbook({ contest }),
      runtime: () => ({
        checkpoint: () => ({}),
        restore: () => {},
        decide: () => ({
          transmission: null,
          snapshot: { currentState: 'TX6', slots: {}, context: {} },
          qsoCompletion: { lifecycleEpoch: 1, record },
        }),
        getTransmitText: () => null,
        requestCall: () => {},
        getSnapshot: () => ({ currentState: 'TX6', slots: {}, context: {} }),
        patchContext: () => {},
        setState: () => {},
        setSlotContent: () => {},
        reset: () => {},
      }) as StrategyRuntime,
    });

    await plugin.onLoad?.(ctx as never);
    const runtime = plugin.createStrategyRuntime!(ctx as never);
    expect(runtime.getSnapshot().messagePresentation).toMatchObject({
      mode: 'replace-logbook',
      subject: 'sender-callsign',
      partitionBy: 'band',
      defaultClass: 'contest-new-call',
      classes: {
        'contest-new-call': expect.objectContaining({
          badges: [{ label: 'contestNewCallsign', tone: 'warning' }],
        }),
        'contest-new-field': expect.objectContaining({
          badges: [{ label: 'contestNewMultiplier', tone: 'secondary' }],
        }),
      },
    });
    const result = await runtime.decide([], {
      epoch: 1,
      source: 'slot-auto',
      isReDecision: false,
      signal: new AbortController().signal,
    });

    expect(result.snapshot.messagePresentation?.mode).toBe('replace-logbook');
    expect(result.qsoCompletion?.destination).toEqual({
      kind: 'plugin-session-key',
      sessionKey: expect.stringContaining('contest:'),
    });
    expect(result.qsoCompletion?.record.contestEntry).toMatchObject({
      contestId: 'example-ft8',
      sent: { grid: 'FN31' },
      received: { grid: 'PM95' },
    });
    await plugin.onUnload?.(ctx as never);
  });

  it('derives standard FrameTable presentation from the independent contest session', async () => {
    const contest = createExampleContest();
    const base = createMockLogbookAccess().forCallsign('W1AW');
    const existing: QSORecord = {
      id: 'contest-qso-1',
      callsign: 'JA1AAA',
      grid: 'PM95',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: Date.parse('2026-08-29T01:00:00Z'),
      messageHistory: [],
      myCallsign: 'W1AW',
      myGrid: 'FN31',
    };
    const access: PluginLogbookSessionAccess = {
      ...base,
      id: 'contest-session',
      title: 'Example contest session',
      async queryQSOs() { return [existing]; },
      async readQsoSnapshot() { return { revision: 'contest-r1', records: [existing] }; },
      async destroy() {},
    };
    const ctx = createMockContext({
      permissions: CONTEST_LOGBOOK_PERMISSIONS,
      logbookSessions: { open: async () => access, destroy: async () => {} },
    });
    const plugin = composeFT8ContestPlugin({
      name: 'contest-presentation',
      version: '1.0.0',
      permissions: CONTEST_LOGBOOK_PERMISSIONS,
      contest,
      logbook: standardFT8ContestLogbook({ contest }),
      runtime: () => ({
        checkpoint: () => ({}),
        restore: () => {},
        decide: () => ({ transmission: null, snapshot: { currentState: 'TX6' } }),
        getTransmitText: () => null,
        requestCall: () => {},
        getSnapshot: () => ({ currentState: 'TX6' }),
        patchContext: () => {},
        setState: () => {},
        setSlotContent: () => {},
        reset: () => {},
      }) as StrategyRuntime,
    });

    await plugin.onLoad?.(ctx as never);
    const presentation = plugin.createStrategyRuntime!(ctx as never).getSnapshot().messagePresentation;
    expect(presentation?.assignments).toContainEqual({
      subject: 'JA1AAA',
      partition: '20M',
      classId: 'contest-worked',
    });
    expect(presentation?.noveltyRules?.[0]?.knownValuesByPartition['20M']).toEqual(['PM']);
    await plugin.onUnload?.(ctx as never);
  });

  it('rejects logbook composition without the required session permissions', () => {
    const contest = createExampleContest();
    const adapter = {
      settings: {
        settings: {},
        seed: () => ({ schemaVersion: 1, revision: 0 }),
        validate: () => [],
      },
      getState: () => ({
        schemaVersion: 1 as const,
        contest: { id: contest.id, editionId: contest.edition.id, rulesetVersion: contest.rulesetVersion },
        health: { state: 'healthy' as const, readable: true, writable: true, updatedAt: 1 },
        settings: { value: {}, valid: true, issues: [] },
        score: { claimedScore: 0, qsoPoints: 0, multiplierCount: 0 },
        qsos: [],
        review: { pendingCount: 0, issues: [] },
        import: { state: 'idle' as const },
        export: { formats: [] },
      }),
      decode(action: string, data: unknown) {
        return { action, payload: data };
      },
      handle() {
        return null;
      },
    } as const;

    expect(() => composeFT8ContestPlugin({
      name: 'missing-logbook-perms',
      version: '1.0.0',
      permissions: [],
      contest,
      logbook: defaultContestLogbook({
        contest,
        pageId: 'contest-log',
        adapter: adapter as unknown as ContestLogbookAdapter<typeof contest, { schemaVersion: 1; revision: number }, {}>,
      }),
      runtime: () => ({}) as StrategyRuntime,
    } as unknown as Parameters<typeof composeFT8ContestPlugin>[0])).toThrow('contest_logbook_missing_permission:logbook:session');
  });

  it('composes narrow typed workbench protocols for multiple plugin pages', async () => {
    const contest = createExampleContest();
    const context = createMockContext();
    const pageHandlers = new Map<string, PluginUIHandler>();
    context.ui.registerPageHandler = (handler, registration) => {
      for (const pageId of registration?.pageIds ?? []) pageHandlers.set(pageId, handler);
    };
    const workbench = defaultContestWorkbench({
      pageId: 'contest-log',
      getState: () => ({
        schemaVersion: 1 as const,
        contest: { id: contest.id, editionId: contest.edition.id, rulesetVersion: contest.rulesetVersion },
        health: { state: 'healthy' as const, readable: true, writable: true, updatedAt: 1 },
        settings: { value: {}, valid: true, issues: [] },
        score: { claimedScore: 42, qsoPoints: 42, multiplierCount: 1 },
        qsos: [],
        review: { pendingCount: 0, issues: [] },
        import: { state: 'idle' as const },
        export: { formats: [] },
      }),
      decode(action, data) {
        if (action !== CONTEST_WORKBENCH_ACTIONS.setQsoStatus || typeof data !== 'string') {
          throw new Error('invalid_workbench_request');
        }
        return { action, payload: data } as const;
      },
      handle: (request) => ({ saved: request.payload }),
    });
    const diagnostics = defaultContestWorkbench({
      pageId: 'contest-diagnostics',
      getState: () => ({
        schemaVersion: 1 as const,
        contest: { id: contest.id, editionId: contest.edition.id, rulesetVersion: contest.rulesetVersion },
        health: { state: 'healthy' as const, readable: true, writable: true, updatedAt: 1 },
        settings: { value: {}, valid: true, issues: [] },
        score: { claimedScore: 7, qsoPoints: 7, multiplierCount: 0 },
        qsos: [],
        review: { pendingCount: 0, issues: [] },
        import: { state: 'idle' as const },
        export: { formats: [] },
      }),
      decode(action, data) { return { action, payload: data }; },
      handle: (request) => ({ echoed: request.payload }),
    });
    await workbench.setup({ contest, context, pluginName: 'example-plugin' });
    await diagnostics.setup({ contest, context, pluginName: 'example-plugin' });
    const requestContext = {} as PluginUIRequestContext;
    const pageHandler = pageHandlers.get('contest-log');
    const diagnosticsHandler = pageHandlers.get('contest-diagnostics');

    expect(await pageHandler?.onMessage('contest-log', 'get-state', undefined, requestContext))
      .toMatchObject({ score: { claimedScore: 42 } });
    expect(await pageHandler?.onMessage(
      'contest-log',
      CONTEST_WORKBENCH_ACTIONS.setQsoStatus,
      'review',
      requestContext,
    ))
      .toEqual({ saved: 'review' });
    expect(await diagnosticsHandler?.onMessage(
      'contest-diagnostics',
      'get-state',
      undefined,
      requestContext,
    )).toMatchObject({ score: { claimedScore: 7 } });
    expect([...pageHandlers.keys()]).toEqual(['contest-log', 'contest-diagnostics']);
    await expect(pageHandlers.get('contest-log')?.onMessage(
      'contest-diagnostics',
      'get-state',
      undefined,
      requestContext,
    )).rejects.toThrow('contest_workbench_page_mismatch');
  });

  it('assembles lifecycle modules without hiding the raw modules', async () => {
    const contest = createExampleContest();
    const calls: string[] = [];
    const session = defineContestSessionModule({
      id: 'test-session',
      setup() {
        calls.push('session:setup');
        return () => { calls.push('session:cleanup'); };
      },
    });
    const plugin = composeFT8ContestPlugin({
      name: 'example-ft8-plugin',
      version: '1.0.0',
      permissions: [],
      contest,
      session,
      runtime: () => ({}) as StrategyRuntime,
      onLoad() { calls.push('plugin:load'); },
      onUnload() { calls.push('plugin:unload'); },
    });
    const context = createMockContext();

    await plugin.onLoad?.(context);
    await plugin.onUnload?.(context);

    expect(plugin.type).toBe('strategy');
    expect(plugin.apiVersion).toBe(2);
    expect(calls).toEqual([
      'session:setup',
      'plugin:load',
      'plugin:unload',
      'session:cleanup',
    ]);
  });
});
