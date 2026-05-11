import { describe, expect, it } from 'vitest';
import {
  CWDecoderConfigSchema,
  CWDecoderEventSchema,
  CWDecoderStatusSchema,
} from '../cw-decoder.schema.js';

describe('CW decoder contracts', () => {
  it('parses v1 defaults', () => {
    expect(CWDecoderConfigSchema.parse({})).toMatchObject({
      enabled: false,
      backend: 'deepcw-onnx',
      runtimeBackend: 'cpu',
      modelSize: 'tiny',
      language: 'en',
      mode: 'streaming',
      targetFreqHz: 800,
      filterWidthHz: 800,
      windowSeconds: 12,
      decodeIntervalMs: 1000,
      muteWhileTransmitting: true,
      workerCount: 1,
      minCommitChars: 1,
      commitStability: 2,
      maxPendingAgeMs: 4000,
    });
  });

  it('accepts pending and commit transcript events', () => {
    expect(CWDecoderEventSchema.parse({
      kind: 'pending',
      text: 'CQ TEST',
      confidence: 0.8,
      timestamp: 1,
    })).toMatchObject({ kind: 'pending', text: 'CQ TEST' });

    expect(CWDecoderEventSchema.parse({
      kind: 'commit',
      text: 'CQ TEST',
      confidence: 0.9,
      timestamp: 2,
      segment: {
        id: 'seg-1',
        text: 'CQ TEST',
        startedAt: 1,
        updatedAt: 2,
        endedAt: 2,
        confidence: 0.9,
        finalized: true,
      },
    })).toMatchObject({ kind: 'commit', segment: { finalized: true } });
  });

  it('rejects model sizes that are not packaged in v1', () => {
    expect(() => CWDecoderConfigSchema.parse({ modelSize: 'base' })).toThrow();
  });

  it('represents muted listening state', () => {
    const config = CWDecoderConfigSchema.parse({ enabled: true });
    expect(CWDecoderStatusSchema.parse({
      enabled: true,
      state: 'muted',
      config,
      muted: true,
      active: false,
      updatedAt: 3,
    })).toMatchObject({ state: 'muted', muted: true });
  });
});
