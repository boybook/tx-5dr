import { describe, expect, it } from 'vitest';
import { DecodeRequestSchema } from '../src/schema/slot-info.schema.js';

function makePcm(): ArrayBuffer {
  return new Float32Array(16).buffer;
}

describe('DecodeRequestSchema', () => {
  it('accepts legacy decode requests without AP context', () => {
    const parsed = DecodeRequestSchema.parse({
      slotId: 'FT8-1-15000',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(),
      sampleRate: 12000,
      windowOffsetMs: 0,
    });

    expect(parsed.apContext).toBeUndefined();
    expect(parsed.decodeDepth).toBeUndefined();
  });

  it('accepts a single AP decode context', () => {
    const parsed = DecodeRequestSchema.parse({
      slotId: 'FT8-1-15000',
      mode: 'FT8',
      windowIdx: 1,
      pcm: makePcm(),
      sampleRate: 12000,
      windowOffsetMs: 0,
      apContext: {
        operatorId: 'op1',
        myCall: 'BG4IAJ',
        myGrid: 'OM96',
        dxCall: 'JA1AAA',
        dxGrid: 'PM95',
        frequencyHz: 1500,
        qsoProgress: 4,
        currentSlot: 'TX4',
      },
    });

    expect(parsed.apContext).toEqual(expect.objectContaining({
      operatorId: 'op1',
      qsoProgress: 4,
      currentSlot: 'TX4',
    }));
  });

  it('accepts only the native FT8 stage values', () => {
    const request = {
      slotId: 'FT8-stage',
      mode: 'FT8' as const,
      windowIdx: 0,
      pcm: makePcm(),
      sampleRate: 12000,
      decodeStage: 49,
    };
    expect(DecodeRequestSchema.parse(request).decodeStage).toBe(49);
    expect(() => DecodeRequestSchema.parse({ ...request, decodeStage: 42 })).toThrow();
  });
});
