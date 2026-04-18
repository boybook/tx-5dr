import { describe, expect, it } from 'vitest';
import { MODES, FT4_WINDOW_PRESETS, FT8_WINDOW_PRESETS } from '../src/schema/mode.schema';

describe('MODES.FT4 timing constants', () => {
  it('aligns FT4 transmitTiming with WSJT-X standard (T+0.5s signal start)', () => {
    expect(MODES.FT4.transmitTiming).toBe(500);
  });

  it('keeps FT4 encodeAdvance large enough to finish encode before transmit', () => {
    // FT4 slot is 7.5s; encoder takes 100-200ms. encodeStart must fire BEFORE
    // transmitStart with enough slack for AudioMixer to schedule playback.
    expect(MODES.FT4.encodeAdvance).toBeGreaterThanOrEqual(200);
    expect(MODES.FT4.encodeAdvance).toBeLessThan(MODES.FT4.transmitTiming);
  });

  it('keeps FT4 windowTiming dual-pass with an early decode', () => {
    expect(MODES.FT4.windowTiming).toEqual([-1500, 0]);
  });

  it('keeps FT4 slot length at the WSJT-X standard 7.5s', () => {
    expect(MODES.FT4.slotMs).toBe(7500);
  });
});

describe('MODES.FT8 timing constants (regression guard)', () => {
  it('keeps FT8 untouched at WSJT-X standard 500ms / encodeAdvance 0', () => {
    expect(MODES.FT8.transmitTiming).toBe(500);
    expect(MODES.FT8.encodeAdvance).toBe(0);
    expect(MODES.FT8.slotMs).toBe(15000);
  });

  it('keeps FT8 balanced window preset at WSJT-X 3-pass schedule', () => {
    expect(FT8_WINDOW_PRESETS.balanced).toEqual([-3200, -1500, -300]);
  });
});

describe('FT4_WINDOW_PRESETS', () => {
  it('exposes maximum / balanced / lightweight in monotonically increasing order', () => {
    for (const [preset, timings] of Object.entries(FT4_WINDOW_PRESETS)) {
      const sorted = [...timings].sort((a, b) => a - b);
      expect(timings, `${preset} should be already sorted ascending`).toEqual(sorted);
    }
  });

  it('balanced preset keeps an early pass so next-cycle encodeStart sees fresh decodes', () => {
    expect(FT4_WINDOW_PRESETS.balanced.some((o) => o < 0)).toBe(true);
  });
});
