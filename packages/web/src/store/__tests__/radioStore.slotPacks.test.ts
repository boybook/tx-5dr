import { describe, expect, it } from 'vitest';
import { SLOT_PACK_HISTORY_LIMIT, type SlotPack } from '@tx5dr/contracts';
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

function createEmptySlotPack(slotId: string, startMs: number): SlotPack {
  return {
    ...createSlotPack(slotId, startMs, 'EMPTY'),
    frames: [],
    stats: {
      totalDecodes: 1,
      successfulDecodes: 0,
      totalFramesBeforeDedup: 0,
      totalFramesAfterDedup: 0,
      lastUpdated: startMs,
    },
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

  it('ignores slot pack updates with invalid time values', () => {
    const validState = slotPacksReducer(initialSlotPacksState, {
      type: 'slotPackUpdated',
      payload: createSlotPack('slot-1', 1000, 'CQ BG5BNW PM00'),
    });

    const invalidState = slotPacksReducer(validState, {
      type: 'slotPackUpdated',
      payload: {
        ...createSlotPack('slot-bad', 2000, 'BAD TIME'),
        startMs: Number.NaN,
      },
    });

    expect(invalidState).toBe(validState);
    expect(invalidState.slotPacks).toHaveLength(1);
    expect(invalidState.slotPacks[0]?.frames[0]?.message).toBe('CQ BG5BNW PM00');
  });

  it('retains the latest effective slot packs without counting empty packs', () => {
    let state = initialSlotPacksState;

    for (let index = 0; index < SLOT_PACK_HISTORY_LIMIT + 1; index++) {
      state = slotPacksReducer(state, {
        type: 'slotPackUpdated',
        payload: createSlotPack(`slot-${index}`, index * 15_000, `CQ TEST${index}`),
      });
    }

    state = slotPacksReducer(state, {
      type: 'slotPackUpdated',
      payload: createEmptySlotPack('empty-latest', (SLOT_PACK_HISTORY_LIMIT + 1) * 15_000),
    });

    const nonEmptySlotPacks = state.slotPacks.filter((slotPack) => slotPack.frames.length > 0);
    expect(nonEmptySlotPacks).toHaveLength(SLOT_PACK_HISTORY_LIMIT);
    expect(nonEmptySlotPacks[0]?.slotId).toBe('slot-1');
    expect(nonEmptySlotPacks.at(-1)?.slotId).toBe(`slot-${SLOT_PACK_HISTORY_LIMIT}`);
    expect(state.slotPacks.some((slotPack) => slotPack.slotId === 'empty-latest')).toBe(true);
    expect(state.totalMessages).toBe(SLOT_PACK_HISTORY_LIMIT);
  });

  it('applies the effective slot pack limit while buffering a sync', () => {
    let state = slotPacksReducer(initialSlotPacksState, { type: 'beginSync' });

    for (let index = 0; index < SLOT_PACK_HISTORY_LIMIT + 1; index++) {
      state = slotPacksReducer(state, {
        type: 'slotPackUpdated',
        payload: createSlotPack(`sync-slot-${index}`, index * 15_000, `CQ SYNC${index}`),
      });
    }

    const committedState = slotPacksReducer(state, { type: 'commitSync' });
    expect(committedState.slotPacks).toHaveLength(SLOT_PACK_HISTORY_LIMIT);
    expect(committedState.slotPacks[0]?.slotId).toBe('sync-slot-1');
    expect(committedState.slotPacks.at(-1)?.slotId).toBe(`sync-slot-${SLOT_PACK_HISTORY_LIMIT}`);
    expect(committedState.totalMessages).toBe(SLOT_PACK_HISTORY_LIMIT);
    expect(committedState.pendingSlotPacks).toEqual([]);
  });
});
