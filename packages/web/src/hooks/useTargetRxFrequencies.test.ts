import { describe, expect, it } from 'vitest';
import type { OperatorStatus, SlotPack, FrameMessage } from '@tx5dr/contracts';
import { buildTargetRxFrequencies } from './useTargetRxFrequencies';

function createOperator({
  id,
  isActive = true,
  myCall = 'N0CALL',
  targetCall = 'K1ABC',
}: {
  id: string;
  isActive?: boolean;
  myCall?: string;
  targetCall?: string;
}): OperatorStatus {
  return {
    id,
    isActive,
    isTransmitting: false,
    isInActivePTT: false,
    context: {
      myCall,
      myGrid: 'AA00',
      targetCall,
      frequency: 1500,
    },
    strategy: {
      name: 'manual',
      state: 'idle',
      availableSlots: [],
    },
    slots: {},
    transmitCycles: [0],
  };
}

function createFrame(message: string, freq: number): FrameMessage {
  return {
    snr: -10,
    freq,
    dt: 0.1,
    message,
    confidence: 1,
  };
}

function createSlotPack(frames: FrameMessage[], startMs = 1000): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + 15000,
    frames,
    stats: {
      totalDecodes: 1,
      successfulDecodes: 1,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs,
    },
    decodeHistory: [],
  };
}

describe('buildTargetRxFrequencies', () => {
  it('removes the old RX marker when targetCall changes or is cleared', () => {
    const slotPacks = [createSlotPack([createFrame('CQ K1ABC FN42', 1234)])];

    expect(buildTargetRxFrequencies([
      createOperator({ id: 'op-1', targetCall: 'K1ABC' }),
    ], slotPacks)).toEqual([
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
    ]);

    expect(buildTargetRxFrequencies([
      createOperator({ id: 'op-1', targetCall: 'W1AW' }),
    ], slotPacks)).toEqual([]);

    expect(buildTargetRxFrequencies([
      createOperator({ id: 'op-1', targetCall: '' }),
    ], slotPacks)).toEqual([]);
  });

  it('skips inactive operators', () => {
    const result = buildTargetRxFrequencies([
      createOperator({ id: 'op-1', isActive: false, targetCall: 'K1ABC' }),
    ], [createSlotPack([createFrame('CQ K1ABC FN42', 1234)])]);

    expect(result).toEqual([]);
  });

  it('keeps duplicate callsigns separate by operatorId', () => {
    const result = buildTargetRxFrequencies([
      createOperator({ id: 'op-1', targetCall: 'K1ABC' }),
      createOperator({ id: 'op-2', targetCall: 'K1ABC' }),
    ], [createSlotPack([createFrame('CQ K1ABC FN42', 1234)])]);

    expect(result).toEqual([
      { operatorId: 'op-1', callsign: 'K1ABC', frequency: 1234 },
      { operatorId: 'op-2', callsign: 'K1ABC', frequency: 1234 },
    ]);
  });

  it('returns no RX marker when slot history has no target callsign', () => {
    const result = buildTargetRxFrequencies([
      createOperator({ id: 'op-1', targetCall: 'K1ABC' }),
    ], [createSlotPack([createFrame('CQ W1AW FN31', 900)])]);

    expect(result).toEqual([]);
  });
});
