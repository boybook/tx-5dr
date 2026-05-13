import { describe, expect, it } from 'vitest';
import {
  encodeTextToCWEvents,
  encodeTextToCWKeyStateSegments,
  estimateCWMessageDurationMs,
} from '../cwTiming.js';

function totalSegmentDuration(text: string, wpm: number): number {
  return encodeTextToCWKeyStateSegments(text, wpm).reduce((sum, segment) => sum + segment.durationMs, 0);
}

describe('CW timing utilities', () => {
  it('returns no events and zero duration for blank text', () => {
    expect(encodeTextToCWEvents('   ', 20)).toEqual([]);
    expect(encodeTextToCWKeyStateSegments('   ', 20)).toEqual([]);
    expect(estimateCWMessageDurationMs('', 20)).toBe(0);
  });

  it('encodes exact key events for simple characters and spacing', () => {
    expect(encodeTextToCWEvents('E', 20)).toEqual([
      { type: 'key-down', afterMs: 0 },
      { type: 'key-up', afterMs: 60 },
    ]);

    expect(encodeTextToCWEvents('EE', 20)).toEqual([
      { type: 'key-down', afterMs: 0 },
      { type: 'key-up', afterMs: 60 },
      { type: 'key-down', afterMs: 180 },
      { type: 'key-up', afterMs: 60 },
    ]);

    expect(encodeTextToCWEvents('E E', 20)).toEqual([
      { type: 'key-down', afterMs: 0 },
      { type: 'key-up', afterMs: 60 },
      { type: 'key-down', afterMs: 420 },
      { type: 'key-up', afterMs: 60 },
    ]);

    expect(encodeTextToCWEvents('A', 20)).toEqual([
      { type: 'key-down', afterMs: 0 },
      { type: 'key-up', afterMs: 60 },
      { type: 'key-down', afterMs: 60 },
      { type: 'key-up', afterMs: 180 },
    ]);
  });

  it('encodes exact key state segments for browser sidetone adapters', () => {
    expect(encodeTextToCWKeyStateSegments('E', 20)).toEqual([
      { keyDown: true, durationMs: 60 },
    ]);

    expect(encodeTextToCWKeyStateSegments('EE', 20)).toEqual([
      { keyDown: true, durationMs: 60 },
      { keyDown: false, durationMs: 180 },
      { keyDown: true, durationMs: 60 },
    ]);

    expect(encodeTextToCWKeyStateSegments('E E', 20)).toEqual([
      { keyDown: true, durationMs: 60 },
      { keyDown: false, durationMs: 420 },
      { keyDown: true, durationMs: 60 },
    ]);

    expect(encodeTextToCWKeyStateSegments('A', 20)).toEqual([
      { keyDown: true, durationMs: 60 },
      { keyDown: false, durationMs: 60 },
      { keyDown: true, durationMs: 180 },
    ]);
  });

  it('scales duration by WPM', () => {
    expect(estimateCWMessageDurationMs('EE', 20)).toBe(300);
    expect(estimateCWMessageDurationMs('EE', 40)).toBe(150);
  });

  it('uses the Hamlib/PARIS exact dot duration for non-divisible WPM values', () => {
    expect(estimateCWMessageDurationMs('EE', 17)).toBe(353);
  });

  it('treats prosigns as single Morse tokens rather than re-encoding dots and dashes', () => {
    expect(estimateCWMessageDurationMs('<SK>', 20)).toBe(900);
    expect(totalSegmentDuration('<SK>', 20)).toBe(900);
    expect(totalSegmentDuration('<CL>', 20)).toBeGreaterThan(0);
  });

  it('keeps unsupported-character and WPM clamp behavior', () => {
    expect(estimateCWMessageDurationMs('E☃E', 20)).toBe(300);
    expect(estimateCWMessageDurationMs('E', 1)).toBe(240);
    expect(estimateCWMessageDurationMs('E', 1000)).toBe(20);
  });
});
