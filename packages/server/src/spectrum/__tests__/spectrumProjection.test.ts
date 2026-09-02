import { describe, expect, it } from 'vitest';
import type { SpectrumFrame } from '@tx5dr/contracts';
import { projectSpectrumFrame } from '../spectrumProjection.js';

function frame(): SpectrumFrame {
  const values = new Int16Array([0, 100, 200, 300, 400]);
  return {
    timestamp: 1,
    kind: 'radio-sdr',
    frequencyRange: { min: 0, max: 400 },
    binaryData: {
      data: Buffer.from(values.buffer).toString('base64'),
      format: { type: 'int16', length: values.length, scale: 1, offset: 0 },
    },
    meta: {
      sourceBinCount: values.length,
      displayBinCount: values.length,
    },
  };
}

describe('spectrum frame projection', () => {
  it('crops and resamples one canonical frame for a client viewport', () => {
    const projected = projectSpectrumFrame(frame(), { min: 100, max: 300, displayBinCount: 3 });
    expect(projected.frequencyRange).toEqual({ min: 100, max: 300 });
    expect(projected.meta.nativeFrequencyRange).toEqual({ min: 0, max: 400 });
    expect(projected.meta.displayBinCount).toBe(3);
    const bytes = Buffer.from(projected.binaryData.data, 'base64');
    expect(Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, 3))).toEqual([100, 200, 300]);
  });

  it('fills viewport portions outside the source range with the level floor', () => {
    const source = frame();
    source.meta.level = { domain: 'dbfs', unit: 'dBFS', reference: 'full-scale', calibrated: true, min: -120, max: 0 };
    source.binaryData.format.scale = 0.01;
    const projected = projectSpectrumFrame(source, { min: -100, max: 100, displayBinCount: 3 });
    const bytes = Buffer.from(projected.binaryData.data, 'base64');
    expect(Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, 3))).toEqual([-12000, 0, 100]);
  });

  it('uses a wide low-resolution supplement outside a cropped detail range', () => {
    const source = frame();
    source.frequencyRange = { min: -100, max: 100 };
    source.supplement = {
      frequencyRange: { min: -400, max: 400 },
      binaryData: {
        data: Buffer.from(new Int16Array([10, 20, 30, 40, 50]).buffer).toString('base64'),
        format: { type: 'int16', length: 5, scale: 1, offset: 0 },
      },
      meta: { sourceBinCount: 5, displayBinCount: 5 },
    };
    const projected = projectSpectrumFrame(source, { min: -400, max: 400, displayBinCount: 5 });
    const bytes = Buffer.from(projected.binaryData.data, 'base64');
    expect(Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, 5))).toEqual([10, 20, 200, 40, 50]);
  });
});
