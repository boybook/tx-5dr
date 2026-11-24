import { describe, expect, it } from 'vitest';
import { RECEPTION_THEMES, getReceptionTheme } from './receptionThemes';

function parse(color: string) {
  const [r, g, b, a] = color.match(/[\d.]+/g)!.map(Number);
  return { r, g, b, a };
}

describe('reception themes', () => {
  it('fade every ramp out at sparse edges and brighten with density', () => {
    for (const theme of RECEPTION_THEMES) {
      expect(parse(theme.fogColor(0)).a).toBe(0);
      const alphas = [0.1, 0.4, 0.7, 1].map(density => parse(theme.fogColor(density)).a);
      expect(alphas).toEqual([...alphas].sort((left, right) => left - right));
      expect(alphas[3]).toBeLessThanOrEqual(0.5);
    }
  });

  it('runs the standard spectrum from blue to red', () => {
    const spectrum = getReceptionTheme('spectrum');
    const low = parse(spectrum.fogColor(0.04));
    const high = parse(spectrum.fogColor(1));
    expect(low.b).toBeGreaterThan(low.r);
    expect(high.r).toBeGreaterThan(high.b);
  });

  it('falls back to the default theme for unknown ids', () => {
    expect(getReceptionTheme('missing').id).toBe('teal');
    expect(getReceptionTheme(null).id).toBe('teal');
  });
});
