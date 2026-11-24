import { describe, expect, it } from 'vitest';
import type { LogbookLiveDecode, LogbookLiveDecodesUpdate } from '@tx5dr/contracts';
import { DEFAULT_DISPLAY_SETTINGS, type DisplayNotificationSettings } from './displayNotificationSettings';
import {
  applyLiveDecodesUpdate,
  buildLiveStations,
  getDistanceAndBearing,
  type LiveDecodeView,
} from './liveDecodes';

const SLOT_MS = 15_000;
const T0 = Date.UTC(2026, 10, 24, 8, 0, 0);

function decode(callsign: string, overrides: Partial<LogbookLiveDecode> = {}): LogbookLiveDecode {
  return {
    callsign,
    message: `CQ ${callsign} PM95`,
    messageType: 'cq',
    snr: -10,
    dt: 0.1,
    freq: 1200,
    location: { lat: 35.7, lng: 139.7, precision: 'grid' },
    analysis: {},
    ...overrides,
  };
}

function slot(index: number, decodes: LogbookLiveDecode[], band = '20m'): LogbookLiveDecodesUpdate {
  return { operatorId: 'op', slotId: `s${index}`, slotStartMs: T0 + index * SLOT_MS, slotMs: SLOT_MS, band, decodes };
}

function view(...slots: LogbookLiveDecodesUpdate[]): LiveDecodeView {
  return slots.reduce<LiveDecodeView | null>((current, next) => applyLiveDecodesUpdate(current, next), null)!;
}

/** Shortly after slot `index` ended, while its decodes arrive. */
function during(index: number): number {
  return T0 + (index + 1) * SLOT_MS + 2_000;
}

describe('applyLiveDecodesUpdate', () => {
  it('replaces a slot sent again by a later decode window and keeps two cycles', () => {
    const current = view(
      slot(0, [decode('A1A')]),
      slot(1, [decode('B1B')]),
      slot(2, [decode('C1C')]),
      slot(3, [decode('D1D')]),
      slot(4, [decode('E1E')]),
      slot(4, [decode('E1E'), decode('F1F')]),
    );
    expect(current.slots.map(entry => entry.slotId)).toEqual(['s4', 's3', 's2', 's1']);
    expect(current.slots[0].decodes.map(entry => entry.callsign)).toEqual(['E1E', 'F1F']);
  });

  it('starts over on another band', () => {
    const current = view(slot(0, [decode('A1A')]), slot(1, [decode('B1B')], '40m'));
    expect(current.slots.map(entry => entry.slotId)).toEqual(['s1']);
  });
});

describe('buildLiveStations', () => {
  const settings = DEFAULT_DISPLAY_SETTINGS;

  it('ranks needed CQ callers first, then needed busy stations, plain CQs and the rest', () => {
    const current = view(slot(0, [
      decode('NEED1', { analysis: { isNewDxccEntity: true } }),
      decode('BUSY1', { messageType: 'signal_report', targetCallsign: 'JA1XYZ', analysis: { isNewGrid: true } }),
      decode('PLAIN1'),
      decode('CHAT1', { messageType: 'signal_report', targetCallsign: 'JA1XYZ' }),
    ]));
    const stations = buildLiveStations(current, during(0), settings);
    const tiers = Object.fromEntries(stations.map(station => [station.callsign, station.tier]));

    expect(tiers).toEqual({ NEED1: 1, BUSY1: 2, PLAIN1: 3, CHAT1: 4 });
    expect(stations.find(station => station.callsign === 'NEED1')?.color).toBe(settings.highlights.newPrefix.color);
    expect(stations.find(station => station.callsign === 'BUSY1')?.color).toBe(settings.highlights.newGrid.color);
  });

  it('keeps a needed CQ actionable for one cycle, then steps it back and fades it', () => {
    const current = view(slot(0, [decode('NEED1', { analysis: { isNewDxccEntity: true } })]), slot(1, []));
    expect(buildLiveStations(current, during(1), settings)[0]).toMatchObject({ tier: 1, ageSlots: 1 });
    // A quiet band: two more slot periods pass without decodes.
    expect(buildLiveStations(current, during(2), settings)[0]).toMatchObject({ tier: 2, ageSlots: 2 });
    expect(buildLiveStations(current, during(4), settings)).toEqual([]);
  });

  it('follows the decode table: a highlight switched off is not needed', () => {
    const quiet: DisplayNotificationSettings = {
      ...settings,
      highlights: { ...settings.highlights, newPrefix: { ...settings.highlights.newPrefix, enabled: false } },
    };
    const current = view(slot(0, [decode('NEED1', { analysis: { isNewDxccEntity: true } })]));
    expect(buildLiveStations(current, during(0), quiet)[0]).toMatchObject({ tier: 3, color: null });
  });

  it('shows each station once at its latest decode and skips current QSO partners', () => {
    const current = view(
      slot(0, [decode('JA1ABC', { snr: -20 }), decode('PARTNER')]),
      slot(1, [decode('JA1ABC', { snr: -4 })]),
    );
    const stations = buildLiveStations(current, during(1), settings, new Set(['PARTNER']));
    expect(stations.map(station => station.callsign)).toEqual(['JA1ABC']);
    expect(stations[0].decode.snr).toBe(-4);
  });

  it('marks positions taken from the DXCC entity as approximate', () => {
    const current = view(slot(0, [decode('BY1AA', { location: { lat: 36, lng: 102, precision: 'entity' } })]));
    expect(buildLiveStations(current, during(0), settings)[0].approximate).toBe(true);
  });
});

describe('getDistanceAndBearing', () => {
  it('gives the short-path distance and initial heading', () => {
    // Shanghai to Tokyo: about 1,770 km, heading east-north-east.
    const route = getDistanceAndBearing({ lat: 31.2, lng: 121.5 }, { lat: 35.7, lng: 139.7 });
    expect(route.distanceKm).toBeGreaterThan(1700);
    expect(route.distanceKm).toBeLessThan(1820);
    expect(route.bearingDeg).toBeGreaterThan(65);
    expect(route.bearingDeg).toBeLessThan(80);
    expect(getDistanceAndBearing({ lat: 0, lng: 0 }, { lat: 10, lng: 0 }).bearingDeg).toBeCloseTo(0);
  });
});
