import { describe, expect, it } from 'vitest';
import { formatFrequencyMHz, parseFrequencyMHzToHz } from '../frequencyMHz';

describe('frequencyMHz', () => {
  it('preserves FAX dial frequencies below 1 kHz precision', () => {
    expect(formatFrequencyMHz(4_233_100)).toBe('4.2331');
    expect(parseFrequencyMHzToHz('4.2331')).toBe(4_233_100);
  });

  it('supports the full six MHz decimal places used for 1 Hz resolution', () => {
    expect(formatFrequencyMHz(14_230_001)).toBe('14.230001');
    expect(parseFrequencyMHzToHz('14.230001')).toBe(14_230_001);
  });

  it('keeps familiar three-decimal formatting when no extra precision is needed', () => {
    expect(formatFrequencyMHz(14_230_000)).toBe('14.230');
    expect(formatFrequencyMHz(14_230_000, 0)).toBe('14.23');
  });

  it('rounds input to canonical integer Hz', () => {
    expect(parseFrequencyMHzToHz('14.2300006')).toBe(14_230_001);
    expect(formatFrequencyMHz(14_230_000.6)).toBe('14.230001');
  });

  it('rejects empty, non-numeric, and non-positive values', () => {
    expect(parseFrequencyMHzToHz('')).toBeNull();
    expect(parseFrequencyMHzToHz('14.23 MHz')).toBeNull();
    expect(parseFrequencyMHzToHz('0')).toBeNull();
    expect(parseFrequencyMHzToHz('-1')).toBeNull();
  });
});
