import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeterministicTxMonitorTap } from '../DeterministicTxMonitorTap.js';

describe('DeterministicTxMonitorTap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function useClock() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  }

  it.each([1024, 64])('paces 48 kHz device frames of %i samples as 20 ms monitor frames', async (deviceSamples) => {
    useClock();
    const emitted: Array<{ at: number; samples: Float32Array }> = [];
    const stopped = vi.fn();
    const tap = new DeterministicTxMonitorTap(48_000, (samples) => {
      emitted.push({ at: Date.now(), samples });
    }, stopped);
    const deviceFrames = deviceSamples === 1024 ? 20 : 300;
    for (let index = 0; index < deviceFrames; index += 1) {
      tap.offer(new Float32Array(deviceSamples).fill(index / deviceFrames));
      await vi.advanceTimersByTimeAsync(deviceSamples * 1000 / 48_000);
    }
    tap.finish();
    await vi.advanceTimersByTimeAsync(200);

    expect(emitted.reduce((sum, item) => sum + item.samples.length, 0)).toBe(deviceFrames * deviceSamples);
    expect(emitted.slice(0, -1).every((item) => item.samples.length === 960)).toBe(true);
    expect(emitted.slice(1).every((item, index) => item.at - emitted[index]!.at >= 10)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0]![0].droppedFrames).toBe(0);
  });

  it('drops stale monitor PCM after a delayed event-loop turn and clears cancelled sessions', async () => {
    useClock();
    const emit = vi.fn();
    const stopped = vi.fn();
    const tap = new DeterministicTxMonitorTap(48_000, emit, stopped);
    tap.offer(new Float32Array(9_600));
    expect(stopped).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledTimes(1);
    tap.abort();
    await vi.advanceTimersByTimeAsync(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0]![0].droppedFrames).toBeGreaterThan(0);
  });

  it('does not play queued audio after a long event-loop stall', async () => {
    useClock();
    const emit = vi.fn();
    const tap = new DeterministicTxMonitorTap(48_000, emit, vi.fn());
    tap.offer(new Float32Array(4_800));
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000);
    await vi.advanceTimersByTimeAsync(20);
    expect(emit).toHaveBeenCalledTimes(1);
    tap.offer(new Float32Array(960));
    await vi.advanceTimersByTimeAsync(20);
    expect(emit).toHaveBeenCalledTimes(2);
    tap.abort();
  });

  it('paces a CHRONO consumption burst without publishing the burst at once', async () => {
    useClock();
    const emitted: number[] = [];
    const stopped = vi.fn();
    const waveform = Float32Array.from({ length: 14_400 }, (_, index) => index / 14_400);
    const tap = new DeterministicTxMonitorTap(12_000, (samples) => {
      emitted.push(samples[0]!);
    }, stopped);
    tap.acceptPrepared(waveform, waveform.length);
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    expect(emitted.length).toBeLessThanOrEqual(11);
    expect(emitted[1]).toBeCloseTo(240 / 14_400);
    tap.finish();
    const emittedAtFinish = emitted.length;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(emitted).toHaveLength(emittedAtFinish);
    expect(stopped.mock.calls[0]![0].droppedFrames).toBeGreaterThan(0);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('resumes TCI monitoring after a CHRONO gap without skipping unconsumed samples', async () => {
    useClock();
    const emitted: number[] = [];
    const waveform = Float32Array.from({ length: 400 }, (_, index) => index);
    const tap = new DeterministicTxMonitorTap(1_000, (samples) => emitted.push(samples[0]!), vi.fn());
    tap.acceptPrepared(waveform, 20);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(220);
    tap.acceptPrepared(waveform, 40);
    await vi.advanceTimersByTimeAsync(0);
    tap.acceptPrepared(waveform, 60);
    await vi.advanceTimersByTimeAsync(20);
    expect(emitted).toEqual([0, 20, 40]);
    tap.abort();
  });

  it('keeps the intentional 100 ms submission lead without trimming ICOM startup audio', async () => {
    useClock();
    const emitted: number[] = [];
    const stopped = vi.fn();
    const tap = new DeterministicTxMonitorTap(12_000, (samples) => emitted.push(samples[0]!), stopped, 100);
    tap.offer(new Float32Array(1_200).fill(1));
    tap.offer(new Float32Array(1_200).fill(2));
    await vi.advanceTimersByTimeAsync(100);
    tap.offer(new Float32Array(1_200).fill(3));
    await vi.advanceTimersByTimeAsync(80);
    tap.abort();
    expect(emitted).toHaveLength(10);
    expect(emitted[0]).toBe(1);
    expect(emitted[5]).toBe(2);
    expect(stopped.mock.calls[0]![0].droppedFrames).toBe(0);
  });

  it('keeps observer errors out of the output lifecycle', async () => {
    useClock();
    const stopped = vi.fn();
    const tap = new DeterministicTxMonitorTap(12_000, () => { throw new Error('listener'); }, stopped);
    tap.offer(new Float32Array(480));
    await vi.advanceTimersByTimeAsync(0);
    tap.finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped.mock.calls[0]![0].emittedFrames).toBe(2);
    expect(stopped.mock.calls[0]![0].observerFailures).toBe(2);
  });
});
