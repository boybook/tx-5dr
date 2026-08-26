import { describe, expect, it } from 'vitest';

import type { ImageTemplateTextLayer } from '@tx5dr/contracts';

import {
  moveTextLayer,
  normalizeLayerRotation,
  pointInsideTextLayer,
  resizeTextLayerFont,
  rotateTextLayer,
  scaleTextLayer,
  textLayerInspectorPlacement,
  textLayerHandles,
} from './sstvTextLayerGeometry';

const layer: ImageTemplateTextLayer = {
  id: 'text', text: 'CQ', x: 0.3, y: 0.4, width: 0.4, height: 0.2,
  fontSize: 0.1, color: '#ffffff', strokeWidth: 0.12, align: 'center', rotation: 0,
};

describe('SSTV text layer geometry', () => {
  it('places the inspector using canvas space in the whole window rather than its panel', () => {
    expect(textLayerInspectorPlacement(1_048)).toBe('side');
    expect(textLayerInspectorPlacement(16)).toBe('bottom');
  });

  it('hit-tests rotated layers in canvas pixel space', () => {
    const rotated = { ...layer, rotation: 90 };
    expect(pointInsideTextLayer({ x: 50, y: 50 }, rotated, 100, 100)).toBe(true);
    expect(pointInsideTextLayer({ x: 68, y: 50 }, rotated, 100, 100)).toBe(false);
    expect(textLayerHandles(rotated, 100, 100).scale).toEqual({ x: 40, y: 70 });
  });

  it('uniformly scales the box and font around a stable center', () => {
    const scaled = scaleTextLayer(layer, 1.5, 100, 100);
    expect(scaled.x).toBeCloseTo(0.2);
    expect(scaled.y).toBeCloseTo(0.35);
    expect(scaled.width).toBeCloseTo(0.6);
    expect(scaled.height).toBeCloseTo(0.3);
    expect(scaled.fontSize).toBeCloseTo(0.15);
    const resized = resizeTextLayerFont(layer, 0.2, 100, 100);
    expect(resized.x).toBeCloseTo(0.1);
    expect(resized.y).toBeCloseTo(0.3);
    expect(resized.width).toBeCloseTo(0.8);
    expect(resized.height).toBeCloseTo(0.4);
    expect(resized.fontSize).toBeCloseTo(0.2);
    const oversized = resizeTextLayerFont({ ...layer, width: 0.8 }, 0.3, 100, 100);
    expect(oversized.width).toBeCloseTo(2.4);
    expect(oversized.fontSize).toBe(0.3);
  });

  it('allows partial overflow and recovers a layer that leaves the canvas completely', () => {
    expect(normalizeLayerRotation(270)).toBe(-90);
    expect(normalizeLayerRotation(180)).toBe(180);
    const rotated = rotateTextLayer({ ...layer, x: -0.1, y: -0.1 }, 45, 100, 100);
    expect(rotated.rotation).toBe(45);
    expect(rotated.x).toBeCloseTo(-0.1);
    expect(rotated.y).toBeCloseTo(-0.1);
    const partiallyOutside = moveTextLayer(layer, { x: -10, y: 50 }, 100, 100);
    expect(partiallyOutside.x).toBeLessThan(0);
    const recoveredLeft = moveTextLayer(layer, { x: -50, y: 50 }, 100, 100);
    expect(recoveredLeft.x).toBeCloseTo(0);
    const recoveredBottom = moveTextLayer(layer, { x: 50, y: 150 }, 100, 100);
    expect(recoveredBottom.y).toBeCloseTo(0.8);
    expect(scaleTextLayer(layer, 4, 100, 100).width).toBeGreaterThan(1);
  });
});
