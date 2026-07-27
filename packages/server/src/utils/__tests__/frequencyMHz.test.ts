import { describe, expect, it } from 'vitest';
import { formatFrequencyMHz } from '../frequencyMHz.js';

describe('frequency formatting', () => {
  describe('formatFrequencyMHz', () => {
    it('pads to three decimals when fewer', () => {
      expect(formatFrequencyMHz(145_000_000)).toBe('145.000');
      expect(formatFrequencyMHz(7_000_000)).toBe('7.000');
      expect(formatFrequencyMHz(146_520_000)).toBe('146.520');
      expect(formatFrequencyMHz(1_000_000)).toBe('1.000');
    });

    it('keeps exactly three decimals at 1 kHz granularity', () => {
      expect(formatFrequencyMHz(145_895_000)).toBe('145.895');
      expect(formatFrequencyMHz(14_074_000)).toBe('14.074');
    });

    it('preserves all significant digits beyond three', () => {
      // 145.89525 MHz — would be truncated to 145.895 by toFixed(3)
      expect(formatFrequencyMHz(145_895_250)).toBe('145.89525');
      // 50.125625 MHz
      expect(formatFrequencyMHz(50_125_625)).toBe('50.125625');
      // 10.000005 MHz (5 Hz)
      expect(formatFrequencyMHz(10_000_005)).toBe('10.000005');
    });

    it('handles sub-MHz frequencies', () => {
      expect(formatFrequencyMHz(1_000)).toBe('0.001');
      expect(formatFrequencyMHz(1_500_000)).toBe('1.500');
    });

    it('handles zero and non-finite', () => {
      expect(formatFrequencyMHz(0)).toBe('0.000');
      expect(formatFrequencyMHz(NaN)).toBe('');
      expect(formatFrequencyMHz(Infinity)).toBe('');
    });
  });
});
