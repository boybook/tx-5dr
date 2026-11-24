import { describe, expect, it } from 'vitest';
import {
  DAYLIGHT_SHADING,
  GROUND_GAINS,
  MAX_GROUND_GAIN,
  RELIEF_NEUTRAL,
  createSolarTerminatorLayer,
  getNightDimming,
  getReliefGain,
  getSubsolarPoint,
  latLngToGlobeDirection,
} from './solarTerminator';

describe('getSubsolarPoint', () => {
  it('puts the sun over the equator at the March equinox', () => {
    // 2024-03-20 03:06 UTC
    const point = getSubsolarPoint(new Date(Date.UTC(2024, 2, 20, 3, 6)));
    expect(Math.abs(point.lat)).toBeLessThan(0.1);
  });

  it('puts the sun over the Tropic of Cancer at the June solstice', () => {
    // 2024-06-20 20:51 UTC
    const point = getSubsolarPoint(new Date(Date.UTC(2024, 5, 20, 20, 51)));
    expect(point.lat).toBeCloseTo(23.44, 1);
  });

  it('puts the sun near the Greenwich meridian at noon UTC, within the equation of time', () => {
    // Early November the sun runs about 16 minutes fast: it has already passed
    // Greenwich at 12:00 UTC, so it stands about 4 degrees west.
    const november = getSubsolarPoint(new Date(Date.UTC(2024, 10, 3, 12, 0)));
    expect(november.lng).toBeLessThan(-3.5);
    expect(november.lng).toBeGreaterThan(-4.5);
    // Mid February it runs about 14 minutes slow, so it is still east.
    const february = getSubsolarPoint(new Date(Date.UTC(2024, 1, 11, 12, 0)));
    expect(february.lng).toBeGreaterThan(3);
    expect(february.lng).toBeLessThan(4);
  });

  it('moves the sun 15 degrees west per hour', () => {
    const noon = getSubsolarPoint(new Date(Date.UTC(2024, 5, 1, 12, 0)));
    const later = getSubsolarPoint(new Date(Date.UTC(2024, 5, 1, 18, 0)));
    expect(noon.lng - later.lng).toBeCloseTo(90, 0);
    expect(later.lng).toBeGreaterThanOrEqual(-180);
    expect(later.lng).toBeLessThan(180);
  });
});

describe('latLngToGlobeDirection', () => {
  it('matches the three-globe axes: prime meridian on +Z, 90E on +X, north pole on +Y', () => {
    const prime = latLngToGlobeDirection(0, 0);
    expect(prime.z).toBeCloseTo(1);
    expect(prime.x).toBeCloseTo(0);
    const east = latLngToGlobeDirection(0, 90);
    expect(east.x).toBeCloseTo(1);
    const pole = latLngToGlobeDirection(90, 0);
    expect(pole.y).toBeCloseTo(1);
  });
});

describe('getNightDimming', () => {
  it('leaves daylight unshaded and darkens fully only after astronomical twilight', () => {
    expect(getNightDimming(30)).toBe(0);
    expect(getNightDimming(0)).toBe(0);
    expect(getNightDimming(-18)).toBeCloseTo(DAYLIGHT_SHADING.nightDimming);
    expect(getNightDimming(-60)).toBeCloseTo(DAYLIGHT_SHADING.nightDimming);
  });

  // A linear ramp shows a hard edge where dusk starts and where night is
  // complete; the eased ramp starts and ends flat.
  it('deepens smoothly through twilight with no edge at either end', () => {
    const steps = Array.from({ length: 41 }, (_, index) => getNightDimming(1 - index * 0.5));
    steps.slice(1).forEach((value, index) => expect(value).toBeGreaterThanOrEqual(steps[index]));
    const { nightAboveDeg, nightBelowDeg, nightDimming } = DAYLIGHT_SHADING;
    expect(getNightDimming(nightAboveDeg - 0.5)).toBeLessThan(0.002);
    expect(nightDimming - getNightDimming(nightBelowDeg + 0.5)).toBeLessThan(0.002);
    expect(getNightDimming(-6)).toBeGreaterThan(0.05);
    expect(getNightDimming(-6)).toBeLessThan(nightDimming * 0.5);
  });
});

describe('ground gains', () => {
  // The shade tints the ground by multiplying it; a modulate-2x blend cannot
  // scale a channel beyond 2, so any larger gain would silently clip.
  it('stays within what the modulate-2x blend can apply', () => {
    Object.values(GROUND_GAINS).flat().forEach((gain) => {
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(MAX_GROUND_GAIN);
    });
  });

  it('warms the ground at dusk and darkens it at night', () => {
    const [r, g, b] = GROUND_GAINS.dusk;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    GROUND_GAINS.night.forEach(gain => expect(gain).toBeLessThan(1));
    expect(GROUND_GAINS.night[0]).toBeCloseTo(1 - DAYLIGHT_SHADING.nightDimming);
  });
});

describe('terrain relief', () => {
  it('leaves flat ground and seas alone, lifts lit slopes and darkens shaded ones', () => {
    expect(getReliefGain(RELIEF_NEUTRAL)).toBeCloseTo(1, 12);
    expect(getReliefGain(1)).toBeGreaterThan(1);
    expect(getReliefGain(1)).toBeLessThan(MAX_GROUND_GAIN);
    expect(getReliefGain(0.2)).toBeLessThan(0.6);
    expect(getReliefGain(0.2)).toBeGreaterThan(0);
  });

  it('keeps the relief when day and night are hidden, and skips the shell with neither', () => {
    const layer = createSolarTerminatorLayer();
    const lights = (layer.mesh as unknown as { children: Array<{ visible: boolean }> }).children[0];
    layer.setEarthTexture({});
    expect(lights.visible).toBe(true);

    layer.setDaylightVisible(false);
    expect(layer.mesh.visible).toBe(false);
    expect(lights.visible).toBe(false);

    layer.setReliefTexture({});
    expect(layer.mesh.visible).toBe(true);
    expect(lights.visible).toBe(false);

    layer.setDaylightVisible(true);
    expect(lights.visible).toBe(true);
    layer.dispose();
  });
});
