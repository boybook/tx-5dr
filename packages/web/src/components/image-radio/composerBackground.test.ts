import { describe, expect, it } from 'vitest';

import { fitComposerBackgroundSize } from './composerBackground';

describe('fitComposerBackgroundSize', () => {
  it('preserves aspect ratio without upscaling small backgrounds', () => {
    expect(fitComposerBackgroundSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitComposerBackgroundSize(4000, 2000)).toEqual({ width: 1024, height: 512 });
    expect(fitComposerBackgroundSize(2000, 4000)).toEqual({ width: 512, height: 1024 });
  });
});
