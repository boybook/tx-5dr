import { describe, expect, it, vi } from 'vitest';
import { MODES, type FrameMessage, type OperatorConfig, type ParsedFT8Message, type SlotInfo } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import {
  StandardQSOPluginRuntime,
  type StandardQSOPluginOperator,
} from './StandardQSOPluginRuntime.js';

function createOperator(overrides: Partial<OperatorConfig> = {}): StandardQSOPluginOperator {
  const config: OperatorConfig = {
    id: 'operator-1',
    mode: MODES.FT8,
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    frequency: 7074000,
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
    get config() {
      return config;
    },
    hasWorkedCallsign: vi.fn(async () => false),
    isTargetBeingWorkedByOthers: vi.fn(() => false),
    notifySlotsUpdated: vi.fn(),
    notifyStateChanged: vi.fn(),
  };
}

function createParsedMessage(rawMessage: string, overrides: Partial<ParsedFT8Message> = {}): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0,
    df: 1500,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: 'slot-test',
    timestamp: 0,
    ...overrides,
  };
}

function decisionMeta(overrides: Partial<{
  epoch: number;
  source: 'slot-auto' | 'late-decode';
  isReDecision: boolean;
  signal: AbortSignal;
}> = {}) {
  return {
    epoch: 1,
    source: 'slot-auto' as const,
    isReDecision: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('StandardQSOPluginRuntime v2 decision lifecycle', () => {
  it('returns QSO completion as a declarative effect without blocking the final frame', async () => {
    const operator = createOperator();
    const runtime = new StandardQSOPluginRuntime(operator);
    runtime.patchContext({
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -10,
      reportReceived: -8,
    });
    await runtime.changeState('TX4');

    const result = await runtime.decide([], decisionMeta());

    expect(result.transmission).toBe('JA1AAA BG5DRB RR73');
    expect(result.snapshot.currentState).toBe('TX4');
    expect(result.qsoCompletion?.record).toMatchObject({
      callsign: 'JA1AAA',
      grid: 'PM95',
      reportSent: '-10',
      reportReceived: '-8',
    });
    expect(result.qsoCompletion?.lifecycleEpoch).toBe(
      result.snapshot.qsoLifecycleEpoch,
    );
  });

  it('holds a direct handoff until the previous QSO is durable, then starts a distinct lifecycle', async () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    expect(runtime.requestCall('JA1AAA', undefined)).toBe(true);
    runtime.patchContext({ reportSent: -10, reportReceived: -8 });
    await runtime.changeState('TX4');

    const first = await runtime.decide([
      createParsedMessage('BG5DRB JA1AAA 73'),
      createParsedMessage('BG5DRB JA2BBB PM95', { snr: -3 }),
    ], decisionMeta());

    expect(first.qsoCompletion?.record.callsign).toBe('JA1AAA');
    expect(first.snapshot.currentState).toBe('TX6');
    expect(first.snapshot.context?.targetCallsign).toBeUndefined();

    const blocked = await runtime.decide([
      createParsedMessage('BG5DRB JA2BBB PM95', { snr: -3 }),
    ], decisionMeta({ epoch: 2 }));
    expect(blocked.snapshot.currentState).toBe('TX6');
    expect(blocked.snapshot.context?.targetCallsign).toBeUndefined();

    runtime.settleQSOCompletion({
      lifecycleEpoch: first.qsoCompletion!.lifecycleEpoch,
      recordId: first.qsoCompletion!.record.id,
      status: 'committed',
    });
    const second = await runtime.decide([
      createParsedMessage('BG5DRB JA2BBB PM95', { snr: -3 }),
    ], decisionMeta({ epoch: 3 }));

    expect(second.snapshot.currentState).toBe('TX2');
    expect(second.snapshot.context?.targetCallsign).toBe('JA2BBB');
    expect(second.snapshot.qsoLifecycleEpoch).toBeGreaterThan(
      first.qsoCompletion!.lifecycleEpoch,
    );

    runtime.patchContext({ reportSent: -3, reportReceived: -6 });
    await runtime.changeState('TX4');
    const secondCompletion = await runtime.decide([], decisionMeta({ epoch: 4 }));
    expect(secondCompletion.qsoCompletion?.record.callsign).toBe('JA2BBB');
    expect(secondCompletion.qsoCompletion?.lifecycleEpoch).toBe(
      second.snapshot.qsoLifecycleEpoch,
    );
  });

  it('produces a structured-cloneable checkpoint and restores speculative state', async () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    runtime.requestCall('JA1AAA', undefined);
    const checkpoint = structuredClone(runtime.checkpoint());

    runtime.patchContext({ targetCallsign: 'JA2BBB', reportSent: -4 });
    runtime.setState('TX5');
    runtime.restore(checkpoint);

    expect(runtime.getSnapshot()).toMatchObject({
      currentState: 'TX1',
      context: { targetCallsign: 'JA1AAA' },
    });
  });

  it('rejects an already-aborted decision before mutating runtime state', async () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    const checkpoint = structuredClone(runtime.checkpoint());
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.decide([], decisionMeta({ signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.checkpoint()).toEqual(checkpoint);
  });
});

describe('StandardQSOPluginRuntime TX6 override', () => {
  it('omits the TX6 grid for compound CQ callsigns by default', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({
      myCallsign: 'BG7KEO/QRP',
      myGrid: 'OL62',
    }));

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG7KEO/QRP');
  });

  it('regenerates compound CQ TX6 without a grid unless TX6 has a manual override', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({
      myCallsign: 'BG7KEO/QRP',
      myGrid: 'OL62',
    }));

    runtime.patchContext({
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -12,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG7KEO/QRP');

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ TEST BG7KEO/QRP' });
    runtime.patchContext({
      targetCallsign: 'VK2ABC',
      targetGrid: 'QF56',
      reportSent: -7,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ TEST BG7KEO/QRP');
  });

  it('keeps a manually edited TX6 message across slot regeneration', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ DX BG5DRB OL32' });
    runtime.patchContext({
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -12,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ DX BG5DRB OL32');
  });

  it('clears the override when TX6 is emptied', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ TEST BG5DRB OL32' });
    runtime.setSlotContent({ slot: 'TX6', content: '' });

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG5DRB OL32');
  });

  it('clears the override when TX6 matches the generated default CQ', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ POTA BG5DRB OL32' });
    runtime.setSlotContent({ slot: 'TX6', content: 'CQ BG5DRB OL32' });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG5DRB OL32');
  });
});


describe('StandardQSOPluginRuntime nonstandard callsign slots', () => {
  it('uses RR73 for special event callsigns when the structured reply fits FT8 text length', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG7WJH' }));

    runtime.patchContext({
      targetCallsign: 'LZ370TL',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<LZ370TL> BG7WJH OL32',
      TX2: '<LZ370TL> BG7WJH -09',
      TX3: '<LZ370TL> BG7WJH R-09',
      TX4: '<LZ370TL> BG7WJH RR73',
      TX5: '<LZ370TL> BG7WJH 73',
    });
  });

  it('keeps RR73 for special event callsigns that exceed the old 22-character guard', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.patchContext({
      targetCallsign: 'SX100PAOK',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<SX100PAOK> BG5DRB OL32',
      TX2: '<SX100PAOK> BG5DRB -09',
      TX3: '<SX100PAOK> BG5DRB R-09',
      TX4: '<SX100PAOK> BG5DRB RR73',
      TX5: '<SX100PAOK> BG5DRB 73',
    });
  });

  it('keeps 23-character RR73 and R-report messages for compound callsigns', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.patchContext({
      targetCallsign: 'VA7CD/DU7',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<VA7CD/DU7> BG5DRB OL32',
      TX2: '<VA7CD/DU7> BG5DRB -09',
      TX3: '<VA7CD/DU7> BG5DRB R-09',
      TX4: '<VA7CD/DU7> BG5DRB RR73',
      TX5: '<VA7CD/DU7> BG5DRB 73',
    });
  });

  it('responds to a compound-callsign R-report with RR73 instead of RRR', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    const message: FrameMessage = {
      snr: -9,
      freq: 1150,
      dt: 0,
      message: 'BG5DRB <VA7CD/DU7> R-17',
      confidence: 1,
    };
    const slotInfo: SlotInfo = {
      id: 'slot-1',
      startMs: 0,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber: 0,
      utcSeconds: 0,
      mode: 'FT8',
    };

    runtime.requestCall('VA7CD/DU7', { message, slotInfo });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX4');
    expect(snapshot.slots?.TX4).toBe('<VA7CD/DU7> BG5DRB RR73');
  });

  it('advances from TX3 when Fox/Hound RR73 completes my callsign', async () => {
    const operator = createOperator({ myCallsign: 'BD4XYR', myGrid: 'OM89' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BD4XYR RR73; JH1UBK <EX8ABR> -24';
    const parsedMessage = createParsedMessage(rawMessage, { slotId: 'slot-fox-rr73' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -24,
      reportReceived: -10,
    });
    runtime.setState('TX3');

    const decision = await runtime.decide([parsedMessage], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX5');
    expect(snapshot.slots?.TX5).toBe('EX8ABR BD4XYR 73');
    expect(decision.qsoCompletion?.record).toMatchObject({
      callsign: 'EX8ABR',
      myCallsign: 'BD4XYR',
    });
  });

  it('advances from TX3 when a portable Fox/Hound RR73 is clipped after the Fox callsign', async () => {
    const operator = createOperator({ myCallsign: 'BH5HIE', myGrid: 'PM00' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BH5HIE RR73; JH5FVT <EX8ABR/P';
    const parsedMessage = createParsedMessage(rawMessage, { snr: -12, slotId: 'slot-fox-rr73-clipped' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -16,
      reportReceived: -12,
    });
    runtime.setState('TX3');

    const decision = await runtime.decide([parsedMessage], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX5');
    expect(snapshot.slots?.TX5).toBe('EX8ABR BH5HIE 73');
    expect(decision.qsoCompletion?.record).toMatchObject({
      callsign: 'EX8ABR',
      myCallsign: 'BH5HIE',
    });
  });

  it('matches a portable Fox callsign response against a base target callsign', async () => {
    const operator = createOperator({ myCallsign: 'BH5HIE', myGrid: 'PM00' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BH5HIE EX8ABR/P +02';
    const parsedMessage = createParsedMessage(rawMessage, { snr: -16, slotId: 'slot-portable-report' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -14,
    });
    runtime.setState('TX1');

    await runtime.decide([parsedMessage], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX3');
    expect(snapshot.slots?.TX3).toBe('EX8ABR/P BH5HIE R-16');
    expect(snapshot.context?.targetCallsign).toBe('EX8ABR/P');
    expect(snapshot.context?.reportReceived).toBe(2);
    expect(snapshot.context?.reportSent).toBe(-16);
  });

  it('overwrites a cached reportReceived of 0 when answering a fresh SIGNAL_REPORT', async () => {
    // Reproduces issue #70: cached/UI sentinel 0 must not replace the air report (-15).
    const operator = createOperator({ myCallsign: 'BG5FRH', myGrid: 'PL09' });
    const runtime = new StandardQSOPluginRuntime(operator);

    runtime.patchContext({
      targetCallsign: 'RW9HSB',
      targetGrid: 'NO26',
      reportSent: -2,
      reportReceived: 0,
    });
    runtime.clearQSOContext();
    runtime.setState('TX6');

    await runtime.decide([
      createParsedMessage('BG5FRH RW9HSB -15', { snr: -2, slotId: 'slot-issue-70' }),
    ], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX3');
    expect(snapshot.context?.targetCallsign).toBe('RW9HSB');
    expect(snapshot.context?.reportReceived).toBe(-15);
    expect(snapshot.context?.reportSent).toBe(-2);
    expect(snapshot.slots?.TX3).toBe('RW9HSB BG5FRH R-02');
  });

  it('overwrites a stale reportReceived of 0 when TX2 receives a ROGER_REPORT', async () => {
    const operator = createOperator({ myCallsign: 'BG5FRH', myGrid: 'PL09' });
    const runtime = new StandardQSOPluginRuntime(operator);

    runtime.patchContext({
      targetCallsign: 'RW9HSB',
      reportSent: -2,
      reportReceived: 0,
    });
    runtime.setState('TX2');

    await runtime.decide([
      createParsedMessage('BG5FRH RW9HSB R-15', { snr: -3, slotId: 'slot-roger-overwrite' }),
    ], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX4');
    expect(snapshot.context?.reportReceived).toBe(-15);
    expect(snapshot.context?.reportSent).toBe(-3);
  });

  it('clears stale cached reports when answering a CALL after restoreContext', async () => {
    const operator = createOperator({ myCallsign: 'BG5FRH', myGrid: 'PL09' });
    const runtime = new StandardQSOPluginRuntime(operator);

    runtime.patchContext({
      targetCallsign: 'RW9HSB',
      targetGrid: 'NO26',
      reportSent: -8,
      reportReceived: 0,
    });
    runtime.clearQSOContext();
    runtime.setState('TX6');

    await runtime.decide([
      createParsedMessage('BG5FRH RW9HSB NO26', { snr: -5, slotId: 'slot-call-clear' }),
    ], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX2');
    expect(snapshot.context?.targetCallsign).toBe('RW9HSB');
    expect(snapshot.context?.targetGrid).toBe('NO26');
    expect(snapshot.context?.reportSent).toBe(-5);
    expect(snapshot.context?.reportReceived).toBeUndefined();
  });

  it('clears reports when patchContext receives explicit undefined properties', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    runtime.patchContext({
      targetCallsign: 'RW9HSB',
      reportSent: -12,
      reportReceived: -8,
    });
    runtime.patchContext({
      reportSent: undefined,
      reportReceived: undefined,
    });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.context?.targetCallsign).toBe('RW9HSB');
    expect(snapshot.context?.reportSent).toBeUndefined();
    expect(snapshot.context?.reportReceived).toBeUndefined();
    expect(snapshot.slots?.TX2).toBe('RW9HSB BG5DRB +00');
  });
});

describe('StandardQSOPluginRuntime partial-decode `<...>` handling', () => {
  it('ignores a partial-decode RRR addressed to me (BG5DRB <...> RR73)', async () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB' }));
    const parsedMessage = createParsedMessage('BG5DRB <...> RR73', {
      isPartialDecode: true,
      slotId: 'slot-partial-rrr',
    });

    await runtime.decide([parsedMessage], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
    expect(snapshot.context?.targetCallsign).toBeUndefined();
  });

  it('ignores a partial-decode CQ (CQ <...> PL09)', async () => {
    const operator = createOperator({ myCallsign: 'BG5DRB', autoReplyToCQ: true });
    const runtime = new StandardQSOPluginRuntime(operator);
    const parsedMessage = createParsedMessage('CQ <...> PL09', {
      isPartialDecode: true,
      slotId: 'slot-partial-cq',
    });

    await runtime.decide([parsedMessage], decisionMeta());

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
    expect(snapshot.context?.targetCallsign).toBeUndefined();
  });

  it('refuses requestCall with an undecoded placeholder callsign', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB' }));

    runtime.requestCall('...', undefined);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
    expect(snapshot.context?.targetCallsign).toBeUndefined();
  });

  it('rejects a placeholder context patch without replacing the active target or slots', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB' }));
    runtime.requestCall('JA1ABC', undefined);
    const before = runtime.getSnapshot();

    runtime.patchContext({ targetCallsign: '...' });

    const after = runtime.getSnapshot();
    expect(after.context?.targetCallsign).toBe('JA1ABC');
    expect(after.slots).toEqual(before.slots);
    expect(after.currentState).toBe('TX1');
  });

  it('clears active transmit slots if an invalid placeholder reaches the slot generator', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB' }));
    runtime.requestCall('JA1ABC', undefined);

    runtime.context.targetCallsign = '<...>';
    runtime.updateSlots();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.context?.targetCallsign).toBe('<...>');
    expect(snapshot.slots?.TX1).toBe('');
    expect(snapshot.slots?.TX2).toBe('');
    expect(snapshot.slots?.TX3).toBe('');
    expect(snapshot.slots?.TX4).toBe('');
    expect(snapshot.slots?.TX5).toBe('');
  });
});

describe('StandardQSOPluginRuntime target validation', () => {
  it('refuses a requestCall targeting the operator callsign', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB/P' }));

    expect(runtime.requestCall(' bg5drb ', undefined)).toBe(false);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX6');
    expect(snapshot.context?.targetCallsign).toBeUndefined();
    expect(snapshot.slots).toMatchObject({ TX1: '', TX2: '', TX3: '', TX4: '', TX5: '' });
  });

  it('rejects an own-callsign context patch without changing the active QSO', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG5DRB' }));
    expect(runtime.requestCall('JA1ABC', undefined)).toBe(true);
    const before = runtime.getSnapshot();

    runtime.patchContext({ targetCallsign: 'bg5drb/P', reportSent: -3 });

    const after = runtime.getSnapshot();
    expect(after).toEqual(before);
  });
});
