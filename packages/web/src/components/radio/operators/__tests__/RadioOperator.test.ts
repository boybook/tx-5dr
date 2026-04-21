import { describe, expect, it } from 'vitest';
import type { OperatorStatus } from '@tx5dr/contracts';

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
    cycleInfo: {
      currentCycle: 42,
      isTransmitCycle: true,
      cycleProgress: 0.25,
    },
    ...overrides,
  };
}

describe('RadioOperator progress animation helpers', () => {
  it('recomputes animation timing when cycleProgress advances within the same cycle', () => {
    const style = getRadioOperatorProgressAnimation({
      currentCycle: 42,
      isTransmitCycle: true,
      cycleProgress: 0.6,
    }, 15000);

    expect(style.animation).toBe('progress-bar 6000ms linear forwards');
    expect((style as Record<string, string>)['--progress-start']).toBe('40%');
  });

  it('returns a disabled animation when cycleInfo is missing', () => {
    expect(getRadioOperatorProgressAnimation(undefined, 15000)).toEqual({ animation: 'none' });
  });
});

describe('RadioOperator memo comparison', () => {
  it('treats same-cycle progress changes as a meaningful update', () => {
    const prev = createOperatorStatus();
    const next = createOperatorStatus({
      cycleInfo: {
        currentCycle: 42,
        isTransmitCycle: true,
        cycleProgress: 0.55,
      },
    });

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(false);
  });

  it('keeps identical operator status snapshots memoized', () => {
    const prev = createOperatorStatus();
    const next = createOperatorStatus();

    expect(shouldRadioOperatorPropsBeEqual(prev, next)).toBe(true);
  });
});
