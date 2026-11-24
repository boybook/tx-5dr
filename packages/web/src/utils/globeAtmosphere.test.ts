import { describe, expect, it } from 'vitest';
import { HAZE_MAX_OPACITY, getHazeOpacity } from './globeAtmosphere';

/** Facing of the surface seen at `fraction` of the disc radius from its centre (orthographic view). */
const facingAt = (fraction: number) => Math.sqrt(1 - fraction ** 2);

describe('horizon haze', () => {
  it('leaves the ground below the camera clear and is thickest at the horizon', () => {
    expect(getHazeOpacity(1)).toBe(0);
    expect(getHazeOpacity(0)).toBeCloseTo(HAZE_MAX_OPACITY);
    const outward = [0, 0.5, 0.8, 0.95, 1].map(fraction => getHazeOpacity(facingAt(fraction)));
    outward.slice(1).forEach((opacity, index) => expect(opacity).toBeGreaterThan(outward[index]));
  });

  // Haze must not cost legibility: the inner disc, where most content sits,
  // stays nearly clear and even the horizon keeps the ground visible.
  it('keeps the inner disc readable', () => {
    expect(getHazeOpacity(facingAt(0.5))).toBeLessThan(0.02);
    expect(getHazeOpacity(facingAt(0.8))).toBeLessThan(0.1);
    expect(HAZE_MAX_OPACITY).toBeLessThanOrEqual(0.6);
  });
});
