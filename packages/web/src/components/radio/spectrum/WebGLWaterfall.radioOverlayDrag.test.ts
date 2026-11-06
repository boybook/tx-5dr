import { describe, expect, it, vi } from 'vitest';
import { resolveRadioOverlayDragFrequency } from './WebGLWaterfall';

describe('resolveRadioOverlayDragFrequency', () => {
  it('keeps an RF carrier drag absolute in digital (baseband gesture) sessions', () => {
    const clamp = vi.fn((frequency: number) => frequency);
    // Regression: the operator baseband range (0-3000 Hz) once turned a
    // carrier drag at 14.074 MHz into a 16 Hz radio frequency write.
    expect(resolveRadioOverlayDragFrequency(14_074_016.4, 'baseband', clamp)).toBe(14_074_016);
    expect(clamp).not.toHaveBeenCalled();
  });

  it('applies the negotiated absolute range and step in absolute gesture sessions', () => {
    const clamp = vi.fn((frequency: number) => Math.round(Math.min(14_350_000, frequency) / 100) * 100);
    expect(resolveRadioOverlayDragFrequency(14_200_049, 'absolute', clamp)).toBe(14_200_000);
    expect(resolveRadioOverlayDragFrequency(14_400_000, 'absolute', clamp)).toBe(14_350_000);
  });
});
