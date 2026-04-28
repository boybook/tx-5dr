import { describe, expect, it } from 'vitest';
import { FixedFrameAudioBuffer, StreamingLinearResampler } from '../StreamingAudioResampler.js';

describe('StreamingLinearResampler', () => {
  it('converts 48k source chunks to continuous 16k output', () => {
    const resampler = new StreamingLinearResampler(48000, 16000);
    const input = new Float32Array(960);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = i / input.length;
    }

    const output = resampler.process(input);

    expect(output.length).toBe(320);
    expect(output[0]).toBeCloseTo(0);
    expect(output[1]).toBeCloseTo(input[3] ?? 0);
    expect(output[319]).toBeCloseTo(input[957] ?? 0);
  });

  it('converts 12k source chunks to 16k output across chunk boundaries', () => {
    const resampler = new StreamingLinearResampler(12000, 16000);
    const first = resampler.process(new Float32Array(120).fill(0.25));
    const second = resampler.process(new Float32Array(120).fill(0.5));

    expect(first.length + second.length).toBeGreaterThanOrEqual(318);
    expect(first.length + second.length).toBeLessThanOrEqual(320);
    expect(second[0]).toBeGreaterThanOrEqual(0.25);
    expect(second[second.length - 1]).toBeCloseTo(0.5);
  });
});

describe('FixedFrameAudioBuffer', () => {
  it('emits fixed 20ms realtime frames with continuous leftovers', () => {
    const buffer = new FixedFrameAudioBuffer(320);

    expect(buffer.push(new Float32Array(100))).toHaveLength(0);
    const frames = buffer.push(new Float32Array(600));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(320);
    expect(frames[1]).toHaveLength(320);
    expect(buffer.queuedSamples).toBe(60);
  });
});
