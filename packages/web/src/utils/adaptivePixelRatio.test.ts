import { describe, expect, it } from 'vitest';
import { PixelRatioGovernor, getPixelRatioLevels } from './adaptivePixelRatio';

/** Feeds `seconds` of frames at `intervalMs`; returns every ratio change. */
function run(governor: PixelRatioGovernor, clock: { now: number }, intervalMs: number, seconds: number): number[] {
  const changes: number[] = [];
  const end = clock.now + seconds * 1000;
  while (clock.now < end) {
    clock.now += intervalMs;
    const change = governor.frame(intervalMs, clock.now);
    if (change !== null) changes.push(change);
  }
  return changes;
}

describe('getPixelRatioLevels', () => {
  it('steps down from the device ratio (at most 2) to 1', () => {
    expect(getPixelRatioLevels(2)).toEqual([2, 1.5, 1.25, 1]);
    expect(getPixelRatioLevels(3)).toEqual([2, 1.5, 1.25, 1]);
    expect(getPixelRatioLevels(1.5)).toEqual([1.5, 1.25, 1]);
    expect(getPixelRatioLevels(1)).toEqual([1]);
  });
});

describe('PixelRatioGovernor', () => {
  it('keeps full resolution while frames are on time', () => {
    const governor = new PixelRatioGovernor(getPixelRatioLevels(2));
    expect(run(governor, { now: 0 }, 1000 / 60, 30)).toEqual([]);
    expect(governor.ratio).toBe(2);
  });

  it('steps down while frames are sustainedly late, and not for a brief hitch', () => {
    const governor = new PixelRatioGovernor(getPixelRatioLevels(2));
    const clock = { now: 0 };
    run(governor, clock, 1000 / 60, 3);
    expect(run(governor, clock, 30, 1.5)).toEqual([]);
    expect(run(governor, clock, 1000 / 60, 3)).toEqual([]);
    expect(run(governor, clock, 30, 4)).toEqual([1.5]);
  });

  // A GPU too slow from the first frame never shows the display's rate; the
  // budget is still a 60 Hz frame at most.
  it('detects lateness even when frames were never fast', () => {
    const governor = new PixelRatioGovernor(getPixelRatioLevels(2));
    expect(run(governor, { now: 0 }, 33, 4)).toEqual([1.5]);
  });

  it('steps back up once frames are on time, and leaves a level that fails alone', () => {
    const governor = new PixelRatioGovernor(getPixelRatioLevels(2));
    const clock = { now: 0 };
    run(governor, clock, 1000 / 60, 2);
    expect(run(governor, clock, 30, 4)).toEqual([1.5]);
    expect(run(governor, clock, 1000 / 60, 11)).toEqual([2]);
    // Full resolution is still too much: undone at once, then not retried.
    expect(run(governor, clock, 30, 2)).toEqual([1.5]);
    expect(run(governor, clock, 1000 / 60, 30)).toEqual([]);
    expect(governor.ratio).toBe(1.5);
  });

  it('ignores pauses and timer noise', () => {
    const governor = new PixelRatioGovernor(getPixelRatioLevels(2));
    const clock = { now: 0 };
    clock.now += 5000;
    expect(governor.frame(5000, clock.now)).toBeNull();
    governor.frame(1, clock.now += 1);
    expect(run(governor, clock, 1000 / 60, 10)).toEqual([]);
  });
});
