import { describe, expect, it } from 'vitest';
import {
  GLOBE_LAND_CAP_ALTITUDE,
  GLOBE_RENDER_ORDER,
  GLOBE_SHELL_MIN_CAP_CLEARANCE,
  LAND_CAP_DEPTH_BIAS,
  MIN_CAMERA_NEAR,
  applyGlobeLayerOrder,
  getCameraNear,
  getSphereFacetSag,
} from './globeShell';
import { GRID_SHELL_ALTITUDE, GRID_SHELL_SEGMENTS } from './maidenheadGridLayer';
import { TERMINATOR_SHELL_ALTITUDE, TERMINATOR_SHELL_SEGMENTS } from './solarTerminator';
import { HAZE_SHELL_ALTITUDE, HAZE_SHELL_SEGMENTS } from './globeAtmosphere';

describe('globe shell clearance', () => {
  it('measures facet sag of a UV sphere', () => {
    // A 4x2 sphere: half-facet diagonal of hypot(45deg, 45deg).
    expect(getSphereFacetSag(4, 2)).toBeCloseTo(1 - Math.cos(Math.hypot(Math.PI / 4, Math.PI / 4)));
    expect(getSphereFacetSag(192, 96)).toBeLessThan(getSphereFacetSag(128, 64));
  });

  // Regression: a 128x64 night shade at 0.0028 sagged into the land caps
  // mid-facet and flickered over land on the night side.
  it.each([
    ['night shade', TERMINATOR_SHELL_ALTITUDE, TERMINATOR_SHELL_SEGMENTS],
    ['grid overlay', GRID_SHELL_ALTITUDE, GRID_SHELL_SEGMENTS],
    ['horizon haze', HAZE_SHELL_ALTITUDE, HAZE_SHELL_SEGMENTS],
  ])('keeps the %s clear of the land caps everywhere', (_name, altitude, segments) => {
    const lowest = (1 + altitude) * (1 - getSphereFacetSag(segments.width, segments.height)) - 1;
    expect(lowest - GLOBE_LAND_CAP_ALTITUDE).toBeGreaterThanOrEqual(GLOBE_SHELL_MIN_CAP_CLEARANCE);
  });
});

describe('globe layer order', () => {
  // Regression: drawn after the markers, the night shade dimmed the reception
  // points and z-fought with their tops.
  it('shades the ground before any marker is drawn', () => {
    const order = GLOBE_RENDER_ORDER;
    expect(order.land).toBeLessThan(order.nightShade);
    expect(order.nightShade).toBeLessThan(order.cityLights);
    expect(order.cityLights).toBeLessThan(order.receptionGlow);
    expect(order.receptionGlow).toBeLessThan(order.arcsAndRings);
    expect(order.arcsAndRings).toBeLessThan(order.gridOverlay);
  });

  it('veils the whole ground with the horizon haze and none of the data', () => {
    const order = GLOBE_RENDER_ORDER;
    expect(order.haze).toBeGreaterThan(order.receptionGlow);
    expect(order.haze).toBeLessThan(order.arcsAndRings);
    expect(order.haze).toBeLessThan(order.gridOverlay);
    expect(order.haze).toBeLessThan(order.pointMarkers);
  });

  it('orders globe.gl land caps and reception glow, leaving other objects alone', () => {
    const nodes = [
      { __globeObjType: 'polygon', renderOrder: 0 },
      { __globeObjType: 'heatmap', renderOrder: 0 },
      { __globeObjType: 'point', renderOrder: 0 },
      { renderOrder: 0 },
    ];
    const found = applyGlobeLayerOrder({ traverse: callback => nodes.forEach(callback) });
    expect(found).toBe(true);
    expect(nodes.map(node => node.renderOrder)).toEqual([
      GLOBE_RENDER_ORDER.land,
      GLOBE_RENDER_ORDER.receptionGlow,
      0,
      0,
    ]);
    expect(applyGlobeLayerOrder({ traverse: () => {} })).toBe(false);
  });
});

describe('land caps depth', () => {
  // Regression: zoomed out, the land caps flickered against the globe surface
  // just below them.
  it('biases every land cap material above the globe surface', () => {
    const capMaterials = [{}, {}] as Array<Record<string, unknown>>;
    const strokeMaterial = {} as Record<string, unknown>;
    const nodes = [{
      __globeObjType: 'polygon',
      renderOrder: 0,
      children: [
        { renderOrder: 0, isMesh: true, material: capMaterials },
        { renderOrder: 0, material: strokeMaterial },
      ],
    }];
    applyGlobeLayerOrder({ traverse: callback => nodes.forEach(callback) });
    capMaterials.forEach((material) => {
      expect(material).toMatchObject({
        polygonOffset: true,
        polygonOffsetFactor: LAND_CAP_DEPTH_BIAS.factor,
        polygonOffsetUnits: LAND_CAP_DEPTH_BIAS.units,
      });
    });
    expect(LAND_CAP_DEPTH_BIAS.units).toBeLessThan(0);
    expect(strokeMaterial.polygonOffset).toBeUndefined();
  });
});

describe('camera near plane', () => {
  it('keeps the near plane close when skimming the surface', () => {
    expect(getCameraNear(0)).toBe(MIN_CAMERA_NEAR);
    expect(getCameraNear(0.1)).toBe(MIN_CAMERA_NEAR);
    expect(getCameraNear(Number.NaN)).toBe(MIN_CAMERA_NEAR);
  });

  // Depth resolution at distance d is about d^2 / (near * 2^24). The thinnest
  // gap the globe relies on, land caps above the globe mid-facet, is about a
  // tenth of a unit; it must stay many depth steps wide at every zoom.
  it.each([0.1, 0.5, 1, 2.5, 5])('resolves land above the globe at altitude %s', (altitude) => {
    const radius = 100;
    const height = altitude * radius;
    const distance = radius + height;
    const resolution = distance ** 2 / (getCameraNear(height) * 2 ** 24);
    expect(resolution).toBeLessThan(0.01);
    // Never past the ground right below the camera.
    expect(getCameraNear(height)).toBeLessThan(height);
  });
});
