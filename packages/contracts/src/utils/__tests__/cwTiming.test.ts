import { describe, expect, it } from 'vitest';
import { encodeTextToCWEvents, estimateCWMessageDurationMs } from '../cwTiming.js';

describe('CW timing utilities', () => {
  it('returns no events and zero duration for blank text', () => {
    expect(encodeTextToCWEvents('   ', 20)).toEqual([]);
    expect(estimateCWMessageDurationMs('', 20)).toBe(0);
  });

  it('scales duration by WPM', () => {
    expect(estimateCWMessageDurationMs('EE', 20)).toBe(300);
    expect(estimateCWMessageDurationMs('EE', 40)).toBe(150);
  });

  it('uses the Hamlib/PARIS exact dot duration for non-divisible WPM values', () => {
    expect(estimateCWMessageDurationMs('EE', 17)).toBe(353);
  });

  it('keeps existing prosign and unsupported-character behavior', () => {
    expect(estimateCWMessageDurationMs('<SK>', 20)).toBeGreaterThan(0);
    expect(estimateCWMessageDurationMs('E☃E', 20)).toBe(300);
  });
});
