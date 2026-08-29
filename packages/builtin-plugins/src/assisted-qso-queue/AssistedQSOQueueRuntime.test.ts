import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODES,
  type FrameMessage,
  type ParsedFT8Message,
  type SlotInfo,
} from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import type { PluginLogger, StrategyDecisionMetaV2 } from '@tx5dr/plugin-api';
import {
  AssistedQSOQueueRuntime,
  type AssistedQSOQueueRuntimeOptions,
} from './AssistedQSOQueueRuntime.js';
import type {
  StandardQSOOperatorConfig,
  StandardQSOPluginOperator,
} from '../standard-qso/StandardQSOPluginRuntime.js';

const BASE_TIME = 1_700_000_000_000;

function createOperator(
  overrides: Partial<StandardQSOOperatorConfig> = {},
  hasWorkedCallsign: StandardQSOPluginOperator['hasWorkedCallsign'] = vi.fn(async () => false),
): StandardQSOPluginOperator {
  const config: StandardQSOOperatorConfig = {
    id: 'operator-1',
    mode: MODES.FT8,
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    frequency: 7_074_000,
    transmitCycles: [0],
    autoReplyToCQ: false,
    autoResumeCQAfterFail: false,
    autoResumeCQAfterSuccess: false,
    replyToWorkedStations: false,
    prioritizeNewCalls: true,
    targetSelectionPriorityMode: 'dxcc_first',
    maxQSOTimeoutCycles: 6,
    maxCallAttempts: 5,
    ...overrides,
  };
  return {
    get config() { return config; },
    hasWorkedCallsign,
    isTargetBeingWorkedByOthers: vi.fn(() => false),
    notifySlotsUpdated: vi.fn(),
    notifyStateChanged: vi.fn(),
  };
}

function createLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRuntime(options: {
  transmitting?: boolean;
  operator?: StandardQSOPluginOperator;
  maxStreams?: number;
  streamLimit?: number;
} = {}) {
  let transmitting = options.transmitting ?? false;
  let maxStreams = options.maxStreams ?? 1;
  let streamLimit = options.streamLimit ?? 3;
  const runtimeOptions: AssistedQSOQueueRuntimeOptions = {
    operator: options.operator ?? createOperator(),
    isTransmitting: () => transmitting,
    logger: createLogger(),
    getMaxStreams: () => maxStreams,
    getStreamLimit: () => streamLimit,
  };
  return {
    runtime: new AssistedQSOQueueRuntime(runtimeOptions),
    setTransmitting(value: boolean) { transmitting = value; },
    setMaxStreams(value: number) { maxStreams = value; },
    setStreamLimit(value: number) { streamLimit = value; },
    logger: runtimeOptions.logger,
  };
}

function slotInfo(startMs = BASE_TIME): SlotInfo {
  return {
    id: `slot-${startMs}`,
    startMs,
    utcSeconds: Math.floor(startMs / 1000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(startMs / MODES.FT8.slotMs) % 2,
    mode: MODES.FT8.name,
  };
}

function parsed(rawMessage: string, startMs = BASE_TIME, overrides: Partial<ParsedFT8Message> = {}): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0,
    df: 1500,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: `slot-${startMs}`,
    timestamp: startMs,
    ...overrides,
  };
}

function selected(rawMessage: string, startMs = BASE_TIME) {
  return {
    message: {
      message: rawMessage,
      snr: -10,
      dt: 0,
      freq: 1500,
      confidence: 1,
    } as FrameMessage,
    slotInfo: slotInfo(startMs),
  };
}

function observation(startMs = BASE_TIME) {
  return {
    slotInfo: slotInfo(startMs),
    source: 'slot-auto' as const,
    signal: new AbortController().signal,
  };
}

function decision(epoch = 1): StrategyDecisionMetaV2 {
  return {
    epoch,
    source: 'slot-auto',
    isReDecision: false,
    signal: new AbortController().signal,
  };
}

async function prepareFinal73Lease(runtime: AssistedQSOQueueRuntime) {
  runtime.enqueueTarget({
    callsign: 'JA1AAA',
    lastMessage: selected('BG5DRB JA1AAA -08'),
  });
  runtime.enqueueTarget({ callsign: 'JA2BBB' });
  const first = await runtime.decide([], decision());
  runtime.onTransmissionQueued(first.transmission!);

  const rrr = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
  runtime.observeDecodedMessages([rrr], observation(rrr.timestamp));
  const completion = await runtime.decide([rrr], decision(2));
  runtime.settleQSOCompletion({
    lifecycleEpoch: completion.qsoCompletion!.lifecycleEpoch,
    recordId: completion.qsoCompletion!.record.id,
    status: 'committed',
  });
  runtime.onTransmissionQueued(completion.transmission!);

  const releaseSlotStartMs = BASE_TIME + MODES.FT8.slotMs * 2;
  runtime.observeDecodedMessages([], observation(releaseSlotStartMs));
  const release = await runtime.decide([], decision(3));
  return { completion, release, releaseSlotStartMs };
}

describe('AssistedQSOQueueRuntime queue capability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps manual enqueue idempotent and does not churn the snapshot version', async () => {
    const { runtime, setTransmitting } = createRuntime();
    const first = runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    const duplicate = runtime.enqueueTarget({ callsign: 'ja1aaa', lastMessage: selected('CQ JA1AAA PM95') });

    expect(first.outcome).toBe('accepted');
    expect(duplicate.outcome).toBe('duplicate');
    expect(duplicate.snapshot.version).toBe(first.snapshot.version);
    expect(runtime.observeDecodedMessages([parsed('CQ JA1AAA PM95')], observation())).toBe(false);

    setTransmitting(true);
    await runtime.decide([], decision());
    const activeVersion = runtime.getQueueSnapshot().version;
    await runtime.decide([], decision(2));
    expect(runtime.getQueueSnapshot().version).toBe(activeVersion);
  });

  it('runs two or three stable protocol lanes when configured while defaulting to one', async () => {
    const defaultRuntime = createRuntime({ transmitting: true }).runtime;
    defaultRuntime.enqueueTarget({ callsign: 'JA1AAA' });
    defaultRuntime.enqueueTarget({ callsign: 'JA2BBB' });
    const defaultDecision = await defaultRuntime.decide([], decision());
    expect(defaultDecision.transmissions).toHaveLength(1);
    expect(defaultRuntime.getQueueSnapshot()).toMatchObject({
      maxActiveStreams: 1,
      activeEntryIds: [defaultRuntime.getQueueSnapshot().rows[0]?.entryId],
    });

    const parallel = createRuntime({ transmitting: true, maxStreams: 3 }).runtime;
    parallel.enqueueTarget({ callsign: 'JA1AAA' });
    parallel.enqueueTarget({ callsign: 'JA2BBB' });
    parallel.enqueueTarget({ callsign: 'JA3CCC' });
    const parallelDecision = await parallel.decide([], decision());

    expect(parallelDecision.transmissions).toMatchObject([
      { streamId: 'stream-1', text: expect.stringContaining('JA1AAA') },
      { streamId: 'stream-2', text: expect.stringContaining('JA2BBB') },
      { streamId: 'stream-3', text: expect.stringContaining('JA3CCC') },
    ]);
    expect(parallelDecision.transmissions!.map((item) => item.audioFrequencyHz)).toEqual([
      1_500,
      1_560,
      1_620,
    ]);
    expect(parallelDecision.snapshot.streams).toHaveLength(3);
    expect(parallel.getQueueSnapshot().activeEntryIds).toHaveLength(3);
  });

  it('preempts excess lanes on shrink and uses a newly raised limit on the next decision', async () => {
    const { runtime, setMaxStreams } = createRuntime({ transmitting: true, maxStreams: 2 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    runtime.enqueueTarget({ callsign: 'JA3CCC' });
    await runtime.decide([], decision());
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(2);

    setMaxStreams(3);
    await runtime.decide([], decision(2));
    expect(runtime.getQueueSnapshot()).toMatchObject({ maxActiveStreams: 3 });
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(3);

    setMaxStreams(1);
    await runtime.decide([], decision(3));
    expect(runtime.getQueueSnapshot()).toMatchObject({ maxActiveStreams: 1 });
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(1);
    expect(runtime.getQueueSnapshot().rows.slice(1).map((row) => row.displayState)).toEqual(['TX1', 'TX1']);
  });

  it('reports the requested count while a Host safety limit forces one active stream', async () => {
    const { runtime, setStreamLimit } = createRuntime({ transmitting: true, maxStreams: 3, streamLimit: 1 });
    for (const callsign of ['JA1AAA', 'JA2BBB', 'JA3CCC']) runtime.enqueueTarget({ callsign });

    expect((await runtime.decide([], decision())).transmissions).toHaveLength(1);
    expect(runtime.getQueueSnapshot()).toMatchObject({
      maxActiveStreams: 1,
      requestedMaxActiveStreams: 3,
    });

    setStreamLimit(3);
    expect((await runtime.decide([], decision(2))).transmissions).toHaveLength(3);
  });

  it('routes decoded replies to one standard protocol lane without advancing its peers', async () => {
    const { runtime } = createRuntime({ transmitting: true, maxStreams: 3 });
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    runtime.enqueueTarget({ callsign: 'JA2BBB', lastMessage: selected('CQ JA2BBB PM95') });
    runtime.enqueueTarget({ callsign: 'JA3CCC', lastMessage: selected('CQ JA3CCC PM95') });
    const initial = await runtime.decide([], decision());
    runtime.onTransmissionsCompleted(initial.transmissions!.map((transmission) => ({
      ...transmission,
      frameId: 'frame-1',
      revision: 1,
      physicalConfirmed: true as const,
    })));

    const replyAt = BASE_TIME + MODES.FT8.slotMs;
    const reply = parsed('BG5DRB JA1AAA -05', replyAt, { snr: -7 });
    runtime.observeDecodedMessages([reply], observation(replyAt));
    const advanced = await runtime.decide([reply], decision(2));

    expect(advanced.transmissions).toMatchObject([
      { streamId: 'stream-1', text: expect.stringContaining('R-07') },
      { streamId: 'stream-2', text: expect.stringContaining('JA2BBB') },
      { streamId: 'stream-3', text: expect.stringContaining('JA3CCC') },
    ]);
    expect(advanced.snapshot.streams).toMatchObject([
      { streamId: 'stream-1', currentState: 'TX3', targetCallsign: 'JA1AAA' },
      { streamId: 'stream-2', currentState: 'TX1', targetCallsign: 'JA2BBB' },
      { streamId: 'stream-3', currentState: 'TX1', targetCallsign: 'JA3CCC' },
    ]);
  });

  it('hot-updates protocol and physical lane frequencies through one bounded resolver', async () => {
    const source = createOperator();
    const config = { ...source.config, frequency: 299 };
    const operator: StandardQSOPluginOperator = {
      get config() { return config; },
      hasWorkedCallsign: (callsign, options) => source.hasWorkedCallsign(callsign, options),
      isTargetBeingWorkedByOthers: (callsign) => source.isTargetBeingWorkedByOthers(callsign),
    };
    const { runtime } = createRuntime({ transmitting: true, maxStreams: 3, operator });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    runtime.enqueueTarget({ callsign: 'JA3CCC' });
    await runtime.decide([], decision());
    expect(runtime.getTransmissions().map((item) => item.audioFrequencyHz)).toEqual([1_500, 1_560, 1_620]);

    config.frequency = 4_700;
    expect(runtime.getTransmissions().map((item) => item.audioFrequencyHz)).toEqual([4_700, 4_760, 4_820]);
    expect(runtime.getSnapshot().context?.actualFrequency).toBeUndefined();

    config.frequency = 4_701;
    expect(runtime.getTransmissions().map((item) => item.audioFrequencyHz)).toEqual([1_500, 1_560, 1_620]);

    config.mode = MODES.FT4;
    expect(runtime.getTransmissions().map((item) => item.audioFrequencyHz)).toEqual([1_500, 1_600, 1_700]);
  });

  it('uses standard TX6 CQ only when no queue target is executable', async () => {
    const { runtime, setTransmitting } = createRuntime();
    expect(runtime.getTransmitText()).toBeNull();

    setTransmitting(true);
    expect((await runtime.decide([], decision())).transmission).toBe('CQ BG5DRB OL32');
    expect(runtime.getTransmitText()).toBe('CQ BG5DRB OL32');

    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    expect(runtime.getTransmitText()).toBeNull();
    expect((await runtime.decide([], decision(2))).transmission).toContain('JA1AAA');
  });

  it('resets a single active QSO to TX6 through the stream state API', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const active = await runtime.decide([], decision());
    const stream = active.snapshot.streams?.[0];
    expect(stream?.stateOptions?.some((option) => option.id === 'TX6')).toBe(true);

    runtime.setStreamState({
      streamId: stream!.streamId,
      stateId: 'TX6',
      expectedLifecycleEpoch: stream!.qsoLifecycleEpoch,
    });
    const reset = await runtime.decide([], decision(2));

    expect(reset.snapshot.streams).toEqual([]);
    expect(runtime.getQueueSnapshot().rows).toEqual([]);
    expect(reset.transmission).toBe('CQ BG5DRB OL32');
  });

  it('falls back to CQ when every queued target is paused or inactive', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    runtime.observeDecodedMessages([
      parsed('JA9ZZZ JA1AAA -04', BASE_TIME + MODES.FT8.slotMs),
    ], observation(BASE_TIME + MODES.FT8.slotMs));

    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'paused',
      pauseReason: 'target-busy',
      lastHeardCycle: slotInfo(BASE_TIME + MODES.FT8.slotMs).cycleNumber,
    });
    expect((await runtime.decide([], decision())).transmission).toBe('CQ BG5DRB OL32');
  });

  it('observes and upgrades queue context while the main transmit switch is off', async () => {
    const { runtime, setTransmitting } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    const report = parsed('BG5DRB JA1AAA -08', BASE_TIME + MODES.FT8.slotMs);
    const reportObservation = observation(report.timestamp);
    reportObservation.slotInfo.cycleNumber = Math.floor(report.timestamp / MODES.FT8.slotMs);

    expect(runtime.observeDecodedMessages([report], reportObservation)).toBe(true);
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'TX3',
      lastHeardCycle: reportObservation.slotInfo.cycleNumber % 2,
    });
    expect((await runtime.decide([report], decision())).transmission).toBeNull();

    setTransmitting(true);
    const resumed = await runtime.decide([report], decision(2));
    expect(resumed.snapshot.currentState).toBe('TX3');
    expect(resumed.transmission).toContain('R-10');
    expect(resumed.requestedTransmitCycle).toBe((slotInfo(report.timestamp).cycleNumber + 1) % 2);
  });

  it('automatically enqueues reliable direct callers and ignores partial decodes', () => {
    const { runtime } = createRuntime();
    const partial = parsed('BG5DRB <...> PM95', BASE_TIME, { isPartialDecode: true });
    const txEcho = parsed('JA1AAA BG5DRB -05');
    const unstructured = parsed('HELLO WORLD');
    runtime.observeDecodedMessages([partial, txEcho, unstructured], observation());
    expect(runtime.getQueueSnapshot().rows).toHaveLength(0);

    runtime.observeDecodedMessages([
      parsed('BG5DRB JA2BBB PM95'),
      parsed('BG5DRB JA3CCC -07'),
    ], observation());
    expect(runtime.getQueueSnapshot().rows).toMatchObject([
      {
        callsign: 'JA2BBB',
        displayState: 'TX2',
        targetGrid: 'PM95',
        lastSnr: -10,
        lastHeardCyclesAgo: 0,
      },
      {
        callsign: 'JA3CCC',
        displayState: 'TX3',
        lastSnr: -10,
        lastHeardCyclesAgo: 0,
      },
    ]);
  });

  it('does not activate automatically queued worked stations unless replies are enabled', async () => {
    const hasWorkedCallsign = vi.fn(async () => true);
    const blocked = createRuntime({
      transmitting: true,
      operator: createOperator({ replyToWorkedStations: false }, hasWorkedCallsign),
    });
    blocked.runtime.observeDecodedMessages([
      parsed('BG5DRB JA1AAA PM95'),
    ], observation());

    const blockedDecision = await blocked.runtime.decide([], decision());
    expect(hasWorkedCallsign).toHaveBeenCalledWith('JA1AAA');
    expect(blocked.runtime.getQueueSnapshot().rows).toHaveLength(0);
    expect(blockedDecision.transmission).toBe('CQ BG5DRB OL32');

    const allowedHasWorkedCallsign = vi.fn(async () => true);
    const allowed = createRuntime({
      transmitting: true,
      operator: createOperator({ replyToWorkedStations: true }, allowedHasWorkedCallsign),
    });
    allowed.runtime.observeDecodedMessages([
      parsed('BG5DRB JA1AAA PM95'),
    ], observation());

    const allowedDecision = await allowed.runtime.decide([], decision());
    expect(allowedHasWorkedCallsign).not.toHaveBeenCalled();
    expect(allowed.runtime.getQueueSnapshot().rows).toMatchObject([
      { callsign: 'JA1AAA', displayState: 'TX2' },
    ]);
    expect(allowedDecision.transmission).toContain('JA1AAA');
  });

  it('keeps manual targets as an explicit override for worked stations', async () => {
    const hasWorkedCallsign = vi.fn(async () => true);
    const { runtime } = createRuntime({
      transmitting: true,
      operator: createOperator({ replyToWorkedStations: false }, hasWorkedCallsign),
    });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });

    const result = await runtime.decide([], decision());
    expect(hasWorkedCallsign).not.toHaveBeenCalled();
    expect(runtime.getQueueSnapshot().rows).toMatchObject([
      { callsign: 'JA1AAA', displayState: 'TX1' },
    ]);
    expect(result.transmission).toContain('JA1AAA');
  });

  it('pauses stale or busy stations with explicit reasons and revives on fresh CQ', () => {
    const { runtime } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    const expiredAt = BASE_TIME + MODES.FT8.slotMs * 6 + 1;
    runtime.observeDecodedMessages([], observation(expiredAt));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'paused',
      pauseReason: 'stale',
      targetGrid: 'PM95',
      lastSnr: -10,
      lastHeardCyclesAgo: 6,
      icon: 'pause',
    });

    const pausedVersion = runtime.getQueueSnapshot().version;
    const nextCycle = expiredAt + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([], observation(nextCycle));
    expect(runtime.getQueueSnapshot()).toMatchObject({
      version: pausedVersion + 1,
      rows: [{ lastHeardCyclesAgo: 7 }],
    });

    runtime.observeDecodedMessages([parsed('CQ JA1AAA PM95', expiredAt)], observation(expiredAt));
    expect(runtime.getQueueSnapshot().rows[0]?.displayState).toBe('TX1');

    runtime.observeDecodedMessages([
      parsed('JA9ZZZ JA1AAA -04', expiredAt + MODES.FT8.slotMs),
    ], observation(expiredAt + MODES.FT8.slotMs));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'paused',
      pauseReason: 'target-busy',
    });

    const inactiveAt = expiredAt + MODES.FT8.slotMs * 13;
    runtime.observeDecodedMessages([], observation(inactiveAt));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'no-response',
      lastHeardCyclesAgo: 12,
      icon: 'clock',
    });

    const inactiveVersion = runtime.getQueueSnapshot().version;
    const nextInactiveCycle = inactiveAt + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([], observation(nextInactiveCycle));
    expect(runtime.getQueueSnapshot()).toMatchObject({
      version: inactiveVersion + 1,
      rows: [{ displayState: 'no-response', lastHeardCyclesAgo: 13 }],
    });

    const busyAgainAt = nextInactiveCycle + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([
      parsed('JA9ZZZ JA1AAA -03', busyAgainAt),
    ], observation(busyAgainAt));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'paused',
      pauseReason: 'target-busy',
      lastHeardCyclesAgo: 0,
    });

    const cqAgainAt = busyAgainAt + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([
      parsed('CQ JA1AAA PM95', cqAgainAt),
    ], observation(cqAgainAt));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'TX1',
      lastHeardCyclesAgo: 0,
    });
  });

  it('uses optimistic versions and treats a same-position reorder as a no-op', () => {
    const { runtime } = createRuntime();
    const one = runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const [first, second] = runtime.getQueueSnapshot().rows;
    const version = runtime.getQueueSnapshot().version;

    expect(runtime.reorderTarget(first!.entryId, first!.entryId, version).snapshot.version).toBe(version);
    const moved = runtime.reorderTarget(second!.entryId, first!.entryId, version);
    expect(moved.outcome).toBe('accepted');
    expect(moved.snapshot.rows.map((row) => row.callsign)).toEqual(['JA2BBB', 'JA1AAA']);
    expect(runtime.removeTarget(first!.entryId, one.snapshot.version).reason).toBe('version_conflict');
  });

  it('promotes inbound callers ahead of outbound targets while preserving operator reorder authority', async () => {
    const { runtime, setTransmitting } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const directAt = BASE_TIME + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([
      parsed('BG5DRB JA2BBB PM95', directAt),
    ], observation(directAt));

    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA2BBB', 'JA1AAA']);

    const promoted = runtime.getQueueSnapshot();
    const direct = promoted.rows[0]!;
    expect(runtime.reorderTarget(direct.entryId, null, promoted.version).snapshot.rows.map((row) => row.callsign))
      .toEqual(['JA1AAA', 'JA2BBB']);

    setTransmitting(true);
    await runtime.decide([], decision());
    expect(runtime.getSnapshot().context?.targetCallsign).toBe('JA1AAA');
  });

  it('requires an actually completed local frame before accepting R-report progression', async () => {
    const uncorrelated = createRuntime({ transmitting: true }).runtime;
    uncorrelated.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA PM95'),
    });
    await uncorrelated.decide([], decision());
    uncorrelated.observeDecodedMessages([parsed('BG5DRB JA1AAA R-05')], observation());
    expect(uncorrelated.getSnapshot().currentState).toBe('TX2');

    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA PM95'),
    });
    await runtime.decide([], decision());
    runtime.onTransmissionQueued(runtime.getTransmitText()!);
    const roger = parsed('BG5DRB JA1AAA R-05', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([roger], observation(roger.timestamp));
    const progressed = await runtime.decide([roger], decision(2));
    expect(progressed.snapshot.currentState).toBe('TX4');
    expect(progressed.snapshot.queue?.rows[0]?.displayState).toBe('closing');
  });

  it('preempts only an unanswered TX1 and never an engaged QSO', async () => {
    const first = createRuntime({ transmitting: true }).runtime;
    first.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    await first.decide([], decision());
    const direct = parsed('BG5DRB JA2BBB PM95', BASE_TIME + MODES.FT8.slotMs);
    first.observeDecodedMessages([direct], observation(direct.timestamp));
    await first.decide([direct], decision(2));
    expect(first.getSnapshot().context?.targetCallsign).toBe('JA2BBB');
    expect(first.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA2BBB', 'JA1AAA']);

    const engaged = createRuntime({ transmitting: true }).runtime;
    engaged.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    await engaged.decide([], decision());
    const reply = parsed('BG5DRB JA1AAA -08', BASE_TIME + MODES.FT8.slotMs);
    engaged.observeDecodedMessages([reply], observation(reply.timestamp));
    await engaged.decide([reply], decision(2));
    engaged.enqueueTarget({ callsign: 'JA3CCC' });
    const other = parsed('BG5DRB JA2BBB PM95', BASE_TIME + MODES.FT8.slotMs * 2);
    engaged.observeDecodedMessages([other], observation(other.timestamp));
    await engaged.decide([other], decision(3));
    expect(engaged.getSnapshot().context?.targetCallsign).toBe('JA1AAA');
    expect(engaged.getQueueSnapshot().rows.map((row) => row.callsign))
      .toEqual(['JA1AAA', 'JA2BBB', 'JA3CCC']);
  });

  it('gives a preempted lane to the direct opportunity that triggered preemption', async () => {
    const { runtime } = createRuntime({ transmitting: true, maxStreams: 3 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    runtime.enqueueTarget({ callsign: 'JA3CCC' });
    await runtime.decide([], decision());
    runtime.enqueueTarget({ callsign: 'JA4DDD' });
    const directAt = BASE_TIME;
    runtime.observeDecodedMessages([
      parsed('BG5DRB JA5EEE PM95', directAt),
    ], observation(directAt));
    const promoted = runtime.getQueueSnapshot();
    const direct = promoted.rows.find((row) => row.callsign === 'JA5EEE')!;
    expect(runtime.reorderTarget(direct.entryId, null, promoted.version).snapshot.rows.map((row) => row.callsign))
      .toEqual(['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD', 'JA5EEE']);

    const preempted = await runtime.decide([], decision(2));

    expect(preempted.transmissions).toMatchObject([
      { streamId: 'stream-1', text: expect.stringContaining('JA5EEE') },
      { streamId: 'stream-2', text: expect.stringContaining('JA2BBB') },
      { streamId: 'stream-3', text: expect.stringContaining('JA3CCC') },
    ]);
    expect(runtime.getQueueSnapshot().rows.slice(0, 3).map((row) => row.callsign))
      .toEqual(['JA5EEE', 'JA2BBB', 'JA3CCC']);
    expect(runtime.getQueueSnapshot().rows.slice(3).map((row) => row.callsign))
      .toEqual(['JA4DDD', 'JA1AAA']);
  });

  it('releases an unengaged active target when it starts working another station', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ JA1AAA PM95') });
    await runtime.decide([], decision());

    const workingOther = parsed('JA9ZZZ JA1AAA -04', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([workingOther], observation(workingOther.timestamp));
    expect(runtime.getQueueSnapshot()).toMatchObject({
      activeEntryId: undefined,
      rows: [{ callsign: 'JA1AAA', displayState: 'paused', pauseReason: 'target-busy' }],
    });
    expect(runtime.getTransmitText()).toBe('CQ BG5DRB OL32');
  });

  it('expires an engaged context while paused instead of transmitting stale protocol state', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true });
    const reportTime = BASE_TIME + MODES.FT8.slotMs;
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA -08', reportTime),
    });
    await runtime.decide([], decision());
    expect(runtime.getQueueSnapshot().rows[0]?.displayState).toBe('engaged');

    setTransmitting(false);
    runtime.observeDecodedMessages([], observation(reportTime + MODES.FT8.slotMs * 6 + 1));
    expect(runtime.getQueueSnapshot()).toMatchObject({
      activeEntryId: undefined,
      rows: [{ callsign: 'JA1AAA', displayState: 'paused', pauseReason: 'stale' }],
    });
  });

  it('passes a correlated Fox/Hound RR73 completion to the standard delegate', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'EX8ABR',
      lastMessage: selected('BG5DRB EX8ABR -09'),
    });
    await runtime.decide([], decision());
    runtime.onTransmissionQueued(runtime.getTransmitText()!);
    const fox = parsed('BG5DRB RR73; JH1UBK <EX8ABR> -24', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([fox], decision(2));

    expect(completed.snapshot.currentState).toBe('TX5');
    expect(completed.qsoCompletion?.record.callsign).toBe('EX8ABR');
  });

  it('automatically returns an unanswered target when a fresh target frame appears', async () => {
    const operator = createOperator({ maxQSOTimeoutCycles: 1, maxCallAttempts: 1 });
    const { runtime } = createRuntime({ transmitting: true, operator });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });

    await runtime.decide([], decision());
    const ja1 = runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA1AAA');
    expect(ja1).toMatchObject({
      displayState: 'no-response',
      noResponseCycles: 1,
    });
    const freshCq = parsed('CQ JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([freshCq], observation(freshCq.timestamp));
    expect(runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA1AAA')).toMatchObject({
      callsign: 'JA1AAA',
      displayState: 'TX1',
      lastHeardCyclesAgo: 0,
    });
  });

  it('allows manual retry only for a timed-out QSO attempt', async () => {
    const operator = createOperator({ maxQSOTimeoutCycles: 1, maxCallAttempts: 1 });
    const { runtime } = createRuntime({ transmitting: true, operator });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    await runtime.decide([], decision());

    const failed = runtime.getQueueSnapshot();
    const failedEntry = failed.rows.find((row) => row.callsign === 'JA1AAA')!;
    expect(failedEntry).toMatchObject({ displayState: 'no-response', noResponseCycles: 1 });
    expect(runtime.retryTarget(failedEntry.entryId, failed.version - 1)).toMatchObject({
      outcome: 'rejected',
      reason: 'version_conflict',
    });
    const retried = runtime.retryTarget(failedEntry.entryId, failed.version);
    expect(retried).toMatchObject({
      outcome: 'accepted',
      snapshot: {
        rows: [
          { callsign: 'JA2BBB' },
          { callsign: 'JA1AAA', displayState: 'TX1' },
        ],
      },
    });
    expect(retried.snapshot.rows[1]?.noResponseCycles).toBeUndefined();

    const { runtime: inactive } = createRuntime();
    inactive.enqueueTarget({ callsign: 'JA3CCC', lastMessage: selected('CQ JA3CCC PM95') });
    inactive.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs * 6 + 1));
    inactive.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs * 13 + 1));
    const inactiveSnapshot = inactive.getQueueSnapshot();
    expect(inactiveSnapshot.rows[0]).toMatchObject({
      displayState: 'no-response',
      noResponseCycles: undefined,
    });
    expect(inactive.retryTarget(inactiveSnapshot.rows[0]!.entryId, inactiveSnapshot.version)).toMatchObject({
      outcome: 'rejected',
      reason: 'entry_not_retryable',
    });
  });

  it('allows explicit removal of the active target and clears delegate QSO state', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    await runtime.decide([], decision());
    const active = runtime.getQueueSnapshot();

    expect(active.rows[0]?.draggable).toBe(false);
    const removed = runtime.removeTarget(active.activeEntryId!, active.version);

    expect(removed).toMatchObject({ outcome: 'accepted' });
    expect(removed.snapshot.rows).toHaveLength(0);
    expect(runtime.getSnapshot().context?.targetCallsign).toBeUndefined();
    expect(runtime.getTransmitText()).toBe('CQ BG5DRB OL32');
  });

  it('clears waiting and active queues with one versioned mutation', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const waiting = runtime.getQueueSnapshot();

    expect(runtime.clearTargets(waiting.version - 1)).toMatchObject({
      outcome: 'rejected',
      reason: 'version_conflict',
    });
    const clearedWaiting = runtime.clearTargets(waiting.version);
    expect(clearedWaiting.snapshot.rows).toHaveLength(0);
    expect(runtime.clearTargets(clearedWaiting.snapshot.version).snapshot.version)
      .toBe(clearedWaiting.snapshot.version);

    runtime.enqueueTarget({ callsign: 'JA3CCC' });
    await runtime.decide([], decision());
    const active = runtime.getQueueSnapshot();
    expect(active.activeEntryId).toBeDefined();

    const clearedActive = runtime.clearTargets(active.version);
    expect(clearedActive).toMatchObject({ outcome: 'accepted' });
    expect(clearedActive.snapshot.rows).toHaveLength(0);
    expect(runtime.getSnapshot().context?.targetCallsign).toBeUndefined();
    expect(runtime.getTransmitText()).toBe('CQ BG5DRB OL32');
  });

  it('holds a failed log settlement for review and does not leak into the next target', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA -08'),
    });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    await runtime.decide([], decision());
    runtime.onTransmissionQueued(runtime.getTransmitText()!);
    const rrr = parsed('BG5DRB JA1AAA RRR', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([rrr], observation(rrr.timestamp));
    const completion = await runtime.decide([rrr], decision(2));
    expect(completion.qsoCompletion?.record.callsign).toBe('JA1AAA');

    runtime.settleQSOCompletion({
      lifecycleEpoch: completion.qsoCompletion!.lifecycleEpoch,
      recordId: completion.qsoCompletion!.record.id,
      status: 'failed',
    });
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      callsign: 'JA1AAA',
      displayState: 'review',
    });
    expect(runtime.getTransmitText()).toBeNull();
    await runtime.decide([], decision(3));
    expect(runtime.getQueueSnapshot().activeEntryId).toBe(runtime.getQueueSnapshot().rows[0]?.entryId);
  });

  it('activates a queued direct caller in the same decision that releases a completed target', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA PM95'),
    });
    await runtime.decide([], decision());
    runtime.onTransmissionQueued(runtime.getTransmitText()!);
    const roger = parsed('BG5DRB JA1AAA R-08', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([roger], observation(roger.timestamp));
    const completion = await runtime.decide([roger], decision(2));
    runtime.settleQSOCompletion({
      lifecycleEpoch: completion.qsoCompletion!.lifecycleEpoch,
      recordId: completion.qsoCompletion!.record.id,
      status: 'committed',
    });
    runtime.onTransmissionQueued(completion.transmission!);

    const final73 = parsed('BG5DRB JA1AAA 73', BASE_TIME + MODES.FT8.slotMs * 2);
    const nextCaller = parsed('BG5DRB JA2BBB -08', final73.timestamp, { snr: -15 });
    runtime.observeDecodedMessages([final73, nextCaller], observation(final73.timestamp));
    const handoff = await runtime.decide([final73, nextCaller], decision(3));

    expect(runtime.getQueueSnapshot()).toMatchObject({
      rows: [{ callsign: 'JA2BBB' }],
    });
    expect(runtime.getSnapshot().context?.targetCallsign).toBe('JA2BBB');
    expect(runtime.getSnapshot().currentState).toBe('TX3');
    expect(handoff.transmission).toBe('JA2BBB BG5DRB R-15');
    expect(handoff.requestedTransmitCycle).toBe((slotInfo(final73.timestamp).cycleNumber + 1) % 2);
  });

  it('retries final 73 after the completed row is removed without losing the next target', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const { release, releaseSlotStartMs } = await prepareFinal73Lease(runtime);
    const nextEntryId = runtime.getQueueSnapshot().activeEntryId;

    expect(release.transmission).toContain('JA2BBB');
    expect(runtime.getQueueSnapshot().rows).toMatchObject([{ callsign: 'JA2BBB' }]);

    const repeatedRR73 = parsed('BG5DRB JA1AAA RR73', releaseSlotStartMs);
    runtime.observeDecodedMessages([repeatedRR73], observation(releaseSlotStartMs));
    expect(() => structuredClone(runtime.checkpoint())).not.toThrow();
    const retry = await runtime.decide([repeatedRR73], {
      ...decision(4),
      source: 'late-decode',
      isReDecision: true,
    });

    expect(retry.transmission).toBe('JA1AAA BG5DRB 73');
    expect(retry.snapshot).toMatchObject({
      currentState: 'TX5',
      context: { targetCallsign: 'JA1AAA' },
    });
    expect(retry.snapshot.streams).toMatchObject([{
      streamId: 'stream-1',
      currentState: 'TX1',
      targetCallsign: 'JA2BBB',
    }]);
    expect(retry.qsoCompletion).toBeUndefined();
    expect(runtime.getQueueSnapshot()).toMatchObject({
      activeEntryId: nextEntryId,
      rows: [{ callsign: 'JA2BBB' }],
    });

    runtime.onTransmissionQueued(retry.transmission!);
    const nextSlotStartMs = releaseSlotStartMs + MODES.FT8.slotMs;
    runtime.observeDecodedMessages([], observation(nextSlotStartMs));
    const resumed = await runtime.decide([], decision(5));
    expect(resumed.transmission).toContain('JA2BBB');
    expect(runtime.getQueueSnapshot().activeEntryId).toBe(nextEntryId);
  });

  it('clears an unscheduled final-73 lease after the completed row is gone', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA -08'),
    });
    const first = await runtime.decide([], decision());
    runtime.onTransmissionQueued(first.transmission!);
    const rrr = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([rrr], observation(rrr.timestamp));
    const completion = await runtime.decide([rrr], decision(2));
    runtime.settleQSOCompletion({
      lifecycleEpoch: completion.qsoCompletion!.lifecycleEpoch,
      recordId: completion.qsoCompletion!.record.id,
      status: 'committed',
    });
    runtime.onTransmissionQueued(completion.transmission!);
    const releaseAt = BASE_TIME + MODES.FT8.slotMs * 2;
    runtime.observeDecodedMessages([], observation(releaseAt));
    await runtime.decide([], decision(3));
    expect(runtime.getQueueSnapshot().rows).toHaveLength(0);

    const beforeClear = runtime.getQueueSnapshot();
    const cleared = runtime.clearTargets(beforeClear.version);
    expect(cleared.snapshot.version).toBe(beforeClear.version + 1);
    const repeated = parsed('BG5DRB JA1AAA RR73', releaseAt);
    runtime.observeDecodedMessages([repeated], observation(releaseAt));
    const afterClear = await runtime.decide([repeated], decision(4));
    expect(afterClear.transmission).toBe('CQ BG5DRB OL32');
    expect(afterClear.transmission).not.toBe('JA1AAA BG5DRB 73');
  });

  it('does not let a completed target retry preempt an engaged next QSO', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const { releaseSlotStartMs } = await prepareFinal73Lease(runtime);
    const nextEntryId = runtime.getQueueSnapshot().activeEntryId;
    const nextSlotStartMs = releaseSlotStartMs + MODES.FT8.slotMs;
    const nextReport = parsed('BG5DRB JA2BBB -05', nextSlotStartMs, { snr: -7 });
    const repeatedRR73 = parsed('BG5DRB JA1AAA RR73', nextSlotStartMs);

    runtime.observeDecodedMessages([nextReport, repeatedRR73], observation(nextSlotStartMs));
    const decisionResult = await runtime.decide([nextReport, repeatedRR73], decision(4));

    expect(decisionResult.transmission).toContain('JA2BBB');
    expect(decisionResult.transmission).not.toBe('JA1AAA BG5DRB 73');
    expect(runtime.getQueueSnapshot()).toMatchObject({
      activeEntryId: nextEntryId,
      rows: [{ callsign: 'JA2BBB', displayState: 'engaged' }],
    });
  });

  it('releases a delegate completion when durable persistence merged to a different record id', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA -08'),
    });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    await runtime.decide([], decision());
    runtime.onTransmissionQueued(runtime.getTransmitText()!);
    const rrr = parsed('BG5DRB JA1AAA RRR', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([rrr], observation(rrr.timestamp));
    const completion = await runtime.decide([rrr], decision(2));
    runtime.onTransmissionQueued(completion.transmission!);

    await runtime.decide([], decision(3));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      callsign: 'JA1AAA',
      displayState: 'closing',
    });
    runtime.settleQSOCompletion({
      lifecycleEpoch: completion.qsoCompletion!.lifecycleEpoch,
      recordId: completion.qsoCompletion!.record.id,
      persistedRecordId: 'existing-merged-qso',
      status: 'committed',
    });
    expect(runtime.getQueueSnapshot()).toMatchObject({
      activeEntryId: undefined,
      rows: [{ callsign: 'JA2BBB' }],
    });
  });

  it('restores a structured-cloneable checkpoint after speculative mutations', () => {
    const { runtime } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const checkpoint = structuredClone(runtime.checkpoint());
    const before = runtime.getQueueSnapshot();

    runtime.removeTarget(before.rows[0]!.entryId, before.version);
    runtime.restore(checkpoint);
    expect(runtime.getQueueSnapshot()).toEqual(before);
  });

  it('caps non-terminal entries at 64 targets', () => {
    const { runtime, logger } = createRuntime();
    for (let index = 0; index < 64; index += 1) {
      expect(runtime.enqueueTarget({ callsign: `JA${index}AA` }).outcome).toBe('accepted');
    }
    expect(runtime.enqueueTarget({ callsign: 'JA99ZZ' })).toMatchObject({
      outcome: 'rejected',
      reason: 'queue_full',
    });
    runtime.observeDecodedMessages([
      parsed('BG5DRB K1ABC PM95'),
      parsed('BG5DRB K2ABC PM95', BASE_TIME + MODES.FT8.slotMs),
    ], observation(BASE_TIME + MODES.FT8.slotMs));
    expect(runtime.getQueueSnapshot().rows).toHaveLength(64);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
