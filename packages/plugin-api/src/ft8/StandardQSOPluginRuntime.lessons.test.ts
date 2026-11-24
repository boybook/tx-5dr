import { describe, expect, it } from 'vitest';
import { MODES, type ParsedFT8Message } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import { StandardQSOPluginRuntime } from './StandardQSOPluginRuntime.js';

// The report TX2/TX3 carry is our own measurement of the peer (WSJT-X takes
// the SNR of the selected decode). +00 is only the fallback when the peer has
// never been heard, and what reaches the air is what gets logged.

const meta = () => ({
  epoch: 1, source: 'slot-auto' as const, isReDecision: false,
  signal: new AbortController().signal,
});

function received(rawMessage: string, snr: number): ParsedFT8Message {
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

describe('standard QSO outgoing report without an explicit report', () => {
  it.each([
    { snr: -13, onAir: '-13' },
    { snr: 3.6, onAir: '+04' },
    { snr: -62, onAir: '-50' },
  ])('sends and logs the peer measured SNR $snr as $onAir when a call starts at TX2', async ({ snr, onAir }) => {
    const runtime = createRuntime(true);
    // Heard while calling CQ; the call itself carries no source decode.
    await runtime.decide([received('CQ K1BBB FN42', snr)], meta());
    expect(runtime.requestCall('K1BBB', undefined)).toBe(true);

    const reportSlot = await runtime.decide([], meta());
    expect(reportSlot.snapshot.currentState).toBe('TX2');
    expect(reportSlot.transmission).toBe(`K1BBB W1AAA ${onAir}`);
    // The measurement is not promoted to an explicit report before it is sent.
    expect(reportSlot.snapshot.context?.reportSent).toBeUndefined();

    runtime.onTransmissionQueued(reportSlot.transmission!);
    const done = await runtime.decide([received('W1AAA K1BBB R-08', -20)], meta());

    expect(done.snapshot.currentState).toBe('TX4');
    expect(done.qsoCompletion?.record).toMatchObject({
      callsign: 'K1BBB',
      reportSent: onAir,
      reportReceived: '-8',
    });
  });

  it('refreshes an unset report when the target is heard after the call started', async () => {
    const runtime = createRuntime();
    runtime.requestCall('K1BBB', undefined);
    expect(runtime.getSlots().TX2).toBe('K1BBB W1AAA +00');

    // The target works someone else; TX1 keeps waiting but we measured it.
    const waiting = await runtime.decide([received('JA1XYZ K1BBB -05', -16)], meta());
    expect(waiting.snapshot.currentState).toBe('TX1');
    expect(waiting.snapshot.slots?.TX2).toBe('K1BBB W1AAA -16');
    expect(waiting.snapshot.slots?.TX3).toBe('K1BBB W1AAA R-16');

    runtime.setState('TX3');
    const text = runtime.getTransmitText();
    expect(text).toBe('K1BBB W1AAA R-16');
    runtime.onTransmissionQueued(text!);
    expect(runtime.getSnapshot().context?.reportSent).toBe(-16);
  });

  it('keeps the +00 fallback, and logs it, when the peer was never heard', async () => {
    const runtime = createRuntime(true);
    // Other stations' measurements never stand in for the target's.
    await runtime.decide([received('CQ K2CCC FN42', -7)], meta());
    runtime.requestCall('K1BBB', undefined);

    const reportSlot = await runtime.decide([received('CQ K3DDD FN42', -3)], meta());
    expect(reportSlot.transmission).toBe('K1BBB W1AAA +00');
    runtime.onTransmissionQueued(reportSlot.transmission!);

    const done = await runtime.decide([received('W1AAA K1BBB R-08', -20)], meta());
    expect(done.qsoCompletion?.record).toMatchObject({ reportSent: '+00', reportReceived: '-8' });
  });

  it('lets an explicit report, including zero, win over the measurement', async () => {
    const runtime = createRuntime(true);
    await runtime.decide([received('CQ K1BBB FN42', -13)], meta());
    runtime.requestCall('K1BBB', undefined);
    runtime.patchContext({ reportSent: 0 });

    expect((await runtime.decide([], meta())).transmission).toBe('K1BBB W1AAA +00');

    runtime.patchContext({ reportSent: undefined });
    expect(runtime.getSlots().TX2).toBe('K1BBB W1AAA -13');
  });

  it('does not let a later decode rewrite a report already on the air', async () => {
    const runtime = createRuntime(true);
    await runtime.decide([received('CQ K1BBB FN42', -13)], meta());
    runtime.requestCall('K1BBB', undefined);
    const reportSlot = await runtime.decide([], meta());
    runtime.onTransmissionQueued(reportSlot.transmission!);

    const repeat = await runtime.decide([received('JA1XYZ K1BBB -05', -21)], meta());

    expect(repeat.snapshot.currentState).toBe('TX2');
    expect(repeat.transmission).toBe('K1BBB W1AAA -13');
    expect(repeat.snapshot.context?.reportSent).toBe(-13);
  });

  it('leaves an operator-edited report slot alone', async () => {
    const runtime = createRuntime();
    runtime.requestCall('K1BBB', undefined);
    runtime.setSlotContent({ slot: 'TX2', content: 'K1BBB W1AAA -01' });

    const waiting = await runtime.decide([received('JA1XYZ K1BBB -05', -16)], meta());

    expect(waiting.snapshot.slots?.TX2).toBe('K1BBB W1AAA -01');
    expect(waiting.snapshot.slots?.TX3).toBe('K1BBB W1AAA R-16');
  });

  it('rolls the measurement back together with the slots it refreshed', async () => {
    const runtime = createRuntime();
    runtime.requestCall('K1BBB', undefined);
    const checkpoint = structuredClone(runtime.checkpoint());

    await runtime.decide([received('JA1XYZ K1BBB -05', -16)], meta());
    runtime.restore(checkpoint);
    expect(runtime.getSlots().TX2).toBe('K1BBB W1AAA +00');

    // The same decode presented again still refreshes the report.
    const retried = await runtime.decide([received('JA1XYZ K1BBB -05', -16)], meta());
    expect(retried.snapshot.slots?.TX2).toBe('K1BBB W1AAA -16');
  });
});
