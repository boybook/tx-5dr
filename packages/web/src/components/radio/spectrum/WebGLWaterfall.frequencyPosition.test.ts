import { describe, expect, it } from 'vitest';
import {
  WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ,
  getWaterfallFrequencyPositionPercent,
} from './WebGLWaterfall';

describe('WebGLWaterfall frequency positioning', () => {
  it('allows CW frequency band overlays to use exact audio Hz without legacy marker offset', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000, 0)).toBeCloseTo((800 / 3000) * 100, 6);
  });

  it('keeps the legacy visual offset available for older markers', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000)).toBeCloseTo(((800 + WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ) / 3000) * 100, 6);
  });
});
