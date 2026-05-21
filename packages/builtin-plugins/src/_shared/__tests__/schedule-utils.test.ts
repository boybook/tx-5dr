import { describe, expect, it } from 'vitest';
import {
  isSameScheduleMinute,
  isTimeInScheduleRange,
  normalizeFrequencyMhzToHz,
  parseScheduleDays,
  parseScheduleTime,
} from '../schedule-utils.js';

describe('schedule utils', () => {
  it('parses daily and weekday range day expressions', () => {
    expect(Array.from(parseScheduleDays('daily') ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(parseScheduleDays('mon-fri') ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(parseScheduleDays('fri-mon') ?? [])).toEqual([5, 6, 7, 1]);
  });

  it('parses clock times and checks exact schedule minutes', () => {
    const time = parseScheduleTime('08:05');
    expect(time).toEqual({ hour: 8, minute: 5 });
    expect(isSameScheduleMinute(new Date(2026, 0, 1, 8, 5, 30), time!)).toBe(true);
    expect(parseScheduleTime('24:00')).toBeNull();
  });

  it('checks normal and overnight ranges', () => {
    expect(isTimeInScheduleRange(new Date(2026, 0, 1, 9, 0), { hour: 8, minute: 0 }, { hour: 10, minute: 0 })).toBe(true);
    expect(isTimeInScheduleRange(new Date(2026, 0, 1, 1, 0), { hour: 22, minute: 0 }, { hour: 2, minute: 0 })).toBe(true);
    expect(isTimeInScheduleRange(new Date(2026, 0, 1, 3, 0), { hour: 22, minute: 0 }, { hour: 2, minute: 0 })).toBe(false);
  });

  it('converts MHz to Hz', () => {
    expect(normalizeFrequencyMhzToHz('14.074')).toBe(14_074_000);
    expect(normalizeFrequencyMhzToHz('bad')).toBeNull();
  });
});
