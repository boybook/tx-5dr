import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../ringBuffer.js';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';

function floats(values: number[]): Float32Array {
  return new Float32Array(values);
}

function readFloats(buffer: ArrayBuffer): number[] {
  return Array.from(new Float32Array(buffer), value => Number(value.toFixed(3)));
}

// 模型约定：chunk 的到达时间对应其“末尾样本”的采集时刻，
// 因此 write(samples, arrival) 把样本映射到挂钟区间 [arrival - 时长, arrival)。
describe('RingBuffer wall-clock addressed reads', () => {
  it('positions the decode window by wall clock (samples land at their captured time)', async () => {
    let now = 1000;
    const provider = new RingBufferAudioProvider(10, 10_000, () => now);
    // 10 个样本 @10Hz = 1000ms；到达 t=1000 → 映射到挂钟 [0,1000)
    provider.writeAudio(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]));

    now = 1500;
    const buffer = await provider.getBuffer(0, 500);

    // 请求挂钟 [0,500) → 最早的 5 个样本（按采集时间对齐），而非最新尾部
    expect(readFloats(buffer)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('reports a full buffer when writeIndex catches readIndex exactly at capacity', () => {
    const ringBuffer = new RingBuffer(10, 1000, () => 0);

    // 显式到达 t=1000 → 样本映射到挂钟 [0,1000)
    ringBuffer.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), 1000);

    expect(ringBuffer.getStatus()).toMatchObject({
      availableSamples: 10,
      storedSamples: 10,
      writeIndex: 0,
      readIndex: 0,
    });
    expect(readFloats(ringBuffer.readFromSlotStart(0, 1000))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('anchors the capture clock on first audio write (chunk end aligns to arrival)', () => {
    const ringBuffer = new RingBuffer(1000, 1000, () => 0);

    // 100 个样本 @1000Hz = 100ms；到达 t=5000 → 首样本(序号0)对应挂钟 4900
    ringBuffer.write(new Float32Array(100), 5000);

    expect(ringBuffer.getStatus()).toMatchObject({
      totalSamplesWritten: 100,
      anchorWallMs: 4900,
      anchorSampleIndex: 0,
      modelErrMs: 0,
    });
  });

  it('drops the oldest samples on overflow and keeps the newest tail addressable by wall clock', () => {
    const ringBuffer = new RingBuffer(10, 500, () => 0);

    // size=5（10Hz × 500ms）；写 7 个 @10Hz=700ms，到达 t=700 → 映射挂钟 [0,700)
    // 物理保留最新 5 个（绝对序号 [2,7) ↔ 挂钟 [200,700)）
    ringBuffer.write(floats([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]), 700);

    expect(ringBuffer.getAvailableSamples()).toBe(5);
    expect(readFloats(ringBuffer.readFromSlotStart(200, 500))).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it('zero-fills the not-yet-arrived tail and reports a partial filledRatio', () => {
    const ringBuffer = new RingBuffer(10, 10_000, () => 0);
    // 3 个样本 @10Hz=300ms，到达 t=300 → 映射挂钟 [0,300)
    ringBuffer.write(floats([0.1, 0.2, 0.3]), 300);

    // 请求 [0,500) → 前 3 个命中，后 2 个落在未来 → 零填充
    const read = ringBuffer.readByWallClock(0, 500);
    expect(readFloats(read.pcm)).toEqual([0.1, 0.2, 0.3, 0, 0]);
    expect(read.presentSamples).toBe(3);
    expect(read.futureSamples).toBe(2);
    expect(read.filledRatio).toBeCloseTo(0.6, 5);
  });

  it('absorbs arrival jitter without shifting the window (clamped anchor step)', () => {
    const ringBuffer = new RingBuffer(1000, 10_000, () => 0);
    // 稳定写入：每 100ms 到达 100 个样本（=1000Hz），到达 t=100,200,...,500
    for (let chunk = 1; chunk <= 5; chunk++) {
      ringBuffer.write(new Float32Array(100), chunk * 100);
    }
    const anchorBefore = ringBuffer.getStatus().anchorWallMs as number;

    // 一个迟到 40ms 的 chunk（应到 t=600，实到 t=640）
    ringBuffer.write(new Float32Array(100), 640);
    const status = ringBuffer.getStatus();

    // 锚点单步移动被钳制（≤MAX_STEP_MS=5ms），一次抖动不会整窗拉偏，也不触发重锚
    expect(Math.abs((status.anchorWallMs as number) - anchorBefore)).toBeLessThanOrEqual(5 + 1e-6);
    expect(status.resyncCount).toBe(0);
  });

  it('resyncs the timeline after a large stall instead of staying misaligned', () => {
    const ringBuffer = new RingBuffer(1000, 10_000, () => 0);
    ringBuffer.write(new Float32Array(100), 100);  // 挂钟 [0,100)
    ringBuffer.write(new Float32Array(100), 200);  // 挂钟 [100,200)

    // 网络停顿 ~3s 后恢复：误差远超 RESYNC_THRESHOLD → 重锚
    ringBuffer.write(new Float32Array(100).fill(0.5), 3200);

    const status = ringBuffer.getStatus();
    expect(status.resyncCount).toBe(1);
    // 重锚后最新 chunk 对齐到达时间：读其挂钟区间应命中真实数据而非全零
    const read = ringBuffer.readByWallClock(3100, 100);
    expect(read.presentSamples).toBeGreaterThan(0);
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

// 1000Hz → 1 样本=1ms；每包 100 样本=100ms。write(samples, arrival, seq)。
describe('RingBuffer seq-based packet-loss handling', () => {
  const pkt = (v: number) => new Float32Array(100).fill(v);

  it('appends contiguous seq packets without inserting silence', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(pkt(0.1), 100, 10);
    rb.write(pkt(0.2), 200, 11);

    expect(rb.getStatus()).toMatchObject({
      totalSamplesWritten: 200,
      lostPackets: 0,
      dupPackets: 0,
      lastSeq: 11,
    });
  });

  it('fills exactly one packet of silence at the correct position when a seq is lost', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(pkt(0.1), 100, 10); // wall [0,100)
    // seq 11 lost; seq 12 arrives at t=300
    rb.write(pkt(0.2), 300, 12); // delta=2 → 1 lost → insert 100 silence then packet

    const s = rb.getStatus();
    expect(s.lostPackets).toBe(1);
    expect(s.totalSamplesWritten).toBe(300); // 100 + 100 silence + 100
    expect(s.lastSeq).toBe(12);

    // lost interval [100,200) is silence; recovered packet sits at [200,300)
    expect(readFloats(rb.readByWallClock(100, 100).pcm).every(v => v === 0)).toBe(true);
    const recovered = rb.readByWallClock(200, 100);
    expect(recovered.presentSamples).toBe(100);
    expect(Number(new Float32Array(recovered.pcm)[0].toFixed(3))).toBe(0.2);
  });

  it('drops duplicate and reordered-old packets (no timeline perturbation)', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(pkt(0.1), 100, 10);
    rb.write(pkt(0.2), 200, 11);
    rb.write(pkt(0.9), 250, 11); // duplicate seq → drop
    rb.write(pkt(0.8), 260, 10); // reordered-old seq → drop

    expect(rb.getStatus()).toMatchObject({
      totalSamplesWritten: 200,
      dupPackets: 2,
      lastSeq: 11,
    });
  });

  it('handles 16-bit seq wraparound (0xffff → 0) as contiguous', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(pkt(0.1), 100, 0xffff);
    rb.write(pkt(0.2), 200, 0x0000); // wrap → delta=1

    expect(rb.getStatus()).toMatchObject({
      totalSamplesWritten: 200,
      lostPackets: 0,
      lastSeq: 0,
    });
  });

  it('resyncs instead of flooding silence on an oversized seq jump', () => {
    const rb = new RingBuffer(1000, 10_000, () => 0);
    rb.write(pkt(0.1), 100, 10);
    rb.write(pkt(0.2), 200, 11);
    // long stall: seq jumps far beyond MAX_GAP_FILL and arrival is consistently far ahead
    rb.write(pkt(0.3), 200_000, 2011);

    const s = rb.getStatus();
    expect(s.resyncCount).toBe(1);
    expect(s.lastSeq).toBe(2011);
    expect(s.totalSamplesWritten).toBe(300); // no silence flood, just the 3 real packets
  });
});
