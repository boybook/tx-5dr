import { describe, expect, it } from 'vitest';
import {
  applyTxAudioEnvelope,
  createTxAudioReleaseTail,
  FT8_FT4_TX_ENVELOPE_POLICY,
} from '../TxAudioEnvelope.js';

describe('TxAudioEnvelope', () => {
  it('applies a 10 ms raised-cosine attack and release without changing duration', () => {
    const source = new Float32Array(1_200).fill(0.5);
    const output = applyTxAudioEnvelope(source, 12_000, FT8_FT4_TX_ENVELOPE_POLICY);

    expect(output).toHaveLength(source.length);
    expect(output[0]).toBeCloseTo(0);
    expect(output[119]).toBeCloseTo(0.5);
    expect(output[120]).toBeCloseTo(0.5);
    expect(output[1_080]).toBeCloseTo(0.5);
    expect(output[1_199]).toBeCloseTo(0);
    expect(Math.max(...output)).toBeLessThanOrEqual(0.5);
  });

  it('shortens attack and release without overlap for short clips', () => {
    const source = new Float32Array(5).fill(1);
    const output = applyTxAudioEnvelope(source, 12_000, FT8_FT4_TX_ENVELOPE_POLICY);

    expect(output).toHaveLength(5);
    expect(output[0]).toBeCloseTo(0);
    expect(output[4]).toBeCloseTo(0);
    expect(output.every((sample) => sample >= 0 && sample <= 1)).toBe(true);
  });

  it('creates a bounded release tail from the last submitted sample', () => {
    const tail = createTxAudioReleaseTail(0.8, 48_000, FT8_FT4_TX_ENVELOPE_POLICY);

    expect(tail).toHaveLength(480);
    expect(tail[0]).toBeCloseTo(0.8);
    expect(tail[479]).toBeCloseTo(0);
    expect(tail.every((sample) => sample >= 0 && sample <= 0.800001)).toBe(true);
  });
});
