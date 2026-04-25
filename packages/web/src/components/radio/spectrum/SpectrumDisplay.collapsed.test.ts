import { describe, expect, it } from 'vitest';
import {
  clampCollapsedSpectrumFrequency,
  getCollapsedSpectrumPosition,
} from './SpectrumDisplay';

describe('collapsed spectrum positioning', () => {
  it('clamps digital baseband frequencies to 0-3000 Hz', () => {
    expect(clampCollapsedSpectrumFrequency(-100)).toBe(0);
    expect(clampCollapsedSpectrumFrequency(1500)).toBe(1500);
    expect(clampCollapsedSpectrumFrequency(3100)).toBe(3000);
  });

  it('maps digital baseband frequencies to collapsed bar positions', () => {
    expect(getCollapsedSpectrumPosition(0)).toBe(0);
    expect(getCollapsedSpectrumPosition(1500)).toBe(50);
    expect(getCollapsedSpectrumPosition(3000)).toBe(100);
  });
});
