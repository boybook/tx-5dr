import { afterEach, describe, expect, it, vi } from 'vitest';
import { Resampler } from 'rubato-fft-node';
import { clearResamplerCache, resampleAudioProfessional } from '../audioUtils.js';

// Characterization of ft8-lessons RX-16: the RX path resamples device audio to
// 12 kHz chunk by chunk, so the resampler must keep its filter state between
// calls. These run against the real rubato-fft-node resampler and describe
// current behavior; they do not change it.
//
// The cache is process-wide and keyed only by the rate pair, so every caller
// with the same pair joins the same stream. That is what RX needs; one-shot
// callers (TX playback) inherit it too, recorded as a deferred finding in the
// plugin-kernel FT8 lessons inventory.

const MEDIUM_QUALITY = 2; // resampleAudioProfessional's default, maps to rubato Medium

function tone(sampleRate: number, length: number, hz = 1000): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return samples;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function referenceStream(input: Float32Array, inputRate: number, outputRate: number): Promise<Float32Array> {
  const resampler = new Resampler(inputRate, outputRate, 1, MEDIUM_QUALITY);
  try {
    return await resampler.process(input);
  } finally {
    resampler.dispose();
  }
}

async function resampleInChunks(
  input: Float32Array,
  chunkSize: number,
  inputRate: number,
  outputRate: number,
): Promise<Float32Array[]> {
  const outputs: Float32Array[] = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    outputs.push(await resampleAudioProfessional(input.subarray(offset, offset + chunkSize), inputRate, outputRate, 1));
  }
  return outputs;
}

afterEach(() => {
  clearResamplerCache();
  vi.restoreAllMocks();
});

describe('RX-16 stateful chunked resampling', () => {
  it('continues one filter stream across calls with the same rate pair', async () => {
    clearResamplerCache();
    const input = tone(48_000, 480 * 50);

    // 10 ms device chunks, as the RX path delivers them.
    const outputs = await resampleInChunks(input, 480, 48_000, 12_000);

    // Identical, sample for sample, to resampling the whole signal as one stream:
    // no discontinuity at any chunk boundary.
    expect(concat(outputs)).toEqual(await referenceStream(input, 48_000, 12_000));
    // The resampler buffers internally: some chunks produce no output yet.
    // Callers must accept an empty result without treating it as a gap.
    expect(outputs.some(output => output.length === 0)).toBe(true);
  });

  it('keeps separate state for different rate pairs that interleave', async () => {
    clearResamplerCache();
    const a = tone(48_000, 480 * 30);
    const b = tone(44_100, 441 * 30, 700);
    const outA: Float32Array[] = [];
    const outB: Float32Array[] = [];
    for (let chunk = 0; chunk < 30; chunk += 1) {
      outA.push(await resampleAudioProfessional(a.subarray(chunk * 480, (chunk + 1) * 480), 48_000, 12_000, 1));
      outB.push(await resampleAudioProfessional(b.subarray(chunk * 441, (chunk + 1) * 441), 44_100, 12_000, 1));
    }

    expect(concat(outA)).toEqual(await referenceStream(a, 48_000, 12_000));
    expect(concat(outB)).toEqual(await referenceStream(b, 44_100, 12_000));
  });

  it('starts a new stream after clearResamplerCache', async () => {
    clearResamplerCache();
    const warmup = tone(48_000, 4_800);
    const next = tone(48_000, 4_800, 1_300);
    await resampleAudioProfessional(warmup, 48_000, 12_000, 1);

    const continued = await resampleAudioProfessional(next, 48_000, 12_000, 1);
    expect(continued).not.toEqual(await referenceStream(next, 48_000, 12_000));

    clearResamplerCache();
    const restarted = await resampleAudioProfessional(next, 48_000, 12_000, 1);
    expect(restarted).toEqual(await referenceStream(next, 48_000, 12_000));
  });

  it('falls back to linear interpolation when the native resampler fails', async () => {
    clearResamplerCache();
    vi.spyOn(Resampler.prototype, 'process').mockRejectedValueOnce(new Error('native failure'));
    const input = new Float32Array([0, 0.4, 0.8, 1.2, -1.6, 0.2, 0.4, 0.6]);

    const output = await resampleAudioProfessional(input, 48_000, 12_000, 1);

    // Every fourth input sample, clamped to [-1, 1].
    expect(Array.from(output)).toEqual([0, -1]);
  });

  it('returns the input unchanged when the rates already match', async () => {
    const input = tone(12_000, 1_200);
    await expect(resampleAudioProfessional(input, 12_000, 12_000, 1)).resolves.toBe(input);
  });
});
