import { describe, expect, it } from 'vitest';
import { SpectrumFrameSchema, SpectrumLevelDescriptorSchema } from '../spectrum.schema.js';

describe('spectrum level descriptor schema', () => {
  it('accepts dBFS, calibrated dB and raw Level descriptors', () => {
    for (const level of [
      { domain: 'dbfs', unit: 'dBFS', reference: 'full-scale', calibrated: true, min: -120, max: 0 },
      { domain: 'calibrated-db', unit: 'dB', reference: 'device', calibrated: true, min: -130, max: 10 },
      { domain: 'raw', unit: 'Level', reference: 'none', calibrated: false, min: 0, max: 255 },
    ]) {
      expect(SpectrumLevelDescriptorSchema.safeParse(level).success).toBe(true);
    }
  });

  it('rejects invalid or non-increasing level ranges', () => {
    expect(SpectrumLevelDescriptorSchema.safeParse({
      domain: 'raw',
      unit: 'dBFS',
      reference: 'none',
      calibrated: false,
      min: 255,
      max: 0,
    }).success).toBe(false);
  });

  it('keeps level optional for old spectrum frames', () => {
    const result = SpectrumFrameSchema.safeParse({
      timestamp: 1,
      kind: 'radio-sdr',
      frequencyRange: { min: 7_000_000, max: 7_100_000 },
      binaryData: {
        data: 'AA==',
        format: { type: 'int16', length: 1 },
      },
      meta: {
        sourceBinCount: 1,
        displayBinCount: 1,
      },
    });
    expect(result.success).toBe(true);
  });
});
