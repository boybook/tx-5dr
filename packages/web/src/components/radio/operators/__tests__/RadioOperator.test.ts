import { describe, expect, it } from 'vitest';
import type { OperatorStatus, SlotInfo } from '@tx5dr/contracts';

import {
  getRadioOperatorProgressAnimation,
  shouldRadioOperatorPropsBeEqual,
} from '../radioOperatorProgress';

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

describe('RadioOperator progress animation helpers', () => {
  it('starts animation from the global slot phase sample', () => {
    const style = getRadioOperatorProgressAnimation(createSlotInfo({ phaseMs: 9000 }), 15000);

    expect(style.animation).toBe('progress-bar 6000ms linear forwards');
    expect((style as Record<string, string>)['--progress-start']).toBe('40%');
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
