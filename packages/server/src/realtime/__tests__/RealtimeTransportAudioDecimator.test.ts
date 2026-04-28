import { describe, expect, it } from 'vitest';
import {
  RealtimeTransportAudioDecimator,
  resolveRealtimeTransportDownsampleFactor,
} from '../RealtimeTransportAudioDecimator.js';
import type { RealtimeAudioFrame } from '../RealtimeRxAudioSource.js';

function makeFrame(overrides: Partial<RealtimeAudioFrame>): RealtimeAudioFrame {
  return {
    samples: new Float32Array(),
    sampleRate: 48000,
    channels: 1,
    timestamp: 1000,
    sequence: 0,
    sourceKind: 'native-radio',
    nativeSourceKind: 'audio-device',
    ...overrides,
  };
}

describe('RealtimeTransportAudioDecimator', () => {
  it('chooses a low-cost integer factor for common high-rate PCM sources', () => {
    expect(resolveRealtimeTransportDownsampleFactor(48000)).toBe(2);
    expect(resolveRealtimeTransportDownsampleFactor(96000)).toBe(4);
    expect(resolveRealtimeTransportDownsampleFactor(44100)).toBe(2);
    expect(resolveRealtimeTransportDownsampleFactor(50000)).toBe(3);
    expect(resolveRealtimeTransportDownsampleFactor(24000)).toBe(1);
    expect(resolveRealtimeTransportDownsampleFactor(16000)).toBe(1);
    expect(resolveRealtimeTransportDownsampleFactor(12000)).toBe(1);
  });

  it('still reduces unusual high sample rates even when no exact integer divisor is available', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const output = decimator.process(makeFrame({
      samples: new Float32Array([0, 1, 2, 3, 4, 5]),
      sampleRate: 50000,
      timestamp: 1000,
    }));

    expect(output.sampleRate).toBe(16667);
    expect(output.downsampleFactor).toBe(3);
    expect(output.samplesPerChannel).toBe(2);
    expect(Array.from(output.samples)).toEqual([0, 3]);
  });

  it('decimates 48k mono frames directly to 24k', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const output = decimator.process(makeFrame({
      samples: new Float32Array(96).fill(1),
      sampleRate: 48000,
      channels: 1,
      timestamp: 1234,
    }));

    expect(output.sampleRate).toBe(24000);
    expect(output.inputSampleRate).toBe(48000);
    expect(output.downsampleFactor).toBe(2);
    expect(output.samplesPerChannel).toBe(48);
    expect(output.timestamp).toBe(1234);
    expect(output.samples[0]).toBeCloseTo(1, 4);
    expect(output.samples[output.samples.length - 1]).toBeCloseTo(1, 4);
  });

  it('keeps decimation phase across chunks so chunking matches a continuous frame', () => {
    const source = new Float32Array(240);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = Math.sin((2 * Math.PI * 1000 * index) / 48000);
    }

    const continuous = new RealtimeTransportAudioDecimator().process(makeFrame({
      samples: source,
      sampleRate: 48000,
      timestamp: 1000,
    }));

    const chunkedDecimator = new RealtimeTransportAudioDecimator();
    const chunks = [37, 41, 53, 109].map((length, chunkIndex, lengths) => {
      const start = lengths.slice(0, chunkIndex).reduce((sum, value) => sum + value, 0);
      return chunkedDecimator.process(makeFrame({
        samples: source.slice(start, start + length),
        sampleRate: 48000,
        timestamp: 1000 + (start / 48000) * 1000,
        sequence: chunkIndex + 1,
      }));
    });
    const chunkedSamples = chunks.flatMap((chunk) => Array.from(chunk.samples));

    expect(chunkedSamples).toEqual(Array.from(continuous.samples));
  });

  it('keeps phase through sub-factor chunks without emitting bogus frames', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const first = decimator.process(makeFrame({
      samples: new Float32Array([0]),
      sampleRate: 48000,
      timestamp: 1000,
    }));
    const second = decimator.process(makeFrame({
      samples: new Float32Array([1]),
      sampleRate: 48000,
      timestamp: 1000 + (1 / 48000) * 1000,
      sequence: 1,
    }));
    const third = decimator.process(makeFrame({
      samples: new Float32Array([2]),
      sampleRate: 48000,
      timestamp: 1000 + (2 / 48000) * 1000,
      sequence: 2,
    }));

    expect(Array.from(first.samples)).toEqual([0]);
    expect(first.sampleRate).toBe(24000);
    expect(first.timestamp).toBe(1000);
    expect(second.samplesPerChannel).toBe(0);
    expect(second.sampleRate).toBe(24000);
    expect(third.samplesPerChannel).toBe(1);
    expect(Array.from(third.samples)).toEqual([2]);
  });

  it('resets phase when the source format changes', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    decimator.process(makeFrame({
      samples: new Float32Array([0]),
      sampleRate: 48000,
    }));
    const output = decimator.process(makeFrame({
      samples: new Float32Array([1, 2, 3, 4]),
      sampleRate: 96000,
      sequence: 1,
    }));

    expect(output.sampleRate).toBe(24000);
    expect(output.downsampleFactor).toBe(4);
    expect(Array.from(output.samples)).toEqual([1]);
  });

  it('preserves ICOM/native 12k frames without a transport-edge conversion', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    const output = decimator.process(makeFrame({
      samples,
      sampleRate: 12000,
      channels: 1,
      nativeSourceKind: 'icom-wlan',
    }));

    expect(output.sampleRate).toBe(12000);
    expect(output.downsampleFactor).toBe(1);
    expect(output.samples).toBe(samples);
    expect(output.samplesPerChannel).toBe(3);
  });

  it('drops invalid source sample rates before they reach transport encoders', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const output = decimator.process(makeFrame({
      samples: new Float32Array([0.1, 0.2, 0.3]),
      sampleRate: Number.NaN,
    }));

    expect(output.samplesPerChannel).toBe(0);
    expect(output.samples.length).toBe(0);
    expect(output.sampleRate).toBe(0);
    expect(output.inputSampleRate).toBe(0);
  });

  it('preserves interleaved channel layout while decimating', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const samples = new Float32Array(96 * 2);
    for (let index = 0; index < 96; index += 1) {
      samples[index * 2] = 0.25;
      samples[(index * 2) + 1] = -0.5;
    }
    const output = decimator.process(makeFrame({
      samples,
      sampleRate: 48000,
      channels: 2,
    }));

    expect(output.sampleRate).toBe(24000);
    expect(output.channels).toBe(2);
    expect(output.samplesPerChannel).toBe(48);
    expect(output.samples[0]).toBeCloseTo(0.25, 4);
    expect(output.samples[1]).toBeCloseTo(-0.5, 4);
    expect(output.samples[output.samples.length - 2]).toBeCloseTo(0.25, 4);
    expect(output.samples[output.samples.length - 1]).toBeCloseTo(-0.5, 4);
  });

  it('uses direct integer decimation without a low-pass prefilter', () => {
    const decimator = new RealtimeTransportAudioDecimator();
    const samples = new Float32Array(16);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = index % 2 === 0 ? 1 : -1;
    }
    const output = decimator.process(makeFrame({
      samples,
      sampleRate: 48000,
      channels: 1,
    }));

    expect(output.sampleRate).toBe(24000);
    expect(output.samplesPerChannel).toBe(8);
    expect(Array.from(output.samples)).toEqual(new Array(8).fill(1));
  });
});
