import { describe, expect, it } from 'vitest';

import {
  fitComposerBackgroundSize,
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
