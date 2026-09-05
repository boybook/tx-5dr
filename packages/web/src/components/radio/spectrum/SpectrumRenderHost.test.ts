import { describe, expect, it } from 'vitest';
import { resolveSpectrumWaterfallHeight } from './SpectrumRenderHost';

describe('SpectrumRenderHost layout', () => {
  it('keeps an inline waterfall at the exact host height', () => {
    expect(resolveSpectrumWaterfallHeight(128, 112, false)).toBe(128);
  });

  it('allocates only the remaining height to a standalone waterfall', () => {
    expect(resolveSpectrumWaterfallHeight(600, 180, true)).toBe(420);
  });

  it('never produces an invalid child surface height', () => {
    expect(resolveSpectrumWaterfallHeight(100, 120, true)).toBe(1);
  });
});
