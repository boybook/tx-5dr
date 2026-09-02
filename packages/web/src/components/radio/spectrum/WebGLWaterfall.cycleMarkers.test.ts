import { describe, expect, it } from 'vitest';
import {
  areCycleMarkerPositionsEqual,
  buildCycleMarkerPositions,
  getWaterfallScrollAnimationDurationMs,
  resolveNextCycleMarkerPositions,
} from './WebGLWaterfall';

describe('getWaterfallScrollAnimationDurationMs', () => {
  it('uses the negotiated interval for every row in a batch', () => {
    expect(getWaterfallScrollAnimationDurationMs(200, 1)).toBe(200);
    expect(getWaterfallScrollAnimationDurationMs(200, 3)).toBe(600);
    expect(getWaterfallScrollAnimationDurationMs(Number.NaN, 1)).toBe(100);
  });
});

describe('buildCycleMarkerPositions', () => {
  it('creates marker positions when FT8 rows cross cycle boundaries', () => {
    const markers = buildCycleMarkerPositions([30050, 29950, 15100, 14900], 15000);

    expect(markers.map(marker => marker.timestamp)).toEqual([30000, 15000]);
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.topPercent).toBeGreaterThanOrEqual(0);
      expect(marker.topPercent).toBeLessThanOrEqual(100);
      expect(Number.isFinite(marker.topPercent)).toBe(true);
    }
  });

  it('does not create markers when slot duration is disabled or timestamps are insufficient', () => {
    expect(buildCycleMarkerPositions([15000, 14900], 0)).toEqual([]);
    expect(buildCycleMarkerPositions([15000, 14900], null)).toEqual([]);
    expect(buildCycleMarkerPositions([15000], 15000)).toEqual([]);
  });

  it('ignores invalid or non-descending timestamp pairs', () => {
    const markers = buildCycleMarkerPositions([Number.NaN, 15000, 15100, 14900], 15000);

    expect(markers.map(marker => marker.timestamp)).toEqual([15000]);
    expect(markers.every(marker => Number.isFinite(marker.topPercent))).toBe(true);
  });

  it('keeps marker state identity when calculated positions are unchanged', () => {
    const currentMarkers = buildCycleMarkerPositions([30050, 29950], 15000);
    const nextMarkers = resolveNextCycleMarkerPositions(currentMarkers, [30050, 29950], true, 15000, 2);

    expect(nextMarkers).toBe(currentMarkers);
    expect(areCycleMarkerPositionsEqual(currentMarkers, nextMarkers)).toBe(true);
  });

  it('uses only rows that fit in the visible texture when positioning markers', () => {
    const timestamps = Array.from({ length: 1024 }, (_, index) => 30_050 - index * 150);
    const markers = resolveNextCycleMarkerPositions([], timestamps, true, 15_000, 128);

    expect(markers.map(marker => marker.timestamp)).toEqual([30_000, 15_000]);
    expect(markers.every(marker => marker.topPercent <= 100)).toBe(true);
    expect(markers[1]?.topPercent).toBeCloseTo(((100.5 + 1 / 3) / 128) * 100, 5);
  });

  it('clears marker state only when cycle markers are disabled with existing markers', () => {
    const currentMarkers = buildCycleMarkerPositions([30050, 29950], 15000);
    const disabledMarkers = resolveNextCycleMarkerPositions(currentMarkers, [30050, 29950], false, 15000, 2);
    const alreadyEmptyMarkers: typeof currentMarkers = [];

    expect(disabledMarkers).toEqual([]);
    expect(disabledMarkers).not.toBe(currentMarkers);
    expect(resolveNextCycleMarkerPositions(alreadyEmptyMarkers, [30050, 29950], false, 15000, 2)).toBe(alreadyEmptyMarkers);
  });
});
