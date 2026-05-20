import { describe, expect, it } from 'vitest';
import type { OperatorStatus, SlotInfo, SlotPack } from '@tx5dr/contracts';

import {
  getRadioOperatorProgressAnimation,
  shouldRadioOperatorPropsBeEqual,
} from '../radioOperatorProgress';
import { pickManualIdleFrequency } from '../radioOperatorIdleFrequency';

function createOperatorStatus(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: 'operator-1',
    isActive: true,
    isTransmitting: true,
    isInActivePTT: false,
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

  it('treats transmit cycle changes as a meaningful update', () => {
    const prev = createOperatorStatus({ transmitCycles: [0] });
    const next = createOperatorStatus({ transmitCycles: [1] });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
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
