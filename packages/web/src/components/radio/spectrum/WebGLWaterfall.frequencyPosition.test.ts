import { describe, expect, it } from 'vitest';
import {
  WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
  WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE,
  WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS,
  WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ,
  WATERFALL_WHEEL_DELTA_LINE,
  WATERFALL_WHEEL_DELTA_PAGE,
  WATERFALL_WHEEL_DELTA_PIXEL,
  clearWaterfallGestureOverrideForSource,
  easeSpectrumAxisTransition,
  getWaterfallDragCommitDelayMs,
  getWaterfallDragTunedFrequency,
  getWaterfallFrequencyPositionPercent,
  getWaterfallHorizontalWheelTunedFrequency,
  interpolateSpectrumAxis,
  normalizeWaterfallWheelDeltaX,
  shouldHandleWaterfallHorizontalWheel,
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

  it('throttles drag frequency commits at the configured cadence', () => {
    expect(WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS).toBe(80);
    expect(getWaterfallDragCommitDelayMs(1_000, null)).toBe(0);
    expect(getWaterfallDragCommitDelayMs(1_040, 1_000)).toBe(40);
    expect(getWaterfallDragCommitDelayMs(1_080, 1_000)).toBe(0);
  });

  it('maps drag distance to a one-to-one image-following tuning delta', () => {
    expect(getWaterfallDragTunedFrequency(14_200_000, 25, 40)).toBe(14_199_000);
    expect(getWaterfallDragTunedFrequency(14_200_000, -25, 40)).toBe(14_201_000);
  });

  it('normalizes horizontal wheel deltas and ignores vertical/pinch gestures', () => {
    expect(WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS).toBe(350);
    expect(normalizeWaterfallWheelDeltaX({ deltaX: 2, deltaMode: WATERFALL_WHEEL_DELTA_PIXEL }, 800)).toBe(2);
    expect(normalizeWaterfallWheelDeltaX({ deltaX: 2, deltaMode: WATERFALL_WHEEL_DELTA_LINE }, 800)).toBe(32);
    expect(normalizeWaterfallWheelDeltaX({ deltaX: 2, deltaMode: WATERFALL_WHEEL_DELTA_PAGE }, 800)).toBe(1600);
    expect(shouldHandleWaterfallHorizontalWheel({ deltaX: 10, deltaY: 1, ctrlKey: false })).toBe(true);
    expect(shouldHandleWaterfallHorizontalWheel({ deltaX: 1, deltaY: 10, ctrlKey: false })).toBe(false);
    expect(shouldHandleWaterfallHorizontalWheel({ deltaX: 10, deltaY: 1, ctrlKey: true })).toBe(false);
  });

  it('maps horizontal wheel distance to a slower fine-tuning frequency delta', () => {
    expect(WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE).toBe(0.25);
    expect(getWaterfallHorizontalWheelTunedFrequency(14_200_000, 100, 40)).toBe(14_201_000);
    expect(getWaterfallHorizontalWheelTunedFrequency(14_200_000, -100, 40)).toBe(14_199_000);
  });

  it('clears only the gesture overlay owned by the ending gesture source', () => {
    const mouseDragOverride = { source: 'mouse-drag' as const, frequency: 14_200_000 };
    const wheelOverride = { source: 'horizontal-wheel' as const, frequency: 14_201_000 };

    expect(clearWaterfallGestureOverrideForSource(mouseDragOverride, 'horizontal-wheel')).toBe(mouseDragOverride);
    expect(clearWaterfallGestureOverrideForSource(wheelOverride, 'horizontal-wheel')).toBeNull();
  });
});
