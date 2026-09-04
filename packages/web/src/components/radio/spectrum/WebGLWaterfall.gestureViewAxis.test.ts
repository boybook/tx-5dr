import { describe, expect, it } from 'vitest';
import {
  getWaterfallGestureOverlayTransform,
  getWaterfallViewAxisTextureX,
} from './WebGLWaterfall';

describe('getWaterfallViewAxisTextureX', () => {
  const textureAxis = { minHz: 1000, maxHz: 2000 };

  it('is identity when the view axis equals the texture axis', () => {
    expect(getWaterfallViewAxisTextureX(0, textureAxis, textureAxis)).toBe(0);
    expect(getWaterfallViewAxisTextureX(0.5, textureAxis, textureAxis)).toBe(0.5);
    expect(getWaterfallViewAxisTextureX(1, textureAxis, textureAxis)).toBe(1);
  });

  it('maps a panned view axis onto the frozen texture axis', () => {
    // Panned right by half the texture span: the left screen edge lands in
    // the middle of the texture, the right edge falls outside coverage.
    const viewAxis = { minHz: 1500, maxHz: 2500 };
    expect(getWaterfallViewAxisTextureX(0, viewAxis, textureAxis)).toBe(0.5);
    expect(getWaterfallViewAxisTextureX(0.5, viewAxis, textureAxis)).toBe(1);
    expect(getWaterfallViewAxisTextureX(1, viewAxis, textureAxis)).toBe(1.5);
  });

  it('maps a zoomed-in view axis onto a fraction of the texture', () => {
    const viewAxis = { minHz: 1250, maxHz: 1750 };
    expect(getWaterfallViewAxisTextureX(0, viewAxis, textureAxis)).toBe(0.25);
    expect(getWaterfallViewAxisTextureX(0.5, viewAxis, textureAxis)).toBe(0.5);
    expect(getWaterfallViewAxisTextureX(1, viewAxis, textureAxis)).toBe(0.75);
  });

  it('returns coordinates outside [0, 1] for uncovered frequency ranges', () => {
    const viewAxis = { minHz: 0, maxHz: 500 };
    expect(getWaterfallViewAxisTextureX(0.5, viewAxis, textureAxis)).toBeLessThan(0);
    const farRight = { minHz: 3000, maxHz: 4000 };
    expect(getWaterfallViewAxisTextureX(0.5, farRight, textureAxis)).toBeGreaterThan(1);
  });

  it('falls back to the raw ratio for degenerate axes', () => {
    expect(getWaterfallViewAxisTextureX(0.4, { minHz: 5, maxHz: 5 }, textureAxis)).toBe(0.4);
    expect(getWaterfallViewAxisTextureX(0.4, textureAxis, { minHz: 5, maxHz: 5 })).toBe(0.4);
    expect(getWaterfallViewAxisTextureX(0.4, { minHz: NaN, maxHz: 1 }, textureAxis)).toBe(0.4);
  });
});

describe('getWaterfallGestureOverlayTransform', () => {
  const textureAxis = { minHz: 1000, maxHz: 2000 };

  it('returns null for an identity mapping', () => {
    expect(getWaterfallGestureOverlayTransform(textureAxis, textureAxis, 800)).toBeNull();
  });

  it('pans overlays with a pure translation (scaleX stays 1)', () => {
    const viewAxis = { minHz: 1100, maxHz: 2100 };
    const transform = getWaterfallGestureOverlayTransform(textureAxis, viewAxis, 800);
    expect(transform).not.toBeNull();
    expect(transform!.scaleX).toBe(1);
    // (textureMin - viewMin) / viewSpan * width = (1000-1100)/1000 * 800
    expect(transform!.translateXPx).toBeCloseTo(-80);
  });

  it('zooms overlays with scaleX and anchor-corrected translation', () => {
    const viewAxis = { minHz: 1250, maxHz: 1750 };
    const transform = getWaterfallGestureOverlayTransform(textureAxis, viewAxis, 800);
    expect(transform).not.toBeNull();
    expect(transform!.scaleX).toBe(2);
    expect(transform!.translateXPx).toBeCloseTo(-400);
    // A marker at the texture midpoint (50%) must land at the view midpoint:
    // 0.5 * 800 * 2 - 400 = 400 = 50% of 800.
    expect(0.5 * 800 * transform!.scaleX + transform!.translateXPx).toBeCloseTo(400);
  });

  it('returns null for degenerate inputs', () => {
    expect(getWaterfallGestureOverlayTransform(textureAxis, { minHz: 1, maxHz: 1 }, 800)).toBeNull();
    expect(getWaterfallGestureOverlayTransform({ minHz: 1, maxHz: 1 }, textureAxis, 800)).toBeNull();
    expect(getWaterfallGestureOverlayTransform(textureAxis, textureAxis, 0)).toBeNull();
  });
});
