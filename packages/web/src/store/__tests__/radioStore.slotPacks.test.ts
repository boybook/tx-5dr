import { describe, expect, it } from 'vitest';
import type { SlotPack } from '@tx5dr/contracts';
import { initialSlotPacksState, slotPacksReducer } from '../radioStore';

function createSlotPack(slotId: string, startMs: number, message: string, updateSeq?: number): SlotPack {
  return {
    slotId,
    startMs,
    endMs: startMs + 15_000,
    frames: [
      {
        snr: -10,
        dt: 0.2,
        freq: 1200,
        message,
        confidence: 1,
      },
    ],
    stats: {
      totalDecodes: 1,
      successfulDecodes: 1,
      totalFramesBeforeDedup: 1,
      totalFramesAfterDedup: 1,
      lastUpdated: startMs,
      ...(updateSeq !== undefined && { updateSeq }),
    },
    decodeHistory: [],
  };
}

describe('radioStore slot packs reducer', () => {
  it('buffers incoming slot packs during a sync and swaps them in on commit', () => {
    const visibleState = slotPacksReducer(initialSlotPacksState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('old-slot', 1000, 'CQ OLD1'),
    });

    const syncingState = slotPacksReducer(visibleState, { type: 'beginSync' });
    const bufferedState = slotPacksReducer(syncingState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('new-slot', 2000, 'CQ NEW1'),
    });
    const committedState = slotPacksReducer(bufferedState, { type: 'commitSync' });

    expect(syncingState.slotPacks.map((slotPack) => slotPack.slotId)).toEqual(['old-slot']);
    expect(bufferedState.slotPacks.map((slotPack) => slotPack.slotId)).toEqual(['old-slot']);
    expect(bufferedState.pendingSlotPacks.map((slotPack) => slotPack.slotId)).toEqual(['new-slot']);
    expect(committedState.slotPacks.map((slotPack) => slotPack.slotId)).toEqual(['new-slot']);
    expect(committedState.pendingSlotPacks).toEqual([]);
    expect(committedState.isSyncing).toBe(false);
  });

  it('ignores out-of-order slot pack updates with an older updateSeq', () => {
    const newerState = slotPacksReducer(initialSlotPacksState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('slot-1', 1000, 'R9WXK BG5BNW PM00', 2),
    });

    const staleState = slotPacksReducer(newerState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('slot-1', 1000, 'CQ BG5BNW PM00', 1),
    });

    expect(staleState.slotPacks).toBe(newerState.slotPacks);
    expect(staleState.slotPacks[0]?.frames[0]?.message).toBe('R9WXK BG5BNW PM00');
  });

  it('still accepts legacy slot pack updates without updateSeq', () => {
    const initialState = slotPacksReducer(initialSlotPacksState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('slot-1', 1000, 'CQ BG5BNW PM00'),
    });

    const updatedState = slotPacksReducer(initialState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('slot-1', 1000, 'R9WXK BG5BNW PM00'),
    });

    expect(updatedState.slotPacks[0]?.frames[0]?.message).toBe('R9WXK BG5BNW PM00');
  });
});
