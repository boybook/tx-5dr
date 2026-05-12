import { describe, expect, it } from 'vitest';
import {
  CW_DECODER_FILTER_WIDTH_OPTIONS,
  clampCWDecoderFilterWidth,
  clampCWDecoderTargetFreq,
  snapCWDecoderTuningValue,
} from '../cwDecoderTuning';

describe('cwDecoderTuning', () => {
  it('matches official bandwidth shortcuts', () => {
    expect([...CW_DECODER_FILTER_WIDTH_OPTIONS]).toEqual([100, 150, 250, 500, 800]);
  });

  it('snaps and clamps target frequency and filter width', () => {
    expect(snapCWDecoderTuningValue(637)).toBe(625);
    expect(clampCWDecoderTargetFreq(637)).toBe(635);
    expect(clampCWDecoderTargetFreq(40)).toBe(100);
    expect(clampCWDecoderTargetFreq(1512)).toBe(1500);
    expect(clampCWDecoderFilterWidth(237)).toBe(225);
    expect(clampCWDecoderFilterWidth(73)).toBe(100);
    expect(clampCWDecoderFilterWidth(920)).toBe(800);
  });
});
