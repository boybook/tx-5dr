import { describe, expect, it } from 'vitest';
import { buildReceptionPointCardHtml, getSnrLevel } from './receptionPointCard';
import { getReceptionTheme } from './receptionThemes';
import type { ReceptionStation } from './receptionGlobe';

const NOW = Date.UTC(2026, 10, 24, 10, 6, 0);
const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? `:${Object.values(options).join(',')}` : ''}`;

function station(overrides: Partial<ReceptionStation> = {}): ReceptionStation {
  return {
    callsign: '9M2CNC',
    locator: 'OJ03TB',
    lat: 3,
    lng: 101,
    mode: 'FT8',
    frequency: 21_076_000,
    snr: -8,
    transmittedAt: NOW - 3 * 60_000,
    reportedAt: NOW - 3 * 60_000 + 92_000,
    source: 'live',
    reportCount: 1,
    freshness: 1,
    distanceKm: 3456.4,
    ...overrides,
  };
}

describe('reception point card', () => {
  it('grades SNR into four levels', () => {
    expect([-2, -8, -15, -22, undefined].map(getSnrLevel)).toEqual([4, 3, 2, 1, 0]);
  });

  it('shows band, mode, strength, distance and age at a glance', () => {
    const html = buildReceptionPointCardHtml(station(), getReceptionTheme('teal'), NOW, t);
    expect(html).toContain('>15m<');
    expect(html).toContain('>FT8<');
    expect(html).toContain('-8 dB');
    expect(html).toContain('3,456 km');
    expect(html).toContain('globe.receptionMinutesAgo:3');
    expect(html).toContain('globe.receptionReportDelay:92');
  });

  it('escapes receiver names from the feed', () => {
    const html = buildReceptionPointCardHtml(station({ callsign: '<img src=x>' }), getReceptionTheme('teal'), NOW, t);
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});
