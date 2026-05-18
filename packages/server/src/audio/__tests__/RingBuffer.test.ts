import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../ringBuffer.js';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';

function floats(values: number[]): Float32Array {
  return new Float32Array(values);
}

function readFloats(buffer: ArrayBuffer): number[] {
  return Array.from(new Float32Array(buffer), value => Number(value.toFixed(3)));
}

describe('RingBuffer latest-window reads', () => {
  it('anchors provider reads to the latest written sample when sample production leads wall clock', async () => {
    let now = 0;
    const provider = new RingBufferAudioProvider(10, 10_000, () => now);
    provider.writeAudio(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]));

    now = 500;
    const buffer = await provider.getBuffer(0, 500);

    expect(readFloats(buffer)).toEqual([0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('reports a full buffer when writeIndex catches readIndex exactly at capacity', () => {
    const ringBuffer = new RingBuffer(10, 1000, () => 0);

    ringBuffer.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]));

    expect(ringBuffer.getStatus()).toMatchObject({
      availableSamples: 10,
      storedSamples: 10,
      writeIndex: 0,
      readIndex: 0,
    });
    expect(readFloats(ringBuffer.readFromSlotStart(0, 1000))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('anchors producer clock on first audio write instead of construction time', () => {
    let now = 0;
    const ringBuffer = new RingBuffer(1000, 1000, () => now);

    now = 5000;
    ringBuffer.write(floats([0.1, 0.2, 0.3, 0.4, 0.5]));

    expect(ringBuffer.getStatus()).toMatchObject({
      startTimestamp: 5000,
      totalSamplesWritten: 5,
      wallClockSamples: 0,
      producerLeadMs: 5,
    });

    now = 5005;
    expect(ringBuffer.getStatus()).toMatchObject({
      wallClockSamples: 5,
      producerLeadMs: 0,
    });
  });

  it('drops the oldest samples on overflow and keeps the newest tail', () => {
    const ringBuffer = new RingBuffer(10, 500, () => 0);

    ringBuffer.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]));

    expect(ringBuffer.getAvailableSamples()).toBe(5);
    expect(readFloats(ringBuffer.readFromSlotStart(0, 500))).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it('readNext consumes stored samples and pads underruns with silence', () => {
    const ringBuffer = new RingBuffer(10, 500, () => 0);
    ringBuffer.write(floats([0.1, 0.2, 0.3]));

    expect(readFloats(ringBuffer.readNext(5))).toEqual([0.1, 0.2, 0.3, 0, 0]);
    expect(ringBuffer.getAvailableSamples()).toBe(0);

    ringBuffer.write(floats([0.4, 0.5]));

    expect(readFloats(ringBuffer.readNext(1))).toEqual([0.4]);
    expect(ringBuffer.getAvailableSamples()).toBe(1);
  });
});
