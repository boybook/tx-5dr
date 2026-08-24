import { describe, expect, it } from 'vitest';

import { RasterwaveRuntime } from '../RasterwaveRuntime.js';

describe('RasterwaveRuntime', () => {
  it('loads the published native package and exposes all SSTV modes', async () => {
    const runtime = new RasterwaveRuntime();
    const native = runtime.load();
    expect(native.sstvModes()).toHaveLength(31);
    const decoder = new native.SstvDecoder(12_000, { queueCapacitySamples: 24_000 }, () => undefined);
    expect(decoder.pushF32(new Float32Array(1_200))).toBe(true);
    await decoder.drain();
    await decoder.dispose();
  });
});
