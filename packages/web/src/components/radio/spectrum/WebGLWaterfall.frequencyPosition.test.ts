import { describe, expect, it } from 'vitest';
import {
  WATERFALL_DRAG_FREQUENCY_COMMIT_INTERVAL_MS,
  WATERFALL_HORIZONTAL_WHEEL_FREQUENCY_SCALE,
  WATERFALL_HORIZONTAL_WHEEL_SESSION_IDLE_MS,
  WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ,
  WATERFALL_WHEEL_DELTA_LINE,
  WATERFALL_WHEEL_DELTA_PAGE,
  WATERFALL_WHEEL_DELTA_PIXEL,
  buildWaterfallRulerTicks,
  clearWaterfallGestureOverrideForSource,
  easeSpectrumAxisTransition,
  formatWaterfallHoverFrequency,
  getWaterfallFrequencyAfterVisualDelta,
  getWaterfallFrequencyAtRatio,
  getWaterfallDragCommitDelayMs,
  getWaterfallDragTunedFrequency,
  getWaterfallFrequencyPositionPercent,
  getWaterfallHoverLabelLeftPx,
  getWaterfallHorizontalWheelTunedFrequency,
  getWaterfallSemanticFrequencyAtRatio,
  getWaterfallSemanticFrequencyPositionPercent,
  interpolateSpectrumAxis,
  normalizeWaterfallWheelDeltaX,
  shouldHandleWaterfallHorizontalWheel,
} from './WebGLWaterfall';
import { createFrequencyAxisTransform } from '../../../spectrum/frequencyAxisCalibration';

describe('WebGLWaterfall frequency positioning', () => {
  it('allows CW frequency band overlays to use exact audio Hz without legacy marker offset', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000, 0)).toBeCloseTo((800 / 3000) * 100, 6);
  });

  it('keeps the legacy visual offset available for older markers', () => {
    expect(getWaterfallFrequencyPositionPercent(800, 0, 3000, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ)).toBeCloseTo(((800 + WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ) / 3000) * 100, 6);
  });

  it('can map hover pointer ratios directly to the visual axis when no offset is requested', () => {
    expect(getWaterfallFrequencyAtRatio(0, 0, 3000)).toBe(0);
    expect(getWaterfallFrequencyAtRatio(0.5, 0, 3000)).toBe(1500);
    expect(getWaterfallFrequencyAtRatio(1, 0, 3000)).toBe(3000);
    expect(getWaterfallFrequencyPositionPercent(1500, 0, 3000, 0)).toBeCloseTo(50, 6);
  });

  it('applies the legacy visual offset for hover readouts to match right-click tuning', () => {
    expect(getWaterfallFrequencyAtRatio(0.5, 0, 3000, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ)).toBe(1485);
    expect(getWaterfallFrequencyPositionPercent(1485, 0, 3000, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ)).toBeCloseTo(50, 6);
  });

  it('builds a soft 0-3000 Hz baseband ruler with 100 Hz ticks and 500 Hz labels', () => {
    const ticks = buildWaterfallRulerTicks(0, 3000, 900);
    const tickFrequencies = ticks.map(tick => tick.frequency);
    const labeledTicks = ticks.filter(tick => tick.label);

    expect(tickFrequencies).toContain(100);
    expect(tickFrequencies).toContain(500);
    expect(tickFrequencies).toContain(3000);
    expect(ticks.find(tick => tick.frequency === 100)?.kind).toBe('minor');
    expect(ticks.find(tick => tick.frequency === 500)?.kind).toBe('major');
    expect(labeledTicks.map(tick => tick.label)).toEqual(['500', '1000', '1500', '2000', '2500', '3000']);
  });

  it('can apply the legacy visual offset to top ruler tick positions', () => {
    const ticks = buildWaterfallRulerTicks(0, 3000, 900, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ);
    const tick1500 = ticks.find(tick => tick.frequency === 1500);

    expect(tick1500?.positionPercent).toBeCloseTo(
      getWaterfallFrequencyPositionPercent(1500, 0, 3000, WATERFALL_LEGACY_FREQUENCY_POSITION_OFFSET_HZ),
      6,
    );
  });

  it('keeps SDR positioning unshifted when no explicit visual offset is provided', () => {
    expect(getWaterfallSemanticFrequencyPositionPercent(14_075_000, 14_070_000, 14_080_000)).toBeCloseTo(50, 6);
    expect(getWaterfallSemanticFrequencyAtRatio(0.5, 14_070_000, 14_080_000)).toBe(14_075_000);
  });

  it('places calibrated ruler ticks by visual frequency while labeling actual frequency', () => {
    const transform = createFrequencyAxisTransform({
      enabled: true,
      anchors: [
        { actualOffsetHz: -5000, visualOffsetHz: -5000 },
        { actualOffsetHz: 0, visualOffsetHz: 100 },
        { actualOffsetHz: 5000, visualOffsetHz: 5000 },
      ],
    }, 14_075_000);
    const ticks = buildWaterfallRulerTicks(14_070_000, 14_080_000, 900, 0, transform);
    const tick14075 = ticks.find(tick => tick.frequency === 14_075_000);

    expect(tick14075?.label).toBe('14.075000');
    expect(tick14075?.positionPercent).toBeCloseTo(51, 6);
  });

  it('returns actual calibrated frequencies for hover, right-click, drag, and wheel helpers', () => {
    const transform = createFrequencyAxisTransform({
      enabled: true,
      anchors: [
        { actualOffsetHz: -1000, visualOffsetHz: -1000 },
        { actualOffsetHz: 0, visualOffsetHz: 100 },
        { actualOffsetHz: 1000, visualOffsetHz: 1000 },
      ],
    }, 2000);

    expect(getWaterfallSemanticFrequencyAtRatio(0.55, 1000, 3000, transform)).toBeCloseTo(2000, 6);
    expect(getWaterfallSemanticFrequencyPositionPercent(2000, 1000, 3000, transform)).toBeCloseTo(55, 6);
    expect(getWaterfallFrequencyAfterVisualDelta(2000, 90, transform)).toBeCloseTo(2100, 6);
    expect(getWaterfallFrequencyAfterVisualDelta(2000, -110, transform)).toBeCloseTo(1900, 6);
  });

  it('reduces baseband ruler label density when the panel is narrow', () => {
    const labels = buildWaterfallRulerTicks(0, 3000, 260)
      .map(tick => tick.label)
      .filter(Boolean);

    expect(labels).toEqual(['1000', '2000', '3000']);
  });

  it('uses nice-step labels for wide absolute-frequency rulers', () => {
    const ticks = buildWaterfallRulerTicks(14_070_000, 14_080_000, 900);
    const majorTicks = ticks.filter(tick => tick.kind === 'major');

    expect(majorTicks.length).toBeGreaterThanOrEqual(2);
    expect(majorTicks.every(tick => Number.isFinite(tick.positionPercent))).toBe(true);
    expect(majorTicks.some(tick => tick.label === '14.075000')).toBe(true);
  });

  it('formats and clamps hover readout labels near ruler edges', () => {
    expect(formatWaterfallHoverFrequency(1234.4)).toBe('1234 Hz');
    expect(formatWaterfallHoverFrequency(14_074_123)).toBe('14.074123 MHz');
    expect(getWaterfallHoverLabelLeftPx(0, 300)).toBeGreaterThan(0);
    expect(getWaterfallHoverLabelLeftPx(100, 300)).toBeLessThan(300);
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
