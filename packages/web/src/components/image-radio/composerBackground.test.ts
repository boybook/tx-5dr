import { describe, expect, it } from 'vitest';

import {
  fitComposerBackgroundSize,
  fitComposerImageTransform,
  MAX_COMPOSER_BACKGROUND_SOURCE_BYTES,
  validateComposerBackgroundFile,
} from './composerBackground';

describe('fitComposerBackgroundSize', () => {
  it('preserves aspect ratio without upscaling small backgrounds', () => {
    expect(fitComposerBackgroundSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitComposerBackgroundSize(4000, 2000)).toEqual({ width: 1024, height: 512 });
    expect(fitComposerBackgroundSize(2000, 4000)).toEqual({ width: 512, height: 1024 });
  });

  it('accepts large camera images before client-side normalization', () => {
    expect(validateComposerBackgroundFile({ size: 32 * 1024 * 1024, type: 'image/jpeg' })).toBeNull();
    expect(validateComposerBackgroundFile({ size: MAX_COMPOSER_BACKGROUND_SOURCE_BYTES, type: 'image/png' })).toBeNull();
  });

  it('rejects oversized or unsupported source files with a specific reason', () => {
    expect(validateComposerBackgroundFile({ size: MAX_COMPOSER_BACKGROUND_SOURCE_BYTES + 1, type: 'image/jpeg' })).toBe('tooLarge');
    expect(validateComposerBackgroundFile({ size: 1024, type: 'image/heic' })).toBe('unsupportedFormat');
  });
});

describe('fitComposerImageTransform', () => {
  it('centers a cover crop without distorting the source', () => {
    const transform = fitComposerImageTransform(1600, 900, 320, 240, 'cover');
    expect(transform).toMatchObject({ x: 0, y: 0, width: 1, height: 1, fit: 'cover' });
    expect(transform.crop?.x).toBeCloseTo(0.125);
    expect(transform.crop?.width).toBeCloseTo(0.75);
    expect(transform.crop?.height).toBe(1);
  });

  it('uses the full source for contain placement', () => {
    const transform = fitComposerImageTransform(1600, 900, 320, 240, 'contain');
    expect(transform.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(transform.width).toBeCloseTo(1);
    expect(transform.height).toBeCloseTo(0.75);
  });
});
