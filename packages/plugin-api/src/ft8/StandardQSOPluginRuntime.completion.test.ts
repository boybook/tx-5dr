import { describe, expect, it } from 'vitest';
import { MODES, type ParsedFT8Message } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import type { StrategyQSOCompletionEffect } from '../runtime.js';
import { StandardQSOPluginRuntime } from './StandardQSOPluginRuntime.js';

const meta = () => ({
  epoch: 1, source: 'slot-auto' as const, isReDecision: false,
  signal: new AbortController().signal,
});

function received(rawMessage: string, snr = -10): ParsedFT8Message {
  return {
    snr, dt: 0, df: 1500, rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: 'test-slot', timestamp: Date.now(),
  };
}

function createRuntime(skipTx1 = false) {
  return new StandardQSOPluginRuntime({
    config: {
      id: 'test-operator', mode: MODES.FT8, myCallsign: 'W1AAA', myGrid: 'FN31',
      frequency: 14074000, transmitCycles: [0], autoReplyToCQ: false,
      autoResumeCQAfterFail: false, autoResumeCQAfterSuccess: true,
      replyToWorkedStations: false, prioritizeNewCalls: true,
      targetSelectionPriorityMode: 'dxcc_first', maxQSOTimeoutCycles: 6, maxCallAttempts: 5,
      skipTx1,
    },
    hasWorkedCallsign: async () => false,
    isTargetBeingWorkedByOthers: () => false,
  });
}

async function completed(state: 'TX4' | 'TX5' = 'TX5') {
  const runtime = createRuntime();
  runtime.requestCall('K1BBB', undefined);
  runtime.patchContext({ reportSent: -10, reportReceived: -8 });
  await runtime.changeState(state);
  const decision = await runtime.decide([], meta());
  expect(decision.qsoCompletion).toBeDefined();
  return { runtime, effect: decision.qsoCompletion!, text: decision.transmission! };
}

function settle(runtime: StandardQSOPluginRuntime, effect: StrategyQSOCompletionEffect) {
  runtime.settleQSOCompletion({
    lifecycleEpoch: effect.lifecycleEpoch, recordId: effect.record.id, status: 'committed',
  });
}

describe('standard QSO completion facts', () => {
  it('allows the final reply while persistence prevents a new target', async () => {
    const { runtime, effect, text } = await completed();
    expect(text).toBe('K1BBB W1AAA 73');
    expect(runtime.requestCall('K2CCC', undefined)).toBe(false);
    settle(runtime, effect);
    expect(runtime.requestCall('K2CCC', undefined)).toBe(true);
  });

  it.each([true, false])('does not resubmit or relock after a post-73 retry (commit before cache: %s)', async (commitBeforeCache) => {
    const { runtime, effect, text } = await completed();
    if (commitBeforeCache) settle(runtime, effect);
    runtime.onTransmissionQueued(text);
    await runtime.decide([], meta());
    if (!commitBeforeCache) settle(runtime, effect);

    const retry = await runtime.decide([received('W1AAA K1BBB RR73')], meta());
    expect(retry.snapshot.currentState).toBe('TX5');
    expect(retry.qsoCompletion).toBeUndefined();
    expect(runtime.hasUnsettledQSOCompletion()).toBe(false);
    expect(runtime.tx5TransmissionQueued).toBe(false);
    runtime.onTransmissionQueued(text);
    await runtime.decide([], meta());
    expect(runtime.requestCall('K2CCC', undefined)).toBe(true);
  });

  it('retains committed facts when a speculative checkpoint is restored', async () => {
    const { runtime, effect } = await completed();
    const checkpoint = structuredClone(runtime.checkpoint());
    settle(runtime, effect);
    runtime.restore(checkpoint);
    expect(runtime.hasUnsettledQSOCompletion()).toBe(false);
    expect((await runtime.decide([], meta())).qsoCompletion).toBeUndefined();
    expect(runtime.requestCall('K2CCC', undefined)).toBe(true);
  });

  it('retains final transmission facts across rollback without satisfying a later retry', async () => {
    const { runtime, text } = await completed();
    const checkpoint = structuredClone(runtime.checkpoint());
    runtime.onTransmissionQueued(text);
    runtime.restore(checkpoint);
    expect(runtime.tx5TransmissionQueued).toBe(true);
    expect((await runtime.decide([], meta())).snapshot.currentState).toBe('TX6');
    await runtime.decide([received('W1AAA K1BBB RR73')], meta());
    expect(runtime.tx5TransmissionQueued).toBe(false);
  });

  it('does not create a second record when a durable TX4 contact advances to TX5', async () => {
    const { runtime, effect } = await completed('TX4');
    settle(runtime, effect);
    const tx5 = await runtime.decide([received('W1AAA K1BBB RR73')], meta());
    expect(tx5.snapshot.currentState).toBe('TX5');
    expect(tx5.qsoCompletion).toBeUndefined();
    expect(runtime.hasUnsettledQSOCompletion()).toBe(false);
  });

  it('does not carry a previous contact confirmation into a new contact', async () => {
    const { runtime, effect, text } = await completed();
    runtime.onTransmissionQueued(text);
    settle(runtime, effect);
    expect(runtime.requestCall('K2CCC', undefined)).toBe(true);
    await runtime.changeState('TX5');
    const second = await runtime.decide([], meta());
    expect(second.qsoCompletion?.record.callsign).toBe('K2CCC');
    expect(second.qsoCompletion?.record.id).not.toBe(effect.record.id);
    expect(runtime.hasUnsettledQSOCompletion()).toBe(true);
    expect(runtime.tx5TransmissionQueued).toBe(false);
    settle(runtime, effect);
    expect(runtime.hasUnsettledQSOCompletion()).toBe(true);
  });
});

describe('standard QSO transmitted report facts', () => {
  it.each([
    ['ROGER_REPORT', 'W1AAA K1BBB R-12'],
    ['SIGNAL_REPORT', 'W1AAA K1BBB -12'],
  ])('keeps the physically transmitted report after a %s acknowledgement', async (_label, acknowledgement) => {
    const runtime = createRuntime(true);
    runtime.requestCall('K1BBB', undefined);
    runtime.patchContext({ reportSent: -12 });

    const reportSlot = await runtime.decide([], meta());
    expect(reportSlot.transmission).toBe('K1BBB W1AAA -12');
    // The report reached the air; the acknowledgement decodes 2 dB weaker.
    runtime.onTransmissionQueued(reportSlot.transmission!);

    const decision = await runtime.decide([received(acknowledgement, -14)], meta());

    expect(decision.snapshot.currentState).toBe('TX4');
    expect(decision.snapshot.context?.reportSent).toBe(-12);
    expect(decision.qsoCompletion?.record).toMatchObject({
      callsign: 'K1BBB',
      reportSent: '-12',
      reportReceived: '-12',
    });
  });

  it('adopts the acknowledgement SNR when no report was transmitted', async () => {
    const runtime = createRuntime(true);
    runtime.requestCall('K1BBB', undefined);

    const decision = await runtime.decide([received('W1AAA K1BBB R-12', -14)], meta());

    expect(decision.snapshot.currentState).toBe('TX4');
    expect(decision.snapshot.context?.reportSent).toBe(-14);
    expect(decision.qsoCompletion?.record.reportSent).toBe('-14');
  });

  it('does not leak a transmitted report into the next contact', async () => {
    const runtime = createRuntime(true);
    runtime.requestCall('K1BBB', undefined);
    runtime.patchContext({ reportSent: -12 });
    const firstSlot = await runtime.decide([], meta());
    runtime.onTransmissionQueued(firstSlot.transmission!);

    runtime.requestCall('K2CCC', undefined);
    const second = await runtime.decide([received('W1AAA K2CCC R-15', -9)], meta());

    expect(second.snapshot.context?.targetCallsign).toBe('K2CCC');
    expect(second.snapshot.context?.reportSent).toBe(-9);
    expect(second.qsoCompletion?.record).toMatchObject({
      callsign: 'K2CCC',
      reportSent: '-9',
      reportReceived: '-15',
    });
  });

  it('keeps the transmitted R-report when the peer repeats its signal report', async () => {
    const runtime = createRuntime();
    runtime.requestCall('K1BBB', undefined);
    const signalReport = await runtime.decide([received('W1AAA K1BBB -15', -9)], meta());
    expect(signalReport.snapshot.currentState).toBe('TX3');
    expect(signalReport.transmission).toBe('K1BBB W1AAA R-09');
    runtime.onTransmissionQueued(signalReport.transmission!);

    const decision = await runtime.decide([received('W1AAA K1BBB -15', -14)], meta());

    expect(decision.snapshot.currentState).toBe('TX3');
    expect(decision.snapshot.context?.reportSent).toBe(-9);
    expect(decision.snapshot.context?.reportReceived).toBe(-15);
  });

  it('logs the transmitted notation for a zero report', async () => {
    const runtime = createRuntime(true);
    runtime.requestCall('K1BBB', undefined);
    runtime.patchContext({ reportSent: 0 });

    const reportSlot = await runtime.decide([], meta());
    expect(reportSlot.transmission).toBe('K1BBB W1AAA +00');
    runtime.onTransmissionQueued(reportSlot.transmission!);

    const decision = await runtime.decide([received('W1AAA K1BBB R+00', -14)], meta());

    expect(decision.qsoCompletion?.record).toMatchObject({
      reportSent: '+00',
      reportReceived: '0',
    });
  });

  it('carries the contact attempt start with the completion effect', async () => {
    const runtime = createRuntime();
    runtime.requestCall('K1BBB', undefined);
    const attemptStartedAt = runtime.qsoStartTime;
    expect(attemptStartedAt).toBeTypeOf('number');
    runtime.patchContext({ reportSent: -10, reportReceived: -8 });
    await runtime.changeState('TX5');

    const decision = await runtime.decide([], meta());

    expect(decision.qsoCompletion?.startedAt).toBe(attemptStartedAt);
  });

  it('starts a fresh attempt clock for each contact', async () => {
    const runtime = createRuntime(true);
    // Simulate a stale attempt clock surviving from a previous contact.
    runtime.qsoStartTime = 1;

    runtime.requestCall('K1BBB', undefined);

    expect(runtime.qsoStartTime).not.toBe(1);
    expect(runtime.qsoStartTime).toBeGreaterThan(1);
  });
});
