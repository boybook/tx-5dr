// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PSKReporterReceptionSpot, PSKReporterReceptionUpdate } from '@tx5dr/contracts';

import {
  RECEPTION_FULL_BRIGHTNESS_MS,
  applyReceptionUpdate,
  buildReceptionGlobeModel,
  escapeGlobeLabelText,
  getReceptionFreshness,
  type ReceptionStation,
} from './receptionGlobe';
import { useReceptionPings } from '../components/logbook/useReceptionPings';

const NOW = Date.UTC(2026, 10, 24, 8, 30, 0);
const WINDOW_MS = 30 * 60 * 1000;
const HOME = { lat: 30.9, lng: 121.6 };

function spot(receiver: string, locator: string, minutesAgo: number, overrides: Partial<PSKReporterReceptionSpot> = {}): PSKReporterReceptionSpot {
  const transmittedAt = NOW - minutesAgo * 60_000;
  return {
    id: `BG5DRB|${receiver}|${transmittedAt}`,
    senderCallsign: 'BG5DRB',
    receiverCallsign: receiver,
    receiverLocator: locator,
    mode: 'FT8',
    snr: -15,
    transmittedAt,
    reportedAt: transmittedAt + 90_000,
    source: 'live',
    ...overrides,
  };
}

function update(kind: PSKReporterReceptionUpdate['kind'], spots: PSKReporterReceptionSpot[], callsigns = ['BG5DRB']): PSKReporterReceptionUpdate {
  return { kind, state: 'live', callsigns, windowMs: WINDOW_MS, spots };
}

describe('reception view updates', () => {
  it('replaces on snapshot, merges appends and drops reports outside the window', () => {
    const first = applyReceptionUpdate(null, update('snapshot', [spot('VK2JEH', 'QF57', 3), spot('OLD', 'JO31', 40)]), NOW);
    expect(first.spots.map(item => item.receiverCallsign)).toEqual(['VK2JEH']);

    const appended = applyReceptionUpdate(first, update('append', [spot('VK2JEH', 'QF57', 3), spot('DL9AJ', 'JO52', 1)]), NOW);
    expect(appended.spots.map(item => item.receiverCallsign)).toEqual(['VK2JEH', 'DL9AJ']);

    const replaced = applyReceptionUpdate(appended, update('snapshot', []), NOW);
    expect(replaced.spots).toEqual([]);
  });

  it('does not merge an append into the view of other callsigns', () => {
    const first = applyReceptionUpdate(null, update('snapshot', [spot('VK2JEH', 'QF57', 3)]), NOW);
    const other = applyReceptionUpdate(first, update('append', [spot('DL9AJ', 'JO52', 1)], ['BA1ZZZ']), NOW);
    expect(other.spots.map(item => item.receiverCallsign)).toEqual(['DL9AJ']);
  });
});

describe('reception globe model', () => {
  it('keeps full brightness while reports are still arriving, then fades out', () => {
    expect(getReceptionFreshness(0, WINDOW_MS)).toBe(1);
    expect(getReceptionFreshness(RECEPTION_FULL_BRIGHTNESS_MS, WINDOW_MS)).toBe(1);
    expect(getReceptionFreshness((RECEPTION_FULL_BRIGHTNESS_MS + WINDOW_MS) / 2, WINDOW_MS)).toBeCloseTo(0.5);
    expect(getReceptionFreshness(WINDOW_MS, WINDOW_MS)).toBe(0);
  });

  it('shows each receiver once at its latest report and finds the farthest', () => {
    const view = applyReceptionUpdate(null, update('snapshot', [
      spot('VK2JEH', 'QF57', 20, { snr: -22 }),
      spot('VK2JEH', 'QF57', 2, { snr: -5 }),
      spot('DL9AJ', 'JO52', 4),
      spot('NOGRID', 'ZZ99', 1),
    ]), NOW);
    const model = buildReceptionGlobeModel(view, HOME, NOW);

    expect(model.stations.map(station => station.callsign).sort()).toEqual(['DL9AJ', 'VK2JEH']);
    const distances = model.stations.map(station => station.distanceKm ?? 0);
    expect(distances).toEqual([...distances].sort((left, right) => left - right));
    const vk = model.stations.find(station => station.callsign === 'VK2JEH');
    expect(vk).toMatchObject({ snr: -5, reportCount: 2, freshness: 1 });
    expect(model.farthest?.callsign).toBe(model.stations.at(-1)?.callsign);
    expect(model.points.every(point => point.kind === 'reception')).toBe(true);
  });

  it('marks a current QSO target that recently heard this station', () => {
    const view = applyReceptionUpdate(null, update('snapshot', [spot('JA1ABC', 'PM95', 2), spot('W1AW', 'FN31', 12)]), NOW);
    const model = buildReceptionGlobeModel(view, HOME, NOW, new Set(['JA1ABC', 'W1AW']));
    expect(model.targetRings.map(ring => ring.id)).toEqual(['target:JA1ABC']);
  });

  it('renders nothing while disabled', () => {
    const view = { ...applyReceptionUpdate(null, update('snapshot', [spot('JA1ABC', 'PM95', 2)]), NOW), state: 'disabled' as const };
    expect(buildReceptionGlobeModel(view, HOME, NOW).points).toEqual([]);
  });

  it('escapes externally supplied label text', () => {
    expect(escapeGlobeLabelText('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });
});

describe('reception pings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function station(callsign: string, source: ReceptionStation['source'] = 'live'): ReceptionStation {
    return {
      callsign,
      locator: 'PM95',
      lat: 35,
      lng: 139,
      mode: 'FT8',
      transmittedAt: NOW,
      reportedAt: NOW,
      source,
      reportCount: 1,
      freshness: 1,
    };
  }

  it('rings only for receivers that newly heard live after the snapshot', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ stations, ready }) => useReceptionPings(stations, 'BG5DRB', ready, true),
      { initialProps: { stations: [station('OLD')], ready: false } },
    );
    rerender({ stations: [station('OLD')], ready: true });
    rerender({ stations: [station('OLD'), station('HIST', 'history'), station('NEW1'), station('NEW2')], ready: true });
    expect(result.current).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.map(ring => ring.id)).toEqual(['ping:NEW1:1']);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(result.current.map(ring => ring.id)).toEqual(['ping:NEW1:1', 'ping:NEW2:2']);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toEqual([]);
  });
});
