import { describe, expect, it } from 'vitest';
import type { OperatorStatus, SlotInfo, SlotPack } from '@tx5dr/contracts';

import {
  getRadioOperatorProgressAnimation,
  shouldRadioOperatorPropsBeEqual,
} from '../radioOperatorProgress';
import { pickManualIdleFrequency } from '../radioOperatorIdleFrequency';
import {
  resolveRadioOperatorCurrentTransmissions,
  resolveRadioOperatorCyclePresentation,
  resolveSingleControllableStream,
  resolveRadioOperatorStreamPresentations,
  summarizeRadioOperatorTransmissions,
} from '../radioOperatorPresentation';

function createOperatorStatus(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: 'operator-1',
    isActive: true,
    isTransmitting: true,
    isInActivePTT: false,
    hasTransmitIntent: true,
    currentSlot: 'TX6',
    context: {
      myCall: 'BG5DRB',
      myGrid: 'PM01',
      targetCall: '',
      targetGrid: '',
      frequency: 1000,
      reportSent: 0,
      reportReceived: 0,
    },
    strategy: {
      name: 'standard-qso',
      state: 'TX6',
      availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
    },
    slots: {
      TX6: 'CQ BG5DRB PM01',
    },
    transmitCycles: [0],
    ...overrides,
  };
}

function createSlotInfo(overrides: Partial<SlotInfo> = {}): SlotInfo {
  return {
    id: 'FT8-42-630000',
    startMs: 630000,
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: 42,
    utcSeconds: 630,
    mode: 'FT8',
    ...overrides,
  };
}

function createSlotPack(overrides: Partial<SlotPack> = {}): SlotPack {
  return {
    slotId: 'slot-0',
    startMs: 0,
    endMs: 15000,
    frames: [{
      message: 'CQ JA1AAA PM95',
      snr: -10,
      dt: 0,
      freq: 1500,
      confidence: 0.9,
    }],
    stats: {
      totalDecodes: 1,
      successfulDecodes: 1,
      totalFramesBeforeDedup: 1,
      totalFramesAfterDedup: 1,
      lastUpdated: 0,
    },
    decodeHistory: [],
    ...overrides,
  };
}

describe('RadioOperator progress animation helpers', () => {
  it('starts animation from the global slot phase sample', () => {
    const style = getRadioOperatorProgressAnimation(createSlotInfo({ phaseMs: 9000 }), 15000);

    expect(style.animation).toBe('progress-bar 6000ms linear forwards');
    expect((style as Record<string, string>)['--progress-start']).toBe('40%');
  });

  it('restores an in-progress slot animation from the latest global phase after remount', () => {
    const style = getRadioOperatorProgressAnimation(createSlotInfo({ phaseMs: 7500 }), 15000);

    expect(style.animation).toBe('progress-bar 7500ms linear forwards');
    expect((style as Record<string, string>)['--progress-start']).toBe('50%');
  });

  it('returns a disabled animation when global slot info is missing', () => {
    expect(getRadioOperatorProgressAnimation(undefined, 15000)).toEqual({ animation: 'none' });
  });
});

describe('RadioOperator memo comparison', () => {
  it('keeps identical operator status snapshots memoized', () => {
    const prev = createOperatorStatus();
    const next = createOperatorStatus();

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(true);
  });

  it('treats active PTT changes as a meaningful update', () => {
    const prev = createOperatorStatus({ isInActivePTT: false });
    const next = createOperatorStatus({ isInActivePTT: true });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats transmit intent changes as a meaningful update', () => {
    const prev = createOperatorStatus({ hasTransmitIntent: false });
    const next = createOperatorStatus({ hasTransmitIntent: true });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats transmit cycle changes as a meaningful update', () => {
    const prev = createOperatorStatus({ transmitCycles: [0] });
    const next = createOperatorStatus({ transmitCycles: [1] });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats authoritative queue snapshot changes as a meaningful update', () => {
    const prev = createOperatorStatus({
      runtime: {
        currentState: 'idle',
        queue: { version: 1, rows: [] },
      },
    });
    const next = createOperatorStatus({
      runtime: {
        currentState: 'idle',
        queue: { version: 2, rows: [] },
      },
    });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats an active strategy change as a meaningful update', () => {
    const prev = createOperatorStatus();
    const next = createOperatorStatus({
      strategy: {
        name: 'assisted-qso-queue',
        state: 'TX6',
        availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
      },
    });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats current transmission changes as a meaningful update', () => {
    const prev = createOperatorStatus({
      currentTransmissions: [{
        streamId: 'stream-1',
        text: 'JA1AAA BG5DRB PM01',
        audioFrequencyHz: 1200,
      }],
    });
    const next = createOperatorStatus({
      currentTransmissions: [{
        streamId: 'stream-1',
        text: 'JA1AAA BG5DRB R-07',
        audioFrequencyHz: 1200,
      }],
    });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('treats runtime stream changes as a meaningful update', () => {
    const prev = createOperatorStatus({
      runtime: {
        currentState: 'parallel',
        streams: [{
          streamId: 'stream-1',
          currentState: 'TX1',
          targetCallsign: 'JA1AAA',
          audioFrequencyHz: 1200,
          qsoLifecycleEpoch: 1,
          stateOptions: [{ id: 'TX1', label: 'TX1', transmitText: 'JA1AAA BG5DRB PM01' }],
        }],
      },
    });
    const next = createOperatorStatus({
      runtime: {
        currentState: 'parallel',
        streams: [{
          streamId: 'stream-1',
          currentState: 'TX3',
          targetCallsign: 'JA1AAA',
          audioFrequencyHz: 1260,
          qsoLifecycleEpoch: 1,
        }],
      },
    });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });
});

describe('RadioOperator transmit content', () => {
  it('prefers the Host transmission set over stale legacy slot content', () => {
    const operator = createOperatorStatus({
      currentSlot: 'TX3',
      slots: { TX3: 'JA1AAA BG5DRB R-12' },
      currentTransmissions: [{
        streamId: 'stream-1',
        text: 'JA1AAA BG5DRB R-07',
        audioFrequencyHz: 1260,
      }],
    });

    expect(resolveRadioOperatorCurrentTransmissions(operator)).toEqual([{
      streamId: 'stream-1',
      text: 'JA1AAA BG5DRB R-07',
      audioFrequencyHz: 1260,
    }]);
    expect(resolveRadioOperatorCyclePresentation(operator, createSlotInfo(), true).transmitContent)
      .toBe('JA1AAA BG5DRB R-07');
  });

  it('presents an idle WW Digi CQ transmission without an active protocol stream', () => {
    const operator = createOperatorStatus({
      strategy: {
        name: 'ww-digi',
        state: 'TX6',
        availableSlots: ['TX6'],
      },
      slots: undefined,
      runtime: {
        currentState: 'TX6',
        streams: [],
      },
      currentTransmissions: [{
        streamId: 'cq',
        text: 'CQ WW BG5DRB PM01',
        audioFrequencyHz: 1500,
      }],
    });

    expect(resolveRadioOperatorStreamPresentations(operator)).toEqual([{
      streamId: 'cq',
      text: 'CQ WW BG5DRB PM01',
      audioFrequencyHz: 1500,
    }]);
    expect(resolveRadioOperatorCyclePresentation(operator, createSlotInfo(), true)).toMatchObject({
      isTransmit: true,
      transmitContent: 'CQ WW BG5DRB PM01',
    });
  });

  it('summarizes three transmissions and joins each lane with its protocol state', () => {
    const currentTransmissions = [{
      streamId: 'stream-1',
      text: 'JA1AAA BG5DRB PM01',
      audioFrequencyHz: 1200,
    }, {
      streamId: 'stream-2',
      text: 'JA2BBB BG5DRB R-09',
      audioFrequencyHz: 1560,
    }, {
      streamId: 'stream-3',
      text: 'JA3CCC BG5DRB RR73',
      audioFrequencyHz: 1800,
    }];
    const operator = createOperatorStatus({
      currentSlot: 'parallel',
      currentTransmissions,
      runtime: {
        currentState: 'parallel',
        streams: [{
          streamId: 'stream-1',
          currentState: 'TX1',
          targetCallsign: 'JA1AAA',
          audioFrequencyHz: 1200,
          qsoLifecycleEpoch: 1,
          stateOptions: [{ id: 'TX1', label: 'TX1', transmitText: 'JA1AAA BG5DRB PM01' }],
        }, {
          streamId: 'stream-2',
          currentState: 'TX3',
          targetCallsign: 'JA2BBB',
          audioFrequencyHz: 1560,
          qsoLifecycleEpoch: 2,
        }, {
          streamId: 'stream-3',
          currentState: 'send-rr73',
          targetCallsign: 'JA3CCC',
          audioFrequencyHz: 1800,
          qsoLifecycleEpoch: 3,
        }],
      },
    });

    expect(summarizeRadioOperatorTransmissions(currentTransmissions)).toBe(
      'JA1AAA BG5DRB PM01 · JA2BBB BG5DRB R-09 · JA3CCC BG5DRB RR73',
    );
    expect(resolveRadioOperatorStreamPresentations(operator)).toEqual([{
      streamId: 'stream-1',
      currentState: 'TX1',
      qsoLifecycleEpoch: 1,
      stateOptions: [{ id: 'TX1', label: 'TX1', transmitText: 'JA1AAA BG5DRB PM01' }],
      targetCallsign: 'JA1AAA',
      audioFrequencyHz: 1200,
      text: 'JA1AAA BG5DRB PM01',
    }, {
      streamId: 'stream-2',
      currentState: 'TX3',
      qsoLifecycleEpoch: 2,
      targetCallsign: 'JA2BBB',
      audioFrequencyHz: 1560,
      text: 'JA2BBB BG5DRB R-09',
    }, {
      streamId: 'stream-3',
      currentState: 'send-rr73',
      qsoLifecycleEpoch: 3,
      targetCallsign: 'JA3CCC',
      audioFrequencyHz: 1800,
      text: 'JA3CCC BG5DRB RR73',
    }]);

    const streams = resolveRadioOperatorStreamPresentations(operator);
    expect(resolveSingleControllableStream(streams, 1)?.streamId).toBe('stream-1');
    expect(resolveSingleControllableStream(streams, 3)).toBeUndefined();
  });

  it('keeps a closing stream visible after its transmission has cleared', () => {
    const operator = createOperatorStatus({
      currentTransmissions: [],
      runtime: {
        currentState: 'parallel',
        streams: [{
          streamId: 'stream-2',
          currentState: 'closing',
          targetCallsign: 'JA2BBB',
          audioFrequencyHz: 1560,
          qsoLifecycleEpoch: 2,
        }],
      },
    });

    expect(resolveRadioOperatorStreamPresentations(operator)).toEqual([{
      streamId: 'stream-2',
      currentState: 'closing',
      qsoLifecycleEpoch: 2,
      targetCallsign: 'JA2BBB',
      audioFrequencyHz: 1560,
    }]);
  });

  it('falls back to the selected legacy TX slot when the Host field is absent', () => {
    const operator = createOperatorStatus({
      currentSlot: 'TX4',
      context: { ...createOperatorStatus().context, frequency: 1750 },
      slots: {
        TX1: 'JA1AAA BG5DRB PM01',
        TX2: 'BG5DRB JA1AAA -10',
        TX3: 'JA1AAA BG5DRB R-07',
        TX4: 'BG5DRB JA1AAA RR73',
        TX5: 'JA1AAA BG5DRB 73',
        TX6: 'CQ BG5DRB PM01',
      },
    });

    expect(resolveRadioOperatorCurrentTransmissions(operator)).toEqual([{
      streamId: 'default',
      text: 'BG5DRB JA1AAA RR73',
      audioFrequencyHz: 1750,
    }]);
  });

  it('uses one TX presentation before physical PTT becomes active', () => {
    const operator = createOperatorStatus({
      isTransmitting: true,
      isInActivePTT: false,
      currentSlot: 'TX6',
      slots: { TX6: 'CQ BG5DRB PM01' },
    });
    const presentation = resolveRadioOperatorCyclePresentation(
      operator,
      createSlotInfo({ cycleNumber: 42 }),
      true,
    );

    expect(presentation).toEqual({
      isTransmit: true,
      transmitContent: 'CQ BG5DRB PM01',
      progressColor: 'hsl(var(--heroui-danger) / 0.15)',
    });
  });

  it('keeps the preparing fallback available when no transmit text exists', () => {
    const operator = createOperatorStatus({
      currentSlot: 'TX5',
      slots: { TX5: '' },
    });

    expect(resolveRadioOperatorCyclePresentation(operator, createSlotInfo(), true).transmitContent)
      .toBe('');
  });

  it('stays in the listening presentation when TX is enabled without a transmit intent', () => {
    const operator = createOperatorStatus({
      isTransmitting: true,
      isInActivePTT: false,
      hasTransmitIntent: false,
      currentSlot: 'TX6',
      slots: { TX6: 'CQ BG5DRB PM01' },
    });

    expect(resolveRadioOperatorCyclePresentation(operator, createSlotInfo(), true)).toMatchObject({
      isTransmit: false,
      transmitContent: 'CQ BG5DRB PM01',
      progressColor: 'var(--ft8-cycle-even-bg)',
    });
  });

  it('uses the normal cycle presentation outside the operator TX cycle', () => {
    const operator = createOperatorStatus({
      isTransmitting: true,
      isInActivePTT: false,
    });
    const slotInfo = createSlotInfo({ cycleNumber: 42 });

    expect(resolveRadioOperatorCyclePresentation(operator, slotInfo, false)).toMatchObject({
      isTransmit: false,
      progressColor: 'var(--ft8-cycle-even-bg)',
    });
  });
});

describe('manual idle frequency picker', () => {
  it('avoids audio offsets already used by other operators', () => {
    const slotPack = createSlotPack({
      frames: [
        { message: 'CQ JA1AAA PM95', snr: -10, dt: 0, freq: 900, confidence: 0.9 },
        { message: 'CQ JA2BBB PM96', snr: -8, dt: 0, freq: 2100, confidence: 0.9 },
      ],
    });
    const currentOperator = createOperatorStatus({
      id: 'operator-1',
      context: { ...createOperatorStatus().context, frequency: 1000 },
    });
    const otherOperator = createOperatorStatus({
      id: 'operator-2',
      isTransmitting: false,
      context: { ...createOperatorStatus().context, frequency: 1500 },
    });

    expect(pickManualIdleFrequency({
      slotPacks: [slotPack],
      operators: [currentOperator, otherOperator],
      operatorId: 'operator-1',
      transmitCycles: [0],
      slotMs: 15000,
    })).toBe(425);
  });

  it('ignores the current operator frequency and invalid other-operator offsets', () => {
    const slotPack = createSlotPack({
      frames: [
        { message: 'CQ JA1AAA PM95', snr: -10, dt: 0, freq: 500, confidence: 0.9 },
        { message: 'CQ JA2BBB PM96', snr: -8, dt: 0, freq: 2500, confidence: 0.9 },
      ],
    });
    const currentOperator = createOperatorStatus({
      id: 'operator-1',
      context: { ...createOperatorStatus().context, frequency: 1500 },
    });
    const invalidOtherOperator = createOperatorStatus({
      id: 'operator-2',
      context: { ...createOperatorStatus().context, frequency: 4200 },
    });

    expect(pickManualIdleFrequency({
      slotPacks: [slotPack],
      operators: [currentOperator, invalidOtherOperator],
      operatorId: 'operator-1',
      transmitCycles: [0],
      slotMs: 15000,
    })).toBe(1500);
  });
});
