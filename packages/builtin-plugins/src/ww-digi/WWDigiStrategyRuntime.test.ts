import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODES,
  type FrameMessage,
  type ParsedFT8Message,
  type SlotInfo,
} from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import type {
  PluginLogger,
  StrategyDecisionMetaV2,
  StrategyDecisionResult,
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import {
  WWDigiStrategyRuntime,
  type WWDigiRuntimeConfig,
  type WWDigiRuntimeOperator,
} from './WWDigiStrategyRuntime.js';

const BASE_TIME = Date.UTC(2026, 7, 29, 12, 0, 0);

function logger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function slotInfo(startMs = BASE_TIME): SlotInfo {
  return {
    id: `slot-${startMs}`,
    startMs,
    utcSeconds: Math.floor(startMs / 1_000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(startMs / MODES.FT8.slotMs) % 2,
    mode: MODES.FT8.name,
  };
}

function selected(rawMessage: string, startMs = BASE_TIME) {
  return {
    message: {
      message: rawMessage,
      snr: -10,
      dt: 0,
      freq: 1_500,
      confidence: 1,
    } as FrameMessage,
    slotInfo: slotInfo(startMs),
  };
}

function parsed(rawMessage: string, timestamp = BASE_TIME): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0,
    df: 1_500,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: `slot-${timestamp}`,
    timestamp,
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

function createRuntime(options: {
  transmitting?: boolean;
  parallelStreams?: number;
  maxAttempts?: number;
  streamLimit?: number;
  authorizedStaleReceiveCycles?: number;
  cqMaxAttempts?: number;
  cqSelectionPolicy?: WWDigiRuntimeConfig['cqSelectionPolicy'];
  workedCallsigns?: string[];
  busyCallsigns?: string[];
  transmitBlocked?: boolean;
} = {}) {
  let transmitting = options.transmitting ?? false;
  const busy = new Set((options.busyCallsigns ?? []).map((callsign) => callsign.toUpperCase()));
  const worked = new Set((options.workedCallsigns ?? []).map((callsign) => callsign.toUpperCase()));
  const config: WWDigiRuntimeConfig = {
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    frequency: 1_500,
    modeName: 'FT8',
    slotMs: MODES.FT8.slotMs,
    transmitCycles: [0],
    parallelStreams: options.parallelStreams ?? 1,
    maxConcurrentStreams: options.streamLimit ?? 3,
    maxAttempts: options.maxAttempts ?? 5,
    authorizedStaleReceiveCycles: options.authorizedStaleReceiveCycles,
    cqMaxAttempts: options.cqMaxAttempts ?? 6,
    cqSelectionPolicy: options.cqSelectionPolicy ?? 'MAX_DISTANCE',
  };
  const operator: WWDigiRuntimeOperator = {
    get config() { return config; },
    get isTransmitting() { return transmitting; },
    isTargetBeingWorkedByOthers: vi.fn((callsign: string) => busy.has(callsign.toUpperCase())),
    hasWorkedCallsign: vi.fn(async (callsign: string) => worked.has(callsign.toUpperCase())),
  };
  return {
    runtime: new WWDigiStrategyRuntime(operator, logger(), () => [
      config.frequency - 300,
      config.frequency,
      config.frequency + 300,
    ], undefined, () => options.transmitBlocked
      ? { transmitGate: { allowed: false, reason: 'confirmSettings' } }
      : {}),
    setTransmitting(value: boolean) { transmitting = value; },
    config,
  };
}

describe('WW Digi strategy transmit gate', () => {
  it('stops an already armed operator when the plugin-owned gate becomes active', async () => {
    const { runtime } = createRuntime({ transmitting: true, transmitBlocked: true });
    const result = await runtime.decide([], decision());
    expect(result.stop).toBe(true);
    expect(result.transmissions).toEqual([]);
    expect(result.snapshot.transmitGate).toEqual({ allowed: false, reason: 'confirmSettings' });
  });
});

let physicalRevision = 0;

function confirmTransmissions(
  runtime: WWDigiStrategyRuntime,
  result: StrategyDecisionResult,
  onlyStreamId?: string,
): StreamPhysicalReceipt[] {
  const receipts = (result.transmissions ?? [])
    .filter((transmission) => !onlyStreamId || transmission.streamId === onlyStreamId)
    .map((transmission) => ({
      ...transmission,
      frameId: `frame-${++physicalRevision}`,
      revision: physicalRevision,
      physicalConfirmed: true as const,
    }));
  runtime.onTransmissionsCompleted(receipts);
  return receipts;
}

async function activateInbound(
  runtime: WWDigiStrategyRuntime,
  callsign: string,
  grid: string,
  epoch = 1,
): Promise<StrategyDecisionResult> {
  runtime.enqueueTarget({
    callsign,
    lastMessage: selected(`BG5DRB ${callsign} ${grid}`),
  });
  return runtime.decide([], decision(epoch));
}

describe('WWDigiStrategyRuntime manual queue policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    physicalRevision = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps manual targets queued until the operator enables TX', async () => {
    const { runtime, setTransmitting } = createRuntime();
    const mutation = runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('CQ WW JA1AAA PM95'),
    });

    expect(mutation.outcome).toBe('accepted');
    expect(mutation.snapshot.activeEntryIds).toEqual([]);
    expect(runtime.getTransmissions()).toEqual([]);
    expect((await runtime.decide([], decision())).transmissions).toEqual([]);

    setTransmitting(true);
    const started = await runtime.decide([], decision(2));
    expect(started.transmissions).toEqual([{
      streamId: 'stream-1',
      text: 'JA1AAA BG5DRB OL32',
      audioFrequencyHz: 1_200,
    }]);
    expect(runtime.getQueueSnapshot().activeEntryIds).toEqual(['ww-digi-1']);
  });

  it('starts three manually authorized targets in parallel', async () => {
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 3 });
    for (const callsign of ['JA1AAA', 'JA2BBB', 'JA3CCC']) {
      expect(runtime.enqueueTarget({ callsign }).outcome).toBe('accepted');
    }

    setTransmitting(true);
    const result = await runtime.decide([], decision());
    expect(result.transmissions).toEqual([
      { streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_200 },
      { streamId: 'stream-2', text: 'JA2BBB BG5DRB OL32', audioFrequencyHz: 1_500 },
      { streamId: 'stream-3', text: 'JA3CCC BG5DRB OL32', audioFrequencyHz: 1_800 },
    ]);
    expect(result.snapshot.streams).toHaveLength(3);
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(3);
  });

  it('keeps the requested count while the Host forces one active contest stream', async () => {
    const { runtime, setTransmitting, config } = createRuntime({ parallelStreams: 3, streamLimit: 1 });
    for (const callsign of ['JA1AAA', 'JA2BBB', 'JA3CCC']) runtime.enqueueTarget({ callsign });
    setTransmitting(true);

    expect((await runtime.decide([], decision())).transmissions).toHaveLength(1);
    expect(runtime.getQueueSnapshot()).toMatchObject({
      maxActiveStreams: 1,
      requestedMaxActiveStreams: 3,
    });

    config.maxConcurrentStreams = 3;
    expect((await runtime.decide([], decision(2))).transmissions).toHaveLength(3);
  });

  it('switches one lane to an exposed protocol state and rejects a stale lifecycle', async () => {
    const { runtime, setTransmitting } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    setTransmitting(true);
    await runtime.decide([], decision());
    const stream = runtime.getSnapshot().streams?.[0];

    expect(stream?.stateOptions?.map((option) => option.id)).toEqual([
      'wait-r-grid',
      'wait-rr73',
      'wait-standard-final',
      'send-rr73',
    ]);
    runtime.setStreamState({
      streamId: stream!.streamId,
      stateId: 'send-rr73',
      expectedLifecycleEpoch: stream!.qsoLifecycleEpoch,
    });
    expect(runtime.getSnapshot().streams?.[0]).toMatchObject({ currentState: 'send-rr73' });
    expect(runtime.getTransmissions()).toEqual([{
      streamId: 'stream-1',
      text: 'JA1AAA BG5DRB RR73',
      audioFrequencyHz: 1_200,
    }]);
    expect(() => runtime.setStreamState({
      streamId: stream!.streamId,
      stateId: 'wait-r-grid',
      expectedLifecycleEpoch: stream!.qsoLifecycleEpoch + 1,
    })).toThrow('stream_lifecycle_conflict');
  });

  it('keeps stable stream identities while following an operator frequency change', async () => {
    const { runtime, setTransmitting, config } = createRuntime();
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    setTransmitting(true);
    const started = await runtime.decide([], decision());
    expect(started.transmissions?.[0]).toMatchObject({ streamId: 'stream-1', audioFrequencyHz: 1_200 });

    config.frequency = 1_700;
    expect(runtime.getTransmissions()[0]).toMatchObject({ streamId: 'stream-1', audioFrequencyHz: 1_400 });
  });

  it('does not automatically admit an inbound caller', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const caller = parsed('BG5DRB JA1AAA PM95');

    expect(runtime.observeDecodedMessages([caller], observation())).toBe(false);
    const result = await runtime.decide([caller], decision());
    expect(runtime.getQueueSnapshot().rows).toEqual([]);
    expect(result.transmissions).toEqual([]);
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    expect(runtime.getTransmissions()).toEqual([{
      streamId: 'cq',
      text: 'CQ WW BG5DRB OL32',
      audioFrequencyHz: 1_500,
    }]);
  });

  it('does not turn an expired authorized target into a new CQ session', async () => {
    const { runtime } = createRuntime({ transmitting: true, authorizedStaleReceiveCycles: 1 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });

    expect(runtime.getTransmissions()).toEqual([]);

    runtime.observeDecodedMessages([], observation());
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({ displayState: 'paused', pauseReason: 'stale' });
    expect(runtime.getTransmissions()).toEqual([]);
    expect((await runtime.decide([], decision())).stop).toBe(true);
  });

  it('collects a CQ pile-up, auto-authorizes three, and retains overflow candidates', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true, parallelStreams: 3, cqSelectionPolicy: 'FIRST' });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    const cq = await runtime.decide([], decision());
    confirmTransmissions(runtime, cq);

    const callers = ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD', 'JA5EEE'].map((callsign, index) => (
      parsed(`BG5DRB ${callsign} PM9${index}`, BASE_TIME + MODES.FT8.slotMs)
    ));
    runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
    const selected = await runtime.decide(callers, decision(2));

    expect(selected.requestedTransmitCycle).toBe(0);
    expect(selected.transmissions).toHaveLength(3);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.displayState)).toEqual([
      'engaged', 'engaged', 'engaged', 'candidate', 'candidate',
    ]);
    setTransmitting(false);
    const queue = runtime.getQueueSnapshot();
    const candidate = queue.rows.find((row) => row.displayState === 'candidate')!;
    const authorized = await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: candidate.entryId, queueVersion: queue.version },
      actionId: 'authorize-target',
    });
    expect(authorized).toMatchObject({ requestOperatorStart: true, requestDecision: true });
    expect(runtime.getQueueSnapshot().rows.find((row) => row.entryId === candidate.entryId))
      .toMatchObject({ displayState: 'authorized' });
  });

  it('keeps dupes as candidates but excludes them from automatic CQ selection', async () => {
    const { runtime } = createRuntime({
      transmitting: true, parallelStreams: 2, cqSelectionPolicy: 'FIRST', workedCallsigns: ['JA1AAA'],
    });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    confirmTransmissions(runtime, await runtime.decide([], decision()));
    const callers = [
      parsed('BG5DRB JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs),
      parsed('BG5DRB JA2BBB PM96', BASE_TIME + MODES.FT8.slotMs),
    ];
    runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
    const selected = await runtime.decide(callers, decision(2));
    expect(selected.transmissions?.map((item) => item.text)).toEqual(['JA2BBB BG5DRB R OL32']);
    expect(runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA1AAA'))
      .toMatchObject({ displayState: 'dupe' });
  });

  it('uses the same CQ authorization to fill an empty slot from a late decode', async () => {
    const { runtime } = createRuntime({ transmitting: true, parallelStreams: 3, cqSelectionPolicy: 'FIRST' });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    confirmTransmissions(runtime, await runtime.decide([], decision()));
    const first = parsed('BG5DRB JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([first], observation(BASE_TIME + MODES.FT8.slotMs));
    expect((await runtime.decide([first], decision(2))).transmissions).toHaveLength(1);

    const late = parsed('BG5DRB JA2BBB PM96', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([late], observation(BASE_TIME + MODES.FT8.slotMs));
    expect((await runtime.decide([late], { ...decision(3), source: 'late-decode', isReDecision: true })).transmissions)
      .toHaveLength(2);
  });

  it('stops after the configured number of physically completed unanswered CQs', async () => {
    const { runtime } = createRuntime({ transmitting: true, cqMaxAttempts: 2 });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    const first = await runtime.decide([], decision());
    confirmTransmissions(runtime, first);
    const second = await runtime.decide([], decision(2));
    confirmTransmissions(runtime, second);
    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs));
    const stopped = await runtime.decide([], decision(3));
    expect(stopped.stop).toBe(true);
    expect(stopped.snapshot.attentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cq-no-response', params: { count: 2 } }),
    ]));
  });
});

describe('WWDigiStrategyRuntime protocol flows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    physicalRevision = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes the outbound grid, R-grid, RR73 sequence after physical TX', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA', lastMessage: selected('CQ WW JA1AAA PM95') });

    const grid = await runtime.decide([], decision());
    expect(grid.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB OL32');
    confirmTransmissions(runtime, grid);

    const rogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([rogerGrid], observation(rogerGrid.timestamp));
    const rr73 = await runtime.decide([rogerGrid], decision(2));
    expect(rr73.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB RR73');
    expect(rr73.qsoCompletions).toEqual([]);
    confirmTransmissions(runtime, rr73);

    const completion = await runtime.decide([], decision(3));
    expect(completion.qsoCompletions).toHaveLength(1);
    expect(completion.qsoCompletions?.[0]).toMatchObject({
      streamId: 'stream-1',
      persistencePolicy: 'preserve-distinct',
      record: {
        callsign: 'JA1AAA',
        grid: 'PM95',
        contestId: 'WW-DIGI',
        messageHistory: [
          'CQ WW JA1AAA PM95',
          'JA1AAA BG5DRB OL32',
          'BG5DRB JA1AAA R PM95',
          'JA1AAA BG5DRB RR73',
        ],
      },
    });
  });

  it('manually answers an inbound grid and completes when RR73 is received', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const response = await activateInbound(runtime, 'JA1AAA', 'PM95');
    expect(response.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB R OL32');
    confirmTransmissions(runtime, response);

    const rr73 = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([rr73], observation(rr73.timestamp));
    const completion = await runtime.decide([rr73], decision(2));

    expect(completion.transmissions).toEqual([]);
    expect(completion.qsoCompletions?.[0]?.record).toMatchObject({
      callsign: 'JA1AAA',
      grid: 'PM95',
      contestId: 'WW-DIGI',
      messageHistory: [
        'BG5DRB JA1AAA PM95',
        'JA1AAA BG5DRB R OL32',
        'BG5DRB JA1AAA RR73',
      ],
    });
  });

  it('logs a manually selected standard report exchange without inventing a grid', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA -08'),
    });

    const rogerReport = await runtime.decide([], decision());
    expect(rogerReport.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB R-10');
    confirmTransmissions(runtime, rogerReport);

    const rr73 = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completion = await runtime.decide([rr73], decision(2));
    expect(completion.qsoCompletions?.[0]?.record).toMatchObject({
      callsign: 'JA1AAA',
      contestId: 'WW-DIGI',
      messageHistory: [
        'BG5DRB JA1AAA -08',
        'JA1AAA BG5DRB R-10',
        'BG5DRB JA1AAA RR73',
      ],
    });
    expect(completion.qsoCompletions?.[0]?.record.grid).toBeUndefined();
  });

  it('requires an explicit RR73 recovery action when the target repeats R-grid', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const grid = await runtime.decide([], decision());
    confirmTransmissions(runtime, grid);

    const rogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    const rr73 = await runtime.decide([rogerGrid], decision(2));
    confirmTransmissions(runtime, rr73);
    const completion = await runtime.decide([], decision(3));
    expect(completion.qsoCompletions).toHaveLength(1);
    const effect = completion.qsoCompletions![0]!;
    runtime.settleQSOCompletion({
      streamId: effect.streamId,
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      status: 'committed',
    });
    expect((await runtime.decide([], decision(4))).stop).toBe(true);
    setTransmitting(false);

    const repeated = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs * 2);
    expect(runtime.observeDecodedMessages([repeated], observation(repeated.timestamp))).toBe(true);
    expect(runtime.getTransmissions()).toEqual([]);
    const stream = runtime.getSnapshot().streams![0]!;
    expect(stream.attentions?.map((attention) => attention.id)).toContain('repeated-exchange');

    const recoveryAction = await runtime.invokeAction({
      target: { kind: 'stream', streamId: stream.streamId, lifecycleEpoch: stream.qsoLifecycleEpoch },
      actionId: 'resend-rr73',
    });
    expect(recoveryAction).toMatchObject({ requestDecision: true, requestOperatorStart: true });
    setTransmitting(true);
    expect((await runtime.decide([], decision(5))).transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB RR73', audioFrequencyHz: 1_200,
    }]);
  });

  it('keeps a completed inbound lane controllable when RR73 is repeated', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, started);
    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    const effect = completed.qsoCompletions![0]!;
    runtime.settleQSOCompletion({
      streamId: effect.streamId,
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      status: 'committed',
    });
    const stopped = await runtime.decide([], decision(3));
    expect(stopped.stop).toBe(true);
    expect(stopped.transmissions).toEqual([]);
    expect(stopped.snapshot.streams?.[0]).toMatchObject({
      currentState: 'final-retry',
      attentions: [{ id: 'completion-recovery-observing' }],
      completion: { state: 'committed' },
    });
    setTransmitting(false);

    const repeated = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs * 2);
    runtime.observeDecodedMessages([repeated], observation(repeated.timestamp));
    const stream = runtime.getSnapshot().streams![0]!;
    expect(stream.attentions?.map((attention) => attention.id)).toContain('repeated-final');
    expect(stream.actions?.map((action) => action.id)).toContain('send-73-once');

    const recoveryAction = await runtime.invokeAction({
      target: { kind: 'stream', streamId: stream.streamId, lifecycleEpoch: stream.qsoLifecycleEpoch },
      actionId: 'send-73-once',
    });
    expect(recoveryAction).toMatchObject({ requestDecision: true, requestOperatorStart: true });
    expect(runtime.getTransmissions()).toEqual([]);

    setTransmitting(true);
    const recovery = await runtime.decide([], decision(4));
    expect(recovery.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB 73', audioFrequencyHz: 1_200,
    }]);
    confirmTransmissions(runtime, recovery);
    expect((await runtime.decide([], decision(5))).stop).toBe(true);
  });

  it('allows a new explicit CQ session while passive recovery remains observable', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, started);
    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    const effect = completed.qsoCompletions![0]!;
    runtime.settleQSOCompletion({
      streamId: effect.streamId,
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      status: 'committed',
    });
    expect((await runtime.decide([], decision(3))).stop).toBe(true);

    setTransmitting(false);
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'cq-repeat' });
    setTransmitting(true);
    const restarted = await runtime.decide([], decision(4));

    expect(restarted.transmissions).toEqual([{
      streamId: 'cq', text: 'CQ WW BG5DRB OL32', audioFrequencyHz: 1_500,
    }]);
    expect(restarted.snapshot.streams?.[0]?.currentState).toBe('final-retry');
  });

  it.each(['RRR', '73'])('accepts %s as a standard final acknowledgement', async (suffix) => {
    const { runtime } = createRuntime({ transmitting: true });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, started);
    const final = parsed(`BG5DRB JA1AAA ${suffix}`, BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    expect(completed.qsoCompletions).toHaveLength(1);
  });

  it('does not log a manually selected RR73 without a directed reply', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const started = await runtime.decide([], decision());
    confirmTransmissions(runtime, started);
    const stream = runtime.getSnapshot().streams![0]!;
    runtime.setStreamState({
      streamId: stream.streamId,
      stateId: 'send-rr73',
      expectedLifecycleEpoch: stream.qsoLifecycleEpoch,
    });
    confirmTransmissions(runtime, { ...started, transmissions: runtime.getTransmissions() });
    expect((await runtime.decide([], decision(2))).qsoCompletions).toEqual([]);
  });

  it('allows an explicit log action after a directed exchange', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    await activateInbound(runtime, 'JA1AAA', 'PM95');
    const stream = runtime.getSnapshot().streams![0]!;
    const result = await runtime.invokeAction({
      target: { kind: 'stream', streamId: stream.streamId, lifecycleEpoch: stream.qsoLifecycleEpoch },
      actionId: 'log-current',
    });
    expect(result?.qsoCompletions?.[0]?.record).toMatchObject({ callsign: 'JA1AAA', grid: 'PM95' });
  });

  it('reports the actual timeout stage and keeps the target retryable', async () => {
    const { runtime } = createRuntime({ transmitting: true, maxAttempts: 1 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const call = await runtime.decide([], decision());
    confirmTransmissions(runtime, call);

    const timedOut = await runtime.decide([], decision(2));
    expect(timedOut.qsoFailures).toEqual([{
      targetCallsign: 'JA1AAA',
      reason: 'ww_digi_no_response',
      stage: 'wait-r-grid',
      unansweredTransmissions: 1,
      hadTargetReply: false,
    }]);
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      callsign: 'JA1AAA',
      displayState: 'no-response',
    });
    expect(timedOut.transmissions).toEqual([]);
  });
});

describe('WWDigiStrategyRuntime settlement and refill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    physicalRevision = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles one inbound QSO and continuously refills its released lane', async () => {
    const { runtime } = createRuntime({ transmitting: true, parallelStreams: 3 });
    for (const [callsign, grid] of [
      ['JA1AAA', 'PM95'],
      ['JA2BBB', 'PM96'],
      ['JA3CCC', 'PM97'],
      ['JA4DDD', 'PM98'],
    ] as const) {
      runtime.enqueueTarget({ callsign, lastMessage: selected(`BG5DRB ${callsign} ${grid}`) });
    }
    const started = await runtime.decide([], decision());
    expect(started.transmissions).toHaveLength(3);
    confirmTransmissions(runtime, started);

    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    const effect = completed.qsoCompletions?.[0];
    expect(effect).toBeDefined();
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'committed',
    });

    const refilled = await runtime.decide([], decision(3));
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(3);
    expect(refilled.snapshot.streams?.some((stream) => stream.currentState === 'final-retry')).toBe(false);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual([
      'JA4DDD',
      'JA2BBB',
      'JA3CCC',
    ]);
    expect(refilled.transmissions?.find((item) => item.streamId === 'stream-1')).toMatchObject({
      text: 'JA4DDD BG5DRB R OL32',
    });
  });

  it('projects a failed settlement as review without re-emitting completion', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, started);
    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    const effect = completed.qsoCompletions?.[0];
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'failed',
    });

    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'review',
      tone: 'danger',
    });

    const reviewed = await runtime.decide([], decision(3));
    expect(reviewed.qsoCompletions).toEqual([]);
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      displayState: 'review',
      tone: 'danger',
    });
    expect(reviewed.transmissions).toEqual([]);
  });
});
