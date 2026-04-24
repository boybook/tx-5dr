import { describe, expect, it } from 'vitest';
import type { OperatorStatus, SlotInfo } from '@tx5dr/contracts';
import { initialRadioState, radioReducer } from '../radioStore';

function createOperatorStatus(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: 'op-1',
    isActive: true,
    isTransmitting: false,
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
    slots: { TX6: 'CQ BG5DRB PM01' },
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

describe('radioReducer global slot state', () => {
  it('stores slotStart globally without rewriting operators', () => {
    const operator = createOperatorStatus();
    const state = {
      ...initialRadioState,
      operators: [operator],
    };
    const slotInfo = createSlotInfo();

    const next = radioReducer(state, { type: 'slotStart', payload: slotInfo });

    expect(next.currentSlotInfo).toBe(slotInfo);
    expect(next.operators[0]).toBe(operator);
  });

  it('operatorStatusUpdate updates operator data without changing global slot state', () => {
    const slotInfo = createSlotInfo();
    const state = {
      ...initialRadioState,
      currentSlotInfo: slotInfo,
      operators: [createOperatorStatus()],
    };
    const updated = createOperatorStatus({ isTransmitting: true });

    const next = radioReducer(state, { type: 'operatorStatusUpdate', payload: updated });

    expect(next.currentSlotInfo).toBe(slotInfo);
    expect(next.operators[0]).toEqual(updated);
  });
});
