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

function selected(rawMessage: string, startMs = BASE_TIME + MODES.FT8.slotMs) {
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
  replaceQueueOnManualTarget?: boolean;
  workedCallsigns?: string[];
  busyCallsigns?: string[];
  transmitBlocked?: boolean;
  sessionId?: string;
  practiceAvailable?: boolean;
} = {}) {
  let transmitting = options.transmitting ?? false;
  const busy = new Set((options.busyCallsigns ?? []).map((callsign) => callsign.toUpperCase()));
  const worked = new Set((options.workedCallsigns ?? []).map((callsign) => callsign.toUpperCase()));
  const config: WWDigiRuntimeConfig = {
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    frequency: 1_500,
    modeName: 'FT8',
    contestYear: 2026,
    operatorId: 'operator-0',
    transmitterId: 1,
    slotMs: MODES.FT8.slotMs,
    transmitCycles: [0],
    parallelStreams: options.parallelStreams ?? 1,
    maxConcurrentStreams: options.streamLimit ?? 3,
    maxAttempts: options.maxAttempts ?? 5,
    authorizedStaleReceiveCycles: options.authorizedStaleReceiveCycles,
    cqMaxAttempts: options.cqMaxAttempts ?? 6,
    cqSelectionPolicy: options.cqSelectionPolicy ?? 'MAX_DISTANCE',
    replaceQueueOnManualTarget: options.replaceQueueOnManualTarget ?? false,
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
      : {}, () => options.sessionId
      ? { kind: 'plugin-session', sessionId: options.sessionId }
      : undefined, options.practiceAvailable ? {
        canStart: () => true,
        sessionKey: 'practice:operator-0',
        title: 'WW Digi Practice',
      } : undefined),
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

describe('WW Digi practice transaction state', () => {
  it('keeps practice indexes inside the runtime checkpoint', async () => {
    const { runtime } = createRuntime({ practiceAvailable: true });
    const before = runtime.checkpoint();

    await expect(runtime.invokeAction({
      target: { kind: 'runtime' }, actionId: 'start-practice',
    })).resolves.toMatchObject({
      requestDecision: true,
      logbookSessionEffects: [{ operation: 'open', sessionKey: 'practice:operator-0' }],
    });
    expect(runtime.isPracticeEnabled()).toBe(true);
    expect(runtime.getPracticeOperatingIndex()).toMatchObject({ revision: 0, workedByBand: {} });

    runtime.restore(before);
    expect(runtime.isPracticeEnabled()).toBe(false);
    expect(runtime.getPracticeOperatingIndex()).toBeUndefined();
  });

  it('marks practice ownership in the same completion envelope', async () => {
    const { runtime } = createRuntime({
      transmitting: true,
      sessionId: 'practice-session',
      practiceAvailable: true,
    });
    await runtime.invokeAction({ target: { kind: 'runtime' }, actionId: 'start-practice' });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, started);

    const completed = await runtime.decide([
      parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs),
    ], decision(2));

    expect(completed.qsoCompletions?.[0]).toMatchObject({
      destination: { kind: 'plugin-session', sessionId: 'practice-session' },
      record: {
        contestEntry: {
          editionId: 'ww-digi-2026',
          rulesetVersion: 'tx5dr-ww-digi-v1',
          annotations: {
            operatorId: 'operator-0',
            transmitterId: 1,
            practice: true,
          },
        },
      },
    });
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

async function activateCqBatch(
  runtime: WWDigiStrategyRuntime,
  setTransmitting: (value: boolean) => void,
  callsigns: readonly string[],
  epoch = 1,
): Promise<StrategyDecisionResult> {
  setTransmitting(true);
  confirmTransmissions(runtime, await runtime.decide([], decision(epoch)));
  const callers = callsigns.map((callsign, index) => (
    parsed(`BG5DRB ${callsign} PM9${index}`, BASE_TIME + MODES.FT8.slotMs)
  ));
  runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
  return runtime.decide(callers, decision(epoch + 1));
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
    expect(mutation.requestOperatorStart).toBeUndefined();
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

  it('does not clear the existing target when the replacement is invalid', () => {
    const { runtime } = createRuntime({ replaceQueueOnManualTarget: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });

    expect(runtime.enqueueTarget({ callsign: 'BG5DRB' })).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid_target',
    });
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA1AAA']);
  });

  it('keeps appending manual targets when replacement is disabled', async () => {
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 3 });
    for (const callsign of ['JA1AAA', 'JA2BBB', 'JA3CCC']) runtime.enqueueTarget({ callsign });
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual([
      'JA1AAA', 'JA2BBB', 'JA3CCC',
    ]);

    setTransmitting(true);
    expect((await runtime.decide([], decision())).transmissions).toHaveLength(3);
  });

  it('replaces all previous manual targets with the latest double-click target', async () => {
    const { runtime, setTransmitting } = createRuntime({
      parallelStreams: 3,
      replaceQueueOnManualTarget: true,
    });
    for (const callsign of ['JA1AAA', 'JA2BBB', 'JA3CCC']) {
      expect(runtime.enqueueTarget({ callsign }).outcome).toBe('accepted');
    }

    setTransmitting(true);
    const result = await runtime.decide([], decision());
    expect(result.transmissions).toEqual([
      { streamId: 'stream-1', text: 'JA3CCC BG5DRB OL32', audioFrequencyHz: 1_200 },
    ]);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA3CCC']);
  });

  it('replaces active lanes while preserving their late-final logging evidence', async () => {
    const { runtime, setTransmitting } = createRuntime({
      parallelStreams: 3,
      cqSelectionPolicy: 'FIRST',
      replaceQueueOnManualTarget: true,
    });
    const active = await activateCqBatch(runtime, setTransmitting, ['JA1AAA', 'JA2BBB', 'JA3CCC']);
    confirmTransmissions(runtime, active);

    expect(runtime.enqueueTarget({ callsign: 'JA4DDD' })).toMatchObject({
      outcome: 'accepted',
      requestOperatorStart: true,
    });
    const replacement = await runtime.decide([], decision(3));
    expect(replacement.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA4DDD BG5DRB OL32', audioFrequencyHz: 1_200,
    }]);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA4DDD']);

    const lateFinal = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs * 2);
    runtime.observeDecodedMessages([lateFinal], observation(lateFinal.timestamp));
    const recovered = await runtime.decide([lateFinal], decision(4));
    expect(recovered.qsoCompletions?.map((effect) => effect.record.callsign)).toEqual(['JA1AAA']);
    expect(recovered.transmissions?.[0]?.text).toBe('JA4DDD BG5DRB OL32');
  });

  it('keeps the requested count while the Host forces one active contest stream', async () => {
    const { runtime, setTransmitting, config } = createRuntime({ parallelStreams: 3, streamLimit: 1 });
    expect((await activateCqBatch(runtime, setTransmitting, ['JA1AAA', 'JA2BBB', 'JA3CCC'])).transmissions)
      .toHaveLength(1);
    expect(runtime.getQueueSnapshot()).toMatchObject({
      maxActiveStreams: 1,
      requestedMaxActiveStreams: 3,
    });

    config.maxConcurrentStreams = 3;
    for (let expected = 2; expected <= 3; expected += 1) {
      const queue = runtime.getQueueSnapshot();
      const candidate = queue.rows.find((row) => row.displayState === 'candidate')!;
      await runtime.invokeAction({
        target: { kind: 'queue-entry', entryId: candidate.entryId, queueVersion: queue.version },
        actionId: 'authorize-target',
      });
      expect((await runtime.decide([], decision(expected + 1))).transmissions).toHaveLength(expected);
    }
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

  it('arms one bounded CQ session from an empty-queue TX rising edge', async () => {
    const { runtime, setTransmitting } = createRuntime();
    expect(runtime.getSnapshot().actions).toBeUndefined();
    expect((await runtime.decide([], decision())).transmissions).toEqual([]);

    setTransmitting(true);
    const started = await runtime.decide([], decision(2));

    expect(started.transmissions).toEqual([{
      streamId: 'cq',
      text: 'CQ WW BG5DRB OL32',
      audioFrequencyHz: 1_500,
    }]);
  });

  it('does not treat runtime creation during active TX as a new operator authorization', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    const decisionResult = await runtime.decide([], decision());

    expect(decisionResult.transmissions).toEqual([]);
    expect(decisionResult.stop).toBe(true);
  });

  it('does not automatically admit an inbound caller', async () => {
    const { runtime, setTransmitting } = createRuntime();
    const caller = parsed('BG5DRB JA1AAA PM95');

    expect(runtime.observeDecodedMessages([caller], observation())).toBe(false);
    setTransmitting(true);
    const result = await runtime.decide([caller], decision());
    expect(runtime.getQueueSnapshot().rows).toEqual([]);
    expect(result.transmissions).toEqual([{
      streamId: 'cq',
      text: 'CQ WW BG5DRB OL32',
      audioFrequencyHz: 1_500,
    }]);
  });

  it('does not turn an expired authorized target into a new CQ session', async () => {
    const { runtime, setTransmitting } = createRuntime({ authorizedStaleReceiveCycles: 1 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    setTransmitting(true);

    expect(runtime.getTransmissions()).toEqual([]);

    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({ displayState: 'paused', pauseReason: 'stale' });
    expect(runtime.getTransmissions()).toEqual([]);
    expect((await runtime.decide([], decision())).stop).toBe(true);

    setTransmitting(false);
    const queue = runtime.getQueueSnapshot();
    expect(await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: queue.rows[0]!.entryId, queueVersion: queue.version },
      actionId: 'reauthorize-target',
    })).toMatchObject({ requestDecision: true, requestOperatorStart: true });
    setTransmitting(true);
    expect((await runtime.decide([], decision(2))).transmissions).toHaveLength(1);
  });

  it('counts each chronological receive slot once for authorization expiry', () => {
    const { runtime, setTransmitting } = createRuntime({ authorizedStaleReceiveCycles: 2 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    setTransmitting(true);

    runtime.observeDecodedMessages([], observation(BASE_TIME));
    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs));
    runtime.observeDecodedMessages([], {
      ...observation(BASE_TIME + MODES.FT8.slotMs),
      source: 'late-decode',
    });
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({ displayState: 'authorized' });

    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs * 3));
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({ displayState: 'paused', pauseReason: 'stale' });
  });

  it('collects a CQ pile-up, auto-authorizes three, and retains overflow candidates', async () => {
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 3, cqSelectionPolicy: 'FIRST' });
    setTransmitting(true);
    const cq = await runtime.decide([], decision());
    confirmTransmissions(runtime, cq);

    const callers = ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD', 'JA5EEE'].map((callsign, index) => (
      parsed(`BG5DRB ${callsign} PM9${index}`, BASE_TIME + MODES.FT8.slotMs)
    ));
    runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
    const selected = await runtime.decide(callers, decision(2));

    expect(selected.requestedTransmitCycle).toBeUndefined();
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

  it('fills additional lanes as individual candidates are authorized', async () => {
    const { runtime, setTransmitting, config } = createRuntime({
      parallelStreams: 3,
      streamLimit: 1,
      cqSelectionPolicy: 'FIRST',
    });
    setTransmitting(true);
    confirmTransmissions(runtime, await runtime.decide([], decision()));
    const callers = ['JA1AAA', 'JA2BBB', 'JA3CCC'].map((callsign, index) => (
      parsed(`BG5DRB ${callsign} PM9${index}`, BASE_TIME + MODES.FT8.slotMs)
    ));
    runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
    expect((await runtime.decide(callers, decision(2))).transmissions).toHaveLength(1);

    config.maxConcurrentStreams = 3;
    for (const expectedCount of [2, 3]) {
      const queue = runtime.getQueueSnapshot();
      const candidate = queue.rows.find((row) => row.displayState === 'candidate')!;
      expect(await runtime.invokeAction({
        target: { kind: 'queue-entry', entryId: candidate.entryId, queueVersion: queue.version },
        actionId: 'authorize-target',
      })).toMatchObject({ requestDecision: true, requestOperatorStart: false });
      expect((await runtime.decide([], decision(expectedCount + 1))).transmissions).toHaveLength(expectedCount);
    }
  });

  it('refreshes a waiting target cycle from its latest complete decode', async () => {
    const { runtime, setTransmitting } = createRuntime();
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('CQ WW JA1AAA PM95', BASE_TIME),
    });
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({ lastHeardCycle: 0 });

    const moved = parsed('CQ WW JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs);
    const realSlotObservation = observation(moved.timestamp);
    realSlotObservation.slotInfo.cycleNumber = Math.floor(moved.timestamp / MODES.FT8.slotMs);
    expect(realSlotObservation.slotInfo.cycleNumber).toBeGreaterThan(1);
    runtime.observeDecodedMessages([moved], realSlotObservation);
    expect(runtime.getQueueSnapshot().rows[0]).toMatchObject({
      lastHeardCycle: 1,
      displayState: 'authorized',
    });

    setTransmitting(true);
    const selectedTarget = await runtime.decide([], decision());
    expect(selectedTarget.requestedTransmitCycle).toBe(0);
    expect(selectedTarget.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB OL32');
  });

  it('replaces the active workset and follows the latest target cycle while TX is enabled', async () => {
    const { runtime } = createRuntime({
      transmitting: true,
      parallelStreams: 3,
      replaceQueueOnManualTarget: true,
    });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('CQ WW JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs),
    });
    runtime.enqueueTarget({
      callsign: 'JA2BBB',
      lastMessage: selected('CQ WW JA2BBB PM96', BASE_TIME),
    });

    const selectedBatch = await runtime.decide([], decision());
    expect(selectedBatch.requestedTransmitCycle).toBe(1);
    expect(selectedBatch.transmissions?.map((item) => item.text)).toEqual(['JA2BBB BG5DRB OL32']);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA2BBB']);
  });

  it('parks the active QSO when changing cycle and resumes it without losing protocol state', async () => {
    const { runtime, setTransmitting, config } = createRuntime({
      parallelStreams: 1,
      cqSelectionPolicy: 'FIRST',
    });
    setTransmitting(true);
    confirmTransmissions(runtime, await runtime.decide([], decision()));
    const callers = [
      parsed('BG5DRB JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs),
      parsed('BG5DRB JA2BBB PM96', BASE_TIME + MODES.FT8.slotMs),
    ];
    runtime.observeDecodedMessages(callers, observation(BASE_TIME + MODES.FT8.slotMs));
    await runtime.decide(callers, decision(2));

    const active = runtime.getSnapshot().streams?.[0];
    expect(active).toMatchObject({ targetCallsign: 'JA1AAA', currentState: 'wait-rr73' });
    confirmTransmissions(runtime, await runtime.decide([], decision(3)));

    const moved = parsed('BG5DRB JA2BBB PM96', BASE_TIME + MODES.FT8.slotMs * 2);
    runtime.observeDecodedMessages([moved], observation(moved.timestamp));
    config.transmitCycles = [1];
    expect(runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0],
      transmitCycles: [1],
      source: 'manual',
    })).toBe(true);
    expect(runtime.getTransmissions()).toEqual([]);
    expect(runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA1AAA')).toMatchObject({
      displayState: 'paused',
      actions: [expect.objectContaining({ id: 'end-queued-target' })],
    });

    const switched = await runtime.decide([], decision(4));
    expect(switched.transmissions?.map((item) => item.text)).toEqual(['JA2BBB BG5DRB R OL32']);
    expect(runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA2BBB'))
      .toMatchObject({ displayState: 'engaged', lastHeardCycle: 0 });

    config.transmitCycles = [0];
    expect(runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [1],
      transmitCycles: [0],
      source: 'manual',
    })).toBe(true);
    const resumed = await runtime.decide([], decision(5));
    expect(resumed.transmissions?.map((item) => item.text)).toEqual(['JA1AAA BG5DRB R OL32']);
    expect(resumed.snapshot.streams?.[0]).toMatchObject({
      targetCallsign: 'JA1AAA',
      currentState: 'wait-rr73',
      qsoLifecycleEpoch: active!.qsoLifecycleEpoch,
    });
    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs * 3);
    runtime.observeDecodedMessages([final], observation(final.timestamp));
    const completion = await runtime.decide([final], decision(6));
    expect(completion.qsoCompletions?.[0]?.record.messageHistory).toEqual([
      'BG5DRB JA1AAA PM95',
      'JA1AAA BG5DRB R OL32',
      'BG5DRB JA1AAA RR73',
    ]);
  });

  it('keeps observing a parked QSO without transmitting and resumes it on the matching cycle', async () => {
    const { runtime, config } = createRuntime({ transmitting: true });
    const started = await activateInbound(runtime, 'JA1AAA', 'PM95');
    expect(started.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB R OL32');

    config.transmitCycles = [1];
    expect(runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    })).toBe(true);
    const waiting = await runtime.decide([], decision(2));
    expect(waiting).toMatchObject({ stop: false, transmissions: [] });
    expect(waiting.snapshot.attentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qso-other-cycle-paused', params: { count: 1 } }),
    ]));

    config.transmitCycles = [0];
    expect(runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [1], transmitCycles: [0], source: 'manual',
    })).toBe(true);
    const resumed = await runtime.decide([], decision(3));
    expect(resumed.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB R OL32');
  });

  it('stops after two receive cycles when a parked QSO remains silent', async () => {
    const { runtime, config } = createRuntime({ transmitting: true });
    await activateInbound(runtime, 'JA1AAA', 'PM95');

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    expect((await runtime.decide([], decision(2))).stop).toBe(false);

    runtime.observeDecodedMessages([], observation(BASE_TIME));
    expect((await runtime.decide([], decision(3))).stop).toBe(false);
    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs * 2));
    expect(await runtime.decide([], decision(4))).toMatchObject({ stop: true, transmissions: [] });
  });

  it('follows the latest heard cycle while a QSO is parked', async () => {
    const { runtime, config } = createRuntime({ transmitting: true });
    await activateInbound(runtime, 'JA1AAA', 'PM95');

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    expect((await runtime.decide([], decision(2))).stop).toBe(false);

    const moved = parsed('BG5DRB JA1AAA PM95', BASE_TIME + MODES.FT8.slotMs * 2);
    runtime.observeDecodedMessages([moved], observation(moved.timestamp));
    expect((await runtime.decide([moved], decision(3))).transmissions?.[0]?.text)
      .toBe('JA1AAA BG5DRB R OL32');

    config.transmitCycles = [0];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [1], transmitCycles: [0], source: 'manual',
    });
    expect(runtime.getTransmissions()).toEqual([]);
  });

  it('retains directed progress received before the operator switches back to a parked QSO', async () => {
    const { runtime, config } = createRuntime({ transmitting: true });
    confirmTransmissions(runtime, await activateInbound(runtime, 'JA1AAA', 'PM95'));

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    expect((await runtime.decide([], decision(2))).stop).toBe(false);

    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([final], observation(final.timestamp));
    expect(runtime.getSnapshot().streams).toEqual([]);
    const completed = await runtime.decide([], decision(3));
    const effect = completed.qsoCompletions?.[0];
    expect(effect).toBeDefined();
    expect(completed).toMatchObject({ stop: true, transmissions: [] });
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'committed',
    });
  });

  it('applies a late physical receipt to a parked protocol checkpoint', async () => {
    const { runtime, config } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    confirmTransmissions(runtime, await runtime.decide([], decision()));
    const rogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    const rr73 = await runtime.decide([rogerGrid], decision(2));
    expect(rr73.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB RR73');

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    confirmTransmissions(runtime, rr73);

    const completed = await runtime.decide([], decision(3));
    expect(completed.transmissions).toEqual([]);
    const effect = completed.qsoCompletions?.[0];
    expect(effect).toBeDefined();
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'committed',
    });
    expect((await runtime.decide([], decision(4))).stop).toBe(true);
  });

  it('allows manual replacement after a parked final is detached for settlement', async () => {
    const { runtime, config } = createRuntime({
      transmitting: true,
      replaceQueueOnManualTarget: true,
    });
    confirmTransmissions(runtime, await activateInbound(runtime, 'JA1AAA', 'PM95'));

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    const finalA = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([finalA], observation(finalA.timestamp));
    const parkedCompletion = (await runtime.decide([], decision(2))).qsoCompletions?.[0];
    expect(parkedCompletion).toBeDefined();

    expect(runtime.enqueueTarget({ callsign: 'JA2BBB' })).toMatchObject({
      outcome: 'accepted',
      requestOperatorStart: true,
    });
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA1AAA', 'JA2BBB']);

    runtime.settleQSOCompletion({
      streamId: parkedCompletion!.streamId,
      lifecycleEpoch: parkedCompletion!.lifecycleEpoch,
      recordId: parkedCompletion!.record.id,
      status: 'committed',
    });
  });

  it('stops cleanly when a committed parked QSO belongs to a disabled stream', async () => {
    const { runtime, config, setTransmitting } = createRuntime({ parallelStreams: 2 });
    const started = await activateCqBatch(runtime, setTransmitting, ['JA1AAA', 'JA2BBB']);
    confirmTransmissions(runtime, started);

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    const finals = [
      parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs),
      parsed('BG5DRB JA2BBB RR73', BASE_TIME + MODES.FT8.slotMs),
    ];
    runtime.observeDecodedMessages(finals, observation(finals[0]!.timestamp));
    const completed = await runtime.decide([], decision(2));
    const completions = completed.qsoCompletions ?? [];
    expect(completions).toHaveLength(2);
    expect(completed).toMatchObject({ stop: true, transmissions: [] });

    config.parallelStreams = 1;
    runtime.getQueueSnapshot();
    for (const effect of completions) {
      runtime.settleQSOCompletion({
        streamId: effect.streamId,
        lifecycleEpoch: effect.lifecycleEpoch,
        recordId: effect.record.id,
        status: 'committed',
      });
    }
  });

  it('keeps a failed parked completion retryable without restoring its RF lane', async () => {
    const { runtime, config } = createRuntime({ transmitting: true, sessionId: 'ww-digi-session' });
    confirmTransmissions(runtime, await activateInbound(runtime, 'JA1AAA', 'PM95'));

    config.transmitCycles = [1];
    runtime.onOperatorTransmitCyclesChanged({
      previousTransmitCycles: [0], transmitCycles: [1], source: 'manual',
    });
    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([final], observation(final.timestamp));
    const effect = (await runtime.decide([], decision(2))).qsoCompletions?.[0];
    expect(effect).toBeDefined();
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'failed',
    });

    expect((await runtime.decide([], decision(3))).stop).toBe(true);
    const row = runtime.getQueueSnapshot().rows[0]!;
    expect(row).toMatchObject({
      displayState: 'review',
      actions: [expect.objectContaining({ id: 'retry-detached-log' }), expect.anything()],
    });
    const retried = await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: row.entryId, queueVersion: runtime.getQueueSnapshot().version },
      actionId: 'retry-detached-log',
    });
    expect(retried?.qsoCompletions?.[0]).toMatchObject({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      record: { id: effect!.record.id },
      destination: { kind: 'plugin-session', sessionId: 'ww-digi-session' },
    });
  });

  it('keeps dupes as candidates but excludes them from automatic CQ selection', async () => {
    const { runtime, setTransmitting } = createRuntime({
      parallelStreams: 2, cqSelectionPolicy: 'FIRST', workedCallsigns: ['JA1AAA'],
    });
    setTransmitting(true);
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
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 3, cqSelectionPolicy: 'FIRST' });
    setTransmitting(true);
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
    const { runtime, setTransmitting } = createRuntime({ cqMaxAttempts: 2 });
    setTransmitting(true);
    const first = await runtime.decide([], decision());
    confirmTransmissions(runtime, first);
    const second = await runtime.decide([], decision(2));
    confirmTransmissions(runtime, second);
    runtime.observeDecodedMessages([], observation(BASE_TIME));
    const afterTxEcho = await runtime.decide([], decision(3));
    expect(afterTxEcho.stop).toBe(false);
    expect(afterTxEcho.snapshot.attentions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cq-no-response' }),
    ]));
    runtime.observeDecodedMessages([], observation(BASE_TIME + MODES.FT8.slotMs));
    const stopped = await runtime.decide([], decision(4));
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

  it('projects a temporary logged-QSO toast with the latest claimed score', () => {
    const { runtime } = createRuntime();
    runtime.notifyQsoLogged('qso-1', 'JA1AAA', 'PM95', 1234);

    expect(runtime.getSnapshot().attentions).toContainEqual(expect.objectContaining({
      id: 'qso-logged-qso-1',
      tone: 'success',
      title: 'attentionQsoLogged',
      description: 'attentionQsoLoggedDesc',
      params: { callsign: 'JA1AAA', grid: 'PM95', score: 1234 },
      notify: true,
    }));

    vi.advanceTimersByTime(8_000);
    expect(runtime.getSnapshot().attentions?.some((attention) => attention.id === 'qso-logged-qso-1'))
      .toBe(false);
  });

  it('completes the outbound grid, R-grid, RR73 sequence after physical TX', async () => {
    const { runtime } = createRuntime({ transmitting: true, sessionId: 'ww-digi-session' });
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
    expect(completion.stop).toBe(true);
    expect(completion.qsoCompletions?.[0]).toMatchObject({
      streamId: 'stream-1',
      persistencePolicy: 'preserve-distinct',
      destination: { kind: 'plugin-session', sessionId: 'ww-digi-session' },
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
    expect(completed.stop).toBe(true);
    const effect = completed.qsoCompletions![0]!;
    runtime.settleQSOCompletion({
      streamId: effect.streamId,
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      status: 'committed',
    });
    expect(completed.transmissions).toEqual([]);
    expect(completed.snapshot.streams?.[0]).toMatchObject({
      currentState: 'final-retry',
      attentions: [{ id: 'completion-recovery-observing' }],
      completion: { state: 'committing' },
    });
    expect(runtime.getSnapshot().streams?.[0]?.completion).toMatchObject({ state: 'committed' });
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
    expect(completed.stop).toBe(true);
    const effect = completed.qsoCompletions![0]!;
    runtime.settleQSOCompletion({
      streamId: effect.streamId,
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      status: 'committed',
    });
    setTransmitting(false);
    setTransmitting(true);
    const restarted = await runtime.decide([], decision(3));

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

  it('logs a manually selected RR73 after physical success', async () => {
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
    expect((await runtime.decide([], decision(2))).qsoCompletions).toHaveLength(1);
  });

  it('accepts the first directed RR73 even before the prior response receipt is applied', async () => {
    const { runtime } = createRuntime({ transmitting: true });
    runtime.enqueueTarget({
      callsign: 'JA1AAA',
      lastMessage: selected('BG5DRB JA1AAA PM95'),
    });
    const response = await runtime.decide([], decision());
    expect(response.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB R OL32');

    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([final], observation(final.timestamp));
    const completed = await runtime.decide([final], decision(2));

    expect(completed.qsoCompletions).toHaveLength(1);
    expect(completed.qsoCompletions?.[0]?.record).toMatchObject({
      callsign: 'JA1AAA',
      grid: 'PM95',
    });
  });

  it('allows an explicit log action after a directed exchange', async () => {
    const { runtime } = createRuntime({ transmitting: true, sessionId: 'ww-digi-session' });
    await activateInbound(runtime, 'JA1AAA', 'PM95');
    const stream = runtime.getSnapshot().streams![0]!;
    const result = await runtime.invokeAction({
      target: { kind: 'stream', streamId: stream.streamId, lifecycleEpoch: stream.qsoLifecycleEpoch },
      actionId: 'log-current',
    });
    expect(result?.qsoCompletions?.[0]).toMatchObject({
      destination: { kind: 'plugin-session', sessionId: 'ww-digi-session' },
      record: { callsign: 'JA1AAA', grid: 'PM95' },
    });
  });

  it('reports the actual timeout stage and keeps the target retryable', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true, maxAttempts: 1 });
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

    setTransmitting(false);
    const queue = runtime.getQueueSnapshot();
    const retry = await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: queue.rows[0]!.entryId, queueVersion: queue.version },
      actionId: 'retry-target',
    });
    expect(retry).toMatchObject({ requestDecision: true, requestOperatorStart: true });

    setTransmitting(true);
    expect((await runtime.decide([], decision(3))).transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_200,
    }]);
  });

  it('continues with RR73 when R-grid arrives after the fifth unanswered grid', async () => {
    const { runtime } = createRuntime({ transmitting: true, maxAttempts: 5 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    let outgoing = await runtime.decide([], decision());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(outgoing.transmissions?.[0]?.text).toBe('JA1AAA BG5DRB OL32');
      confirmTransmissions(runtime, outgoing);
      if (attempt < 4) outgoing = await runtime.decide([], decision(attempt + 2));
    }

    const timedOut = await runtime.decide([], decision(6));
    expect(timedOut.qsoFailures).toHaveLength(1);
    expect(runtime.getQueueSnapshot().rows[0]?.displayState).toBe('no-response');

    const lateRogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    expect(runtime.observeDecodedMessages(
      [lateRogerGrid],
      observation(lateRogerGrid.timestamp),
    )).toBe(true);
    const resumed = await runtime.decide([lateRogerGrid], decision(7));

    expect(resumed.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB RR73', audioFrequencyHz: 1_200,
    }]);
    expect(resumed.snapshot.streams?.[0]).toMatchObject({
      targetCallsign: 'JA1AAA',
      currentState: 'send-rr73',
    });
  });

  it('keeps late R-grid progress while TX is off and resumes when the operator starts TX', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true, maxAttempts: 1 });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const first = await runtime.decide([], decision());
    confirmTransmissions(runtime, first);
    await runtime.decide([], decision(2));
    setTransmitting(false);

    const lateRogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([lateRogerGrid], observation(lateRogerGrid.timestamp));
    expect((await runtime.decide([], decision(3))).transmissions).toEqual([]);
    expect(runtime.getQueueSnapshot().rows[0]?.displayState).toBe('authorized');

    setTransmitting(true);
    expect((await runtime.decide([], decision(4))).transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB RR73', audioFrequencyHz: 1_200,
    }]);
  });

  it('does not let a replaced target reclaim the lane with a late R-grid', async () => {
    const { runtime } = createRuntime({
      transmitting: true,
      maxAttempts: 1,
      replaceQueueOnManualTarget: true,
    });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const first = await runtime.decide([], decision());
    confirmTransmissions(runtime, first);
    await runtime.decide([], decision(2));

    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const second = await runtime.decide([], decision(3));
    expect(second.transmissions?.[0]?.text).toBe('JA2BBB BG5DRB OL32');

    const lateRogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([lateRogerGrid], observation(lateRogerGrid.timestamp));
    const waiting = await runtime.decide([lateRogerGrid], decision(4));
    expect(waiting.transmissions?.[0]?.text).toBe('JA2BBB BG5DRB OL32');
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA2BBB']);
  });

  it('starts a fresh grid exchange after an inactive protocol context expires', async () => {
    const { runtime, setTransmitting } = createRuntime({
      transmitting: true,
      maxAttempts: 1,
      authorizedStaleReceiveCycles: 1,
    });
    runtime.enqueueTarget({ callsign: 'JA1AAA' });
    const first = await runtime.decide([], decision());
    confirmTransmissions(runtime, first);
    await runtime.decide([], decision(2));
    setTransmitting(false);

    const lateRogerGrid = parsed('BG5DRB JA1AAA R PM95', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([lateRogerGrid], observation(lateRogerGrid.timestamp));

    for (let receiveCycle = 2; receiveCycle <= 13; receiveCycle += 1) {
      runtime.observeDecodedMessages([], observation(
        BASE_TIME + MODES.FT8.slotMs * (receiveCycle * 2 - 1),
      ));
    }
    const queue = runtime.getQueueSnapshot();
    await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: queue.rows[0]!.entryId, queueVersion: queue.version },
      actionId: 'reauthorize-target',
    });
    setTransmitting(true);

    expect((await runtime.decide([], decision(3))).transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_200,
    }]);
  });

  it('logs a late final acknowledgement after its lane has moved to another target', async () => {
    const { runtime } = createRuntime({ transmitting: true, maxAttempts: 1 });
    const first = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, first);
    expect((await runtime.decide([], decision(2))).qsoFailures).toHaveLength(1);

    runtime.enqueueTarget({ callsign: 'JA2BBB' });
    const second = await runtime.decide([], decision(3));
    expect(second.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA2BBB BG5DRB OL32', audioFrequencyHz: 1_200,
    }]);

    const lateFinal = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    runtime.observeDecodedMessages([lateFinal], observation(lateFinal.timestamp));
    const recovered = await runtime.decide([lateFinal], decision(4));

    expect(recovered.qsoCompletions).toHaveLength(1);
    const effect = recovered.qsoCompletions![0]!;
    expect(effect).toMatchObject({
      persistencePolicy: 'preserve-distinct',
      metadata: { recoveredFinalAcknowledgement: true },
      record: {
        callsign: 'JA1AAA',
        grid: 'PM95',
        messageHistory: [
          'BG5DRB JA1AAA PM95',
          'JA1AAA BG5DRB R OL32',
          'BG5DRB JA1AAA RR73',
        ],
      },
    });
    expect(recovered.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA2BBB BG5DRB OL32', audioFrequencyHz: 1_200,
    }]);

    runtime.settleQSOCompletion({
      lifecycleEpoch: effect.lifecycleEpoch,
      recordId: effect.record.id,
      streamId: effect.streamId,
      status: 'committed',
    });
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual(['JA2BBB']);
  });

  it('can submit a recovered final acknowledgement while TX is off', async () => {
    const { runtime, setTransmitting } = createRuntime({ transmitting: true, maxAttempts: 1 });
    const first = await activateInbound(runtime, 'JA1AAA', 'PM95');
    confirmTransmissions(runtime, first);
    await runtime.decide([], decision(2));
    setTransmitting(false);

    const lateFinal = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    expect(runtime.observeDecodedMessages([lateFinal], observation(lateFinal.timestamp))).toBe(true);
    const recovered = await runtime.decide([], decision(3));

    expect(recovered.transmissions).toEqual([]);
    expect(recovered.qsoCompletions?.[0]?.record.callsign).toBe('JA1AAA');
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

  it('uses the next TX cycle for an already authorized caller after RR73', async () => {
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 1, cqSelectionPolicy: 'FIRST' });
    const started = await activateCqBatch(runtime, setTransmitting, ['JA1AAA', 'JA2BBB']);
    const queue = runtime.getQueueSnapshot();
    const candidate = queue.rows.find((row) => row.callsign === 'JA2BBB')!;
    await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: candidate.entryId, queueVersion: queue.version },
      actionId: 'authorize-target',
    });
    confirmTransmissions(runtime, started);

    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const continued = await runtime.decide([final], decision(2));

    expect(continued.qsoCompletions).toHaveLength(1);
    expect(continued.transmissions).toEqual([{
      streamId: 'stream-1', text: 'JA2BBB BG5DRB R OL32', audioFrequencyHz: 1_200,
    }]);
    expect(runtime.getQueueSnapshot().activeEntryIds).toEqual(['ww-digi-2']);
  });

  it('refills a completed lane in the same decision without waiting for log settlement', async () => {
    const { runtime, setTransmitting } = createRuntime({ parallelStreams: 3, cqSelectionPolicy: 'FIRST' });
    const started = await activateCqBatch(runtime, setTransmitting, ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD']);
    expect(started.transmissions).toHaveLength(3);
    const queue = runtime.getQueueSnapshot();
    const candidate = queue.rows.find((row) => row.callsign === 'JA4DDD')!;
    await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: candidate.entryId, queueVersion: queue.version },
      actionId: 'authorize-target',
    });
    confirmTransmissions(runtime, started);

    const final = parsed('BG5DRB JA1AAA RR73', BASE_TIME + MODES.FT8.slotMs);
    const completed = await runtime.decide([final], decision(2));
    const effect = completed.qsoCompletions?.[0];
    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(3);
    expect(completed.transmissions?.find((item) => item.streamId === 'stream-1')).toMatchObject({
      text: 'JA4DDD BG5DRB R OL32',
    });
    expect(runtime.getQueueSnapshot().rows.find((row) => row.callsign === 'JA1AAA')).toMatchObject({
      displayState: 'closing',
    });

    expect(effect).toBeDefined();
    runtime.settleQSOCompletion({
      streamId: effect!.streamId,
      lifecycleEpoch: effect!.lifecycleEpoch,
      recordId: effect!.record.id,
      status: 'committed',
    });

    expect(runtime.getQueueSnapshot().activeEntryIds).toHaveLength(3);
    expect(runtime.getQueueSnapshot().rows.map((row) => row.callsign)).toEqual([
      'JA4DDD',
      'JA2BBB',
      'JA3CCC',
    ]);
  });

  it('keeps a failed settlement in review until the operator retries the same completion', async () => {
    const { runtime } = createRuntime({ transmitting: true, sessionId: 'ww-digi-session' });
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

    const queue = runtime.getQueueSnapshot();
    expect(queue.rows[0]?.actions?.map((action) => action.id)).toContain('retry-detached-log');
    const retry = await runtime.invokeAction({
      target: { kind: 'queue-entry', entryId: queue.rows[0]!.entryId, queueVersion: queue.version },
      actionId: 'retry-detached-log',
    });
    expect(retry?.qsoCompletions).toEqual([
      expect.objectContaining({
        lifecycleEpoch: effect!.lifecycleEpoch,
        destination: { kind: 'plugin-session', sessionId: 'ww-digi-session' },
        record: expect.objectContaining({ id: effect!.record.id }),
      }),
    ]);
  });
});
