import { describe, expect, it } from 'vitest';
import { intersectGlobe } from './globePicking';
import { latLngToGlobeDirection } from './solarTerminator';

describe('intersectGlobe', () => {
  it('returns the point under a camera looking at the globe centre', () => {
    const target = latLngToGlobeDirection(31.2, 121.5);
    const origin = { x: target.x * 250, y: target.y * 250, z: target.z * 250 };
    const hit = intersectGlobe(origin, { x: -origin.x, y: -origin.y, z: -origin.z }, 100);
    expect(hit?.lat).toBeCloseTo(31.2, 6);
    expect(hit?.lng).toBeCloseTo(121.5, 6);
  });

  it('returns null for rays that miss or point away', () => {
    expect(intersectGlobe({ x: 0, y: 0, z: 250 }, { x: 1, y: 0, z: 0 }, 100)).toBeNull();
    expect(intersectGlobe({ x: 0, y: 0, z: 250 }, { x: 0, y: 0, z: 1 }, 100)).toBeNull();
  });
});
