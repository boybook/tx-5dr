import { describe, expect, it } from 'vitest';
import { getRenderedArcAltitude } from '../logbookGlobe';

describe('logbookGlobe arc altitude', () => {
  it('keeps nearby QSOs close to the existing visual profile', () => {
    expect(getRenderedArcAltitude(1_200, false)).toBeCloseTo(0.11, 3);
    expect(getRenderedArcAltitude(1_200, true)).toBeCloseTo(0.178, 3);
  });

  it('raises very long arcs so they stay above the globe surface', () => {
    const longHaulAltitude = getRenderedArcAltitude(18_500, false);
    const highlightedLongHaulAltitude = getRenderedArcAltitude(18_500, true);

    expect(longHaulAltitude).toBeGreaterThan(0.7);
    expect(longHaulAltitude).toBeLessThan(0.8);
    expect(highlightedLongHaulAltitude).toBeGreaterThanOrEqual(longHaulAltitude);
  });
});
