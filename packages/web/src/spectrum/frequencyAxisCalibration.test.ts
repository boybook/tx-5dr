import { describe, expect, it } from 'vitest';
import {
  IDENTITY_FREQUENCY_AXIS_TRANSFORM,
  createFrequencyAxisTransform,
  type FrequencyAxisCalibrationConfig,
} from './frequencyAxisCalibration';

function createConfig(anchors: FrequencyAxisCalibrationConfig['anchors']): FrequencyAxisCalibrationConfig {
  return { enabled: true, anchors };
}

describe('frequency axis calibration', () => {
  it('uses identity mapping when disabled or missing enough anchors', () => {
    expect(createFrequencyAxisTransform(null)).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);
    expect(createFrequencyAxisTransform({ enabled: false, anchors: [
      { actualOffsetHz: 0, visualOffsetHz: 10 },
      { actualOffsetHz: 1000, visualOffsetHz: 1020 },
    ] })).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);
    expect(createFrequencyAxisTransform(createConfig([{ actualOffsetHz: 0, visualOffsetHz: 10 }]))).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);
  });

  it('maps exact relative anchors and interpolates between anchors in both directions', () => {
    const transform = createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: -1000, visualOffsetHz: -990 },
      { actualOffsetHz: 0, visualOffsetHz: 40 },
      { actualOffsetHz: 1000, visualOffsetHz: 1060 },
    ]));

    expect(transform.isIdentity).toBe(false);
    expect(transform.toVisualHz(-1000)).toBe(-990);
    expect(transform.toVisualHz(-500)).toBe(-475);
    expect(transform.toActualHz(40)).toBe(0);
    expect(transform.toActualHz(550)).toBe(500);
  });

  it('applies relative calibration around the supplied SDR reference frequency', () => {
    const referenceFrequencyHz = 14_074_000;
    const transform = createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: -1000, visualOffsetHz: -1005 },
      { actualOffsetHz: 0, visualOffsetHz: 20 },
      { actualOffsetHz: 1000, visualOffsetHz: 1010 },
    ]), referenceFrequencyHz);

    expect(transform.toVisualHz(14_074_000)).toBe(14_074_020);
    expect(transform.toVisualHz(14_074_500)).toBe(14_074_515);
    expect(transform.toActualHz(14_074_020)).toBe(14_074_000);
  });

  it('keeps round-trip error negligible inside calibrated intervals', () => {
    const referenceFrequencyHz = 7_075_000;
    const transform = createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: -25_000, visualOffsetHz: -25_010 },
      { actualOffsetHz: 0, visualOffsetHz: 30 },
      { actualOffsetHz: 25_000, visualOffsetHz: 25_010 },
    ]), referenceFrequencyHz);

    for (const frequency of [7_050_000, 7_061_250, 7_075_000, 7_088_500, 7_100_000]) {
      expect(transform.toActualHz(transform.toVisualHz(frequency))).toBeCloseTo(frequency, 6);
    }
  });

  it('extends outside the anchor range with the nearest constant offset', () => {
    const transform = createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: -1000, visualOffsetHz: -985 },
      { actualOffsetHz: 1000, visualOffsetHz: 1010 },
    ]));

    expect(transform.toVisualHz(-1500)).toBe(-1485);
    expect(transform.toActualHz(-1485)).toBe(-1500);
    expect(transform.toVisualHz(1500)).toBe(1510);
    expect(transform.toActualHz(1510)).toBe(1500);
  });

  it('falls back to identity for non-monotonic or invalid anchor sets', () => {
    expect(createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: 1000, visualOffsetHz: 1010 },
      { actualOffsetHz: -1000, visualOffsetHz: -995 },
      { actualOffsetHz: 0, visualOffsetHz: -1005 },
    ]))).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);

    expect(createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: 0, visualOffsetHz: 10 },
      { actualOffsetHz: 1000, visualOffsetHz: 1020 },
      { actualOffsetHz: Number.NaN, visualOffsetHz: 1500 },
    ]))).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);

    expect(createFrequencyAxisTransform(createConfig([
      { actualOffsetHz: -1000, visualOffsetHz: -1000 },
      { actualOffsetHz: 1000, visualOffsetHz: 1000 },
    ]), Number.NaN)).toBe(IDENTITY_FREQUENCY_AXIS_TRANSFORM);
  });
});
