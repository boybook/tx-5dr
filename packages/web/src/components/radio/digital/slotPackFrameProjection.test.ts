import { describe, expect, it } from 'vitest';
import type { SlotPack } from '@tx5dr/contracts';
import { parseCallsignFilterRules } from '@tx5dr/core';
import { createSlotPackFrameProjector } from './slotPackFrameProjection';

const options = { slotMs: 15000, filterRules: [], dxccBlockEnabled: false, blockedDxccEntityCodes: [] };
function pack(startMs: number, message = 'CQ JA1AAA PM95'): SlotPack {
  return {
    slotId: String(startMs), startMs, endMs: startMs + 15000,
    frames: [{ snr: -12, dt: .2, freq: 1200.4, message, confidence: 1 }],
    stats: { totalDecodes: 1, successfulDecodes: 1, totalFramesBeforeDedup: 1, totalFramesAfterDedup: 1, lastUpdated: startMs, updateSeq: 1 },
    decodeHistory: [],
  };
}

describe('slot pack display projection', () => {
  it('keeps unchanged historical groups and rows when one slot is revised', () => {
    const project = createSlotPackFrameProjector(options);
    const old = pack(15000);
    const live = pack(30000);
    const first = project([live, old]);
    const revised = { ...live, frames: [...live.frames, { ...live.frames[0], message: 'JA1AAA K1ABC -10' }] };
    const next = project([old, revised]);
    expect(next[0]).toBe(first[0]);
    expect(next[0].messages[0]).toBe(first[0].messages[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1].messages).toHaveLength(2);
    expect(first[1].messages).toHaveLength(1);
    expect(project([])).toEqual([]);
  });

  it('keeps FT4 half-second alignment, cycles, frequency context and message fields', () => {
    const source = { ...pack(7500), frequencyContext: { frequency: 14080000, mode: 'FT4', band: '20m' } };
    const [group] = createSlotPackFrameProjector({ ...options, slotMs: 7500 })([source]);
    expect(group).toMatchObject({ startMs: 7500, cycle: 'odd', type: 'receive', frequencyContext: source.frequencyContext });
    expect(group.messages[0]).toMatchObject({ utc: '00:00:07', db: -12, dt: .2, freq: 1200, message: source.frames[0].message, locationGrid: 'PM95' });
  });

  it('merges packs in the same aligned slot without modifying cached groups', () => {
    const project = createSlotPackFrameProjector(options);
    const first = pack(15000);
    const second = pack(16000, 'CQ K1ABC FN42');
    const original = project([first])[0];
    const merged = project([second, first]);
    expect(merged).toHaveLength(1);
    expect(merged[0].messages.map(message => message.utc)).toEqual(['00:00:15', '00:00:16']);
    expect(original.messages).toHaveLength(1);
    expect(project([first])[0]).toBe(original);
  });

  it('reprojects filters independently and never displays TX sentinel rows', () => {
    const source = pack(15000);
    source.frames.push({ ...source.frames[0], snr: -999, message: 'CQ K1ABC FN42' });
    const all = createSlotPackFrameProjector(options)([source]);
    const filtered = createSlotPackFrameProjector({ ...options, filterRules: parseCallsignFilterRules(['JA1AAA'], 'blocklist') })([source]);
    expect(all[0].messages).toHaveLength(1);
    expect(filtered).toEqual([]);
    expect(createSlotPackFrameProjector({ ...options, slotMs: 0 })([source])).toEqual([]);
  });
});
