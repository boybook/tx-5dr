import { describe, expect, it } from 'vitest';
import {
  WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ,
  easeSpectrumAxisTransition,
  getWaterfallFrequencyPositionPercent,
  interpolateSpectrumAxis,
} from './WebGLWaterfall';

describe('WebGLWaterfall frequency positioning', () => {
  it('allows CW frequency band overlays to use exact audio Hz without legacy marker offset', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000, 0)).toBeCloseTo((800 / 3000) * 100, 6);
  });

  it('keeps the legacy visual offset available for older markers', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000)).toBeCloseTo(((800 + WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ) / 3000) * 100, 6);
  });

  it('uses a nonlinear transition curve with fixed endpoints', () => {
    expect(easeSpectrumAxisTransition(-1)).toBe(0);
    expect(easeSpectrumAxisTransition(0)).toBe(0);
    expect(easeSpectrumAxisTransition(0.25)).toBeLessThan(0.06);
    expect(easeSpectrumAxisTransition(0.5)).toBeCloseTo(0.5, 6);
    expect(easeSpectrumAxisTransition(0.75)).toBeGreaterThan(0.94);
    expect(easeSpectrumAxisTransition(1)).toBe(1);
    expect(easeSpectrumAxisTransition(2)).toBe(1);
  });

  it('interpolates spectrum axes with the nonlinear curve while keeping target bin count', () => {
    const axis = interpolateSpectrumAxis(
      { minHz: 900, maxHz: 1100, binCount: 128 },
      { minHz: 1000, maxHz: 1200, binCount: 256 },
      0.5,
    );

    expect(axis).toEqual({ minHz: 950, maxHz: 1150, binCount: 256 });
  });
});
