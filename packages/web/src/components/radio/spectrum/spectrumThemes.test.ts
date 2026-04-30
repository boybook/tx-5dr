import { describe, expect, it } from 'vitest';
import {
  buildSpectrumThemeColorLut,
  DEFAULT_SPECTRUM_THEME_ID,
  getSafeSpectrumThemeCurve,
  getSpectrumTheme,
  getSpectrumThemePreviewGradient,
  normalizeSpectrumThemeId,
  SPECTRUM_THEME_IDS,
} from './spectrumThemes';

describe('spectrumThemes', () => {
  it('builds a 256-step RGBA lookup table for every theme', () => {
    for (const themeId of SPECTRUM_THEME_IDS) {
      const lut = buildSpectrumThemeColorLut(themeId);
      expect(lut).toHaveLength(256 * 4);

      for (let index = 3; index < lut.length; index += 4) {
        expect(lut[index]).toBe(255);
      }
    }
  });

  it('keeps the classic endpoints compatible with the previous hard-coded palette', () => {
    const lut = buildSpectrumThemeColorLut('classic');

    expect(Array.from(lut.slice(0, 4))).toEqual([0, 0, 0x20, 255]);
    expect(Array.from(lut.slice(lut.length - 4))).toEqual([0x4a, 0, 0, 255]);
  });

  it('matches WSJT-X source palette endpoints', () => {
    expect(Array.from(buildSpectrumThemeColorLut('wsjtx-default').slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(buildSpectrumThemeColorLut('wsjtx-default').slice(-4))).toEqual([255, 51, 0, 255]);
    expect(Array.from(buildSpectrumThemeColorLut('wsjtx-sunburst').slice(-4))).toEqual([255, 255, 255, 255]);
  });

  it('uses Google Turbo endpoints for OpenWebRX and SDR++ Turbo themes', () => {
    expect(Array.from(buildSpectrumThemeColorLut('openwebrx-turbo').slice(0, 4))).toEqual([0x30, 0x12, 0x3b, 255]);
    expect(Array.from(buildSpectrumThemeColorLut('openwebrx-turbo').slice(-4))).toEqual([0x7a, 0x04, 0x03, 255]);
    expect(Array.from(buildSpectrumThemeColorLut('sdrpp-turbo'))).toEqual(
      Array.from(buildSpectrumThemeColorLut('openwebrx-turbo'))
    );
  });

  it('falls back to the classic theme for unknown ids', () => {
    const fallback = getSpectrumTheme('not-a-theme');

    expect(fallback.id).toBe(DEFAULT_SPECTRUM_THEME_ID);
    expect(Array.from(buildSpectrumThemeColorLut('not-a-theme'))).toEqual(
      Array.from(buildSpectrumThemeColorLut(DEFAULT_SPECTRUM_THEME_ID))
    );
  });

  it('maps legacy theme ids to their renamed themes', () => {
    expect(normalizeSpectrumThemeId('openwebrx')).toBe('openwebrx-turbo');
    expect(normalizeSpectrumThemeId('sdrpp-rainbow')).toBe('sdrpp-turbo');
  });

  it('creates non-empty preview gradients for all themes', () => {
    for (const themeId of SPECTRUM_THEME_IDS) {
      const gradient = getSpectrumThemePreviewGradient(themeId);

      expect(gradient).toContain('linear-gradient');
      expect(gradient).toContain('rgb(');
    }
  });

  it('keeps tone curve parameters inside shader-safe ranges', () => {
    for (const themeId of SPECTRUM_THEME_IDS) {
      const curve = getSafeSpectrumThemeCurve(themeId);

      expect(curve.gamma).toBeGreaterThanOrEqual(0.2);
      expect(curve.gamma).toBeLessThanOrEqual(3);
      expect(curve.contrast).toBeGreaterThanOrEqual(0.25);
      expect(curve.contrast).toBeLessThanOrEqual(3);
      expect(curve.bias).toBeGreaterThanOrEqual(-0.5);
      expect(curve.bias).toBeLessThanOrEqual(0.5);
    }
  });
});
