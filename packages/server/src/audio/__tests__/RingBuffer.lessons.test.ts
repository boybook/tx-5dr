import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../ringBuffer.js';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';

function floats(values: number[]): Float32Array {
  return new Float32Array(values);
}

function readFloats(buffer: ArrayBuffer): number[] {
  return Array.from(new Float32Array(buffer), value => Number(value.toFixed(3)));
}

// Model convention (see RingBuffer.test.ts): write(samples, arrival) maps the chunk to the
// wall-clock interval [arrival - duration, arrival). At 1000 Hz one sample is 1 ms.
describe('RingBuffer timeline break after a resync (RX-04)', () => {
  const chunk = (value: number, length = 100) => new Float32Array(length).fill(value);

  it('zero-fills pre-break audio instead of folding it across the stall gap', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 100); // wall [0,100), abs [0,100)
    rb.write(chunk(0.2), 200); // wall [100,200), abs [100,200)
    // ~3 s stall, then audio resumes: the model resyncs so abs 300 <-> wall 3200.
    rb.write(chunk(0.5), 3200); // wall [3100,3200), abs [200,300)
    expect(rb.getStatus()).toMatchObject({ resyncCount: 1, timelineStartSampleIndex: 200 });

    // A window straddling the break. Before the fix the pre-break chunks were addressed as
    // if they ended exactly where the resumed chunk starts (wall [2900,3100)), i.e. shifted
    // forward by the gap length.
    const read = rb.readByWallClock(2900, 300);
    const pcm = readFloats(read.pcm);

    expect(pcm.slice(0, 200).every(v => v === 0)).toBe(true);
    expect(pcm.slice(200).every(v => v === 0.5)).toBe(true);
    expect(read).toMatchObject({
      requestedSamples: 300,
      presentSamples: 100,
      evictedSamples: 200,
      futureSamples: 0,
      startSampleIndex: 0,
    });
    expect(read.filledRatio).toBeCloseTo(1 / 3, 5);
  });

  it('keeps post-break samples addressable at their own wall-clock position', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 100);
    rb.write(chunk(0.2), 200);
    rb.write(chunk(0.5), 3200); // resync: wall [3100,3200)
    rb.write(chunk(0.6), 3300); // contiguous: wall [3200,3300)

    const tail = rb.readByWallClock(3150, 100);
    expect(readFloats(tail.pcm)).toEqual([...Array(50).fill(0.5), ...Array(50).fill(0.6)]);
    expect(tail).toMatchObject({ presentSamples: 100, evictedSamples: 0, futureSamples: 0, startSampleIndex: 250 });
    expect(rb.getStatus().resyncCount).toBe(1);

    // The original wall-clock span of the pre-break audio is not resurrected either.
    const original = rb.readByWallClock(0, 200);
    expect(original.presentSamples).toBe(0);
    expect(original.evictedSamples).toBe(200);
  });

  it('applies the same break to the ICOM seq path when an oversized seq jump forces a resync', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 100, 10);
    rb.write(chunk(0.2), 200, 11);
    // seq jump far beyond MAX_GAP_FILL_MS: no silence flood, resync instead.
    rb.write(chunk(0.3), 200_000, 2011); // wall [199_900, 200_000)

    const read = rb.readByWallClock(199_700, 300);
    const pcm = readFloats(read.pcm);
    expect(rb.getStatus()).toMatchObject({ resyncCount: 1, totalSamplesWritten: 300, timelineStartSampleIndex: 200 });
    expect(pcm.slice(0, 200).every(v => v === 0)).toBe(true);
    expect(pcm.slice(200).every(v => v === 0.3)).toBe(true);
    expect(read).toMatchObject({ presentSamples: 100, evictedSamples: 200 });
  });

  it('applies the same break when the arrival clock steps backwards', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 1100); // wall [1000,1100)
    rb.write(chunk(0.2), 1200); // wall [1100,1200)
    // Clock stepped back by ~1 s: resync maps abs 300 <-> wall 300.
    rb.write(chunk(0.5), 300); // wall [200,300)

    const read = rb.readByWallClock(0, 300);
    const pcm = readFloats(read.pcm);
    expect(rb.getStatus().resyncCount).toBe(1);
    expect(pcm.slice(0, 200).every(v => v === 0)).toBe(true);
    expect(pcm.slice(200).every(v => v === 0.5)).toBe(true);
    expect(read).toMatchObject({ presentSamples: 100, evictedSamples: 200 });
  });

  it('does not affect streaming readNext, which still returns every stored sample in order', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 100);
    rb.write(chunk(0.2), 200);
    rb.write(chunk(0.5), 3200);

    const streamed = readFloats(rb.readNext(300));
    expect(streamed).toEqual([...Array(100).fill(0.1), ...Array(100).fill(0.2), ...Array(100).fill(0.5)]);
  });

  it('clear() resets the timeline start', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(chunk(0.1), 100);
    rb.write(chunk(0.5), 3200);
    expect(rb.getStatus().timelineStartSampleIndex).toBe(100);

    rb.clear();
    rb.write(chunk(0.7), 100);
    expect(rb.getStatus().timelineStartSampleIndex).toBe(0);
    expect(rb.readByWallClock(0, 100).presentSamples).toBe(100);
  });
});

describe('RingBuffer wall-clock read metadata (RX-10)', () => {
  it('reports the whole window as future when the clock model is not anchored yet', () => {
    const rb = new RingBuffer(10, 10_000, () => 0);

    const read = rb.readByWallClock(0, 500);

    expect(readFloats(read.pcm)).toEqual([0, 0, 0, 0, 0]);
    expect(read).toEqual(expect.objectContaining({
      filledRatio: 0,
      requestedSamples: 5,
      presentSamples: 0,
      futureSamples: 5,
      evictedSamples: 0,
      startSampleIndex: 0,
    }));
    expect(rb.getStatus().anchorWallMs).toBeNull();
  });

  it('reports a zero-length request as fully filled even before anchoring', () => {
    const rb = new RingBuffer(10, 10_000, () => 0);

    const read = rb.readByWallClock(0, 0);

    expect(read.pcm.byteLength).toBe(0);
    expect(read).toMatchObject({ filledRatio: 1, requestedSamples: 0, futureSamples: 0, evictedSamples: 0 });
  });

  it('counts samples already pushed out of the ring as evicted and zero-fills them', () => {
    // capacity 5 samples (10 Hz x 500 ms); 7 samples at t=700 -> wall [0,700), retained abs [2,7)
    const rb = new RingBuffer(10, 500, () => 0);
    rb.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]), 700);

    const read = rb.readByWallClock(0, 500);

    expect(readFloats(read.pcm)).toEqual([0, 0, 0.3, 0.4, 0.5]);
    expect(read).toMatchObject({
      requestedSamples: 5,
      presentSamples: 3,
      evictedSamples: 2,
      futureSamples: 0,
      startSampleIndex: 0,
    });
    expect(read.filledRatio).toBeCloseTo(0.6, 5);
  });

  it('drops the metadata at the provider getBuffer boundary (only PCM is returned)', async () => {
    let now = 700;
    const provider = new RingBufferAudioProvider(10, 500, () => now);
    provider.writeAudio(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]), 700);
    now = 1000;

    const buffer = await provider.getBuffer(0, 500);

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(readFloats(buffer)).toEqual([0, 0, 0.3, 0.4, 0.5]);
    expect(provider.readByWallClock(0, 500).evictedSamples).toBe(2);
  });
});

describe('RingBuffer input sanitizing (RX-12)', () => {
  it('stores NaN and infinities as 0 and clamps out-of-range samples to [-1, 1]', () => {
    const rb = new RingBuffer(10, 10_000, () => 0);
    // 6 samples @10 Hz = 600 ms, arrival t=600 -> wall [0,600)
    rb.write(floats([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -2, 0.25]), 600);

    const read = rb.readByWallClock(0, 600);

    expect(readFloats(read.pcm)).toEqual([0, 0, 0, 1, -1, 0.25]);
    expect(read.presentSamples).toBe(6);
    expect(readFloats(rb.readNext(6))).toEqual([0, 0, 0, 1, -1, 0.25]);
  });
});

describe('RingBuffer streaming consumption vs wall-clock reads (RX-13)', () => {
  it('shrinks the wall-clock addressable range when readNext consumes from the same ring', () => {
    const rb = new RingBuffer(10, 10_000, () => 0);
    rb.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), 1000); // wall [0,1000)
    expect(rb.readByWallClock(0, 1000).presentSamples).toBe(10);

    rb.readNext(4);

    const read = rb.readByWallClock(0, 1000);
    expect(readFloats(read.pcm)).toEqual([0, 0, 0, 0, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(read).toMatchObject({ presentSamples: 6, evictedSamples: 4, futureSamples: 0 });
    expect(read.filledRatio).toBeCloseTo(0.6, 5);
  });

  it('returns an all-zero window with no future/evicted attribution once readNext drains the ring', async () => {
    let now = 1000;
    const provider = new RingBufferAudioProvider(10, 10_000, () => now);
    provider.writeAudio(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), 1000);

    provider.readNextChunk(10);
    now = 1500;

    const read = provider.readByWallClock(0, 1000);
    expect(readFloats(read.pcm).every(v => v === 0)).toBe(true);
    expect(read).toMatchObject({ filledRatio: 0, presentSamples: 0, futureSamples: 0, evictedSamples: 0 });
    expect(readFloats(await provider.getBuffer(0, 1000)).every(v => v === 0)).toBe(true);
  });
});
