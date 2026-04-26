import { describe, expect, it } from 'vitest';
import { resolveSelectedStationId } from './stationSelection';

describe('resolveSelectedStationId', () => {
  const stations = [
    { station_id: 'station-1' },
    { station_id: 'station-2' },
  ];

  it('keeps the preferred station when it is still available', () => {
    expect(resolveSelectedStationId(stations, 'station-2')).toBe('station-2');
  });

  it('selects the first station when no preferred station is set', () => {
    expect(resolveSelectedStationId(stations, '')).toBe('station-1');
  });

  it('selects the first station when the preferred station is unavailable', () => {
    expect(resolveSelectedStationId(stations, 'missing-station')).toBe('station-1');
  });

  it('returns an empty selection when no stations are available', () => {
    expect(resolveSelectedStationId([], 'station-1')).toBe('');
  });
});
