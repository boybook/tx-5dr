import { describe, expect, it } from 'vitest';
import {
  CWDecoderConfigSchema,
  CWDecoderEventSchema,
  CWDecoderStatusSchema,
  CWDecoderTuningUpdateSchema,
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
        sessionId: 'session-1',
        sequence: 1,
        text: 'CQ TEST',
        startedAt: 1,
        updatedAt: 2,
        endedAt: 2,
        confidence: 0.9,
        finalized: true,
        prependSpace: true,
      },
    })).toMatchObject({ kind: 'commit', segment: { finalized: true } });
  });

  it('accepts structured transcript reset, pending, and commit events', () => {
    expect(CWDecoderEventSchema.parse({
      kind: 'transcript_reset',
      sessionId: 'session-1',
      timestamp: 1,
    })).toMatchObject({ kind: 'transcript_reset', sessionId: 'session-1' });

    expect(CWDecoderEventSchema.parse({
      kind: 'transcript_pending',
      pending: {
        sessionId: 'session-1',
        version: 1,
        text: 'CQ TE',
        plainText: 'CQ TE',
        finalized: false,
        confidence: 0.7,
        targetFreqHz: 800,
        filterWidthHz: 800,
        updatedAt: 2,
      },
      timestamp: 2,
    })).toMatchObject({ kind: 'transcript_pending', pending: { finalized: false, version: 1 } });

    expect(CWDecoderEventSchema.parse({
      kind: 'transcript_commit',
      segment: {
        id: 'seg-1',
        sessionId: 'session-1',
        sequence: 1,
        text: 'CQ TEST',
        plainText: 'CQ TEST',
        finalized: true,
        prependSpace: false,
        confidence: 0.9,
        targetFreqHz: 800,
        filterWidthHz: 800,
        characterSpans: [{ char: 'C', startFrame: 1, endFrame: 2 }],
        wordSpaceSpans: [{ startFrame: 10, endFrame: 12 }],
        startedAt: 1,
        endedAt: 3,
        updatedAt: 3,
      },
      timestamp: 3,
    })).toMatchObject({ kind: 'transcript_commit', segment: { sequence: 1, prependSpace: false } });
  });

  it('rejects model sizes that are not packaged in v1', () => {
    expect(() => CWDecoderConfigSchema.parse({ modelSize: 'base' })).toThrow();
  });

  it('validates runtime tuning updates', () => {
    expect(CWDecoderTuningUpdateSchema.parse({ targetFreqHz: 650 })).toEqual({ targetFreqHz: 650 });
    expect(CWDecoderTuningUpdateSchema.parse({ filterWidthHz: 250 })).toEqual({ filterWidthHz: 250 });
    expect(() => CWDecoderTuningUpdateSchema.parse({})).toThrow();
    expect(() => CWDecoderTuningUpdateSchema.parse({ targetFreqHz: 50 })).toThrow();
    expect(() => CWDecoderTuningUpdateSchema.parse({ filterWidthHz: 900 })).toThrow();
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
