import { describe, expect, it } from 'vitest';
import { buildLiveDecodeCardHtml } from './liveDecodeCard';
import { HighlightType } from './displayNotificationSettings';
import { I_HEARD_ACCENT, buildReceptionPointCardHtml, getHeardMeAccent } from './receptionPointCard';
import { RECEPTION_THEMES, getReceptionTheme } from './receptionThemes';
import type { LiveStation } from './liveDecodes';
import type { ReceptionStation } from './receptionGlobe';

const NOW = Date.UTC(2026, 10, 24, 10, 6, 0);
const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? `:${Object.values(options).join(',')}` : ''}`;

const liveStation: LiveStation = {
  callsign: 'VU2AAA',
  decode: {
    callsign: 'VU2AAA', message: 'CQ VU2AAA MK82', messageType: 'cq', snr: -9, dt: 0.1, freq: 1200,
    location: { lat: 19, lng: 73, precision: 'grid' }, analysis: { grid: 'MK82', isNewDxccEntity: true },
  },
  slotStartMs: NOW - 15_000,
  ageSlots: 0,
  isCq: true,
  highlight: HighlightType.NEW_PREFIX,
  color: '#22d3ee',
  tier: 1,
  lat: 19,
  lng: 73,
  approximate: false,
};

const receiver: ReceptionStation = {
  callsign: 'JH1ZZZ', locator: 'PM95', lat: 35.5, lng: 139.5, mode: 'FT8', frequency: 14_075_000, snr: -4,
  transmittedAt: NOW - 120_000, reportedAt: NOW - 30_000, source: 'live', reportCount: 1, freshness: 1, distanceKm: 1724,
};

function direction(html: string): string | undefined {
  return /data-direction="([^"]+)"/.exec(html)?.[1];
}

describe('station hover cards say which way the signal went', () => {
  it('opens a heard-live card with "I heard", the local source and their signal', () => {
    const html = buildLiveDecodeCardHtml(liveStation, { lat: 31.2, lng: 121.5 }, t);
    expect(direction(html)).toBe('iHeard');
    expect(html).toContain('globe.cardIHeard');
    expect(html).toContain('globe.cardSourceLocal');
    expect(html).toContain('globe.cardSnrTheirs');
    expect(html).toContain(`border-left:3px solid ${I_HEARD_ACCENT}`);
  });

  it('opens a receiver card with "heard me", PSK Reporter and my signal', () => {
    const html = buildReceptionPointCardHtml(receiver, getReceptionTheme('teal'), NOW, t);
    expect(direction(html)).toBe('heardMe');
    expect(html).toContain('globe.cardHeardMe');
    expect(html).toContain('globe.cardSourcePskReporter');
    expect(html).toContain('globe.cardSnrMine');
  });

  // Regression: the receiver bar used the theme's pale point colour, which is
  // near white in the spectrum theme and looked as grey as "I heard".
  it('keeps the two directions visibly apart in every reception theme', () => {
    // Colourfulness (max - min channel) separates a colour from grey far
    // better than RGB distance: a light violet is close to light grey in RGB
    // yet plainly not grey.
    const chroma = (color: string) => {
      const channels = color.match(/\d+/g)!.map(Number);
      return Math.max(...channels) - Math.min(...channels);
    };
    expect(chroma(I_HEARD_ACCENT)).toBeLessThanOrEqual(25);
    for (const theme of RECEPTION_THEMES) {
      const accent = getHeardMeAccent(theme);
      const html = buildReceptionPointCardHtml(receiver, theme, NOW, t);
      expect(html).toContain(`border-left:3px solid ${accent}`);
      expect(chroma(accent)).toBeGreaterThanOrEqual(80);
    }
  });
});
