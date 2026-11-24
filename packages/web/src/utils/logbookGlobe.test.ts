import { describe, expect, it } from 'vitest';
import type { OperatorStatus, QSORecord } from '@tx5dr/contracts';
import { buildInProgressQSOGlobeModel, buildPagedQSOGlobeModel } from './logbookGlobe';

const qso = { id: '1', callsign: 'JA1ABC', grid: 'PM95', myGrid: 'PM01', frequency: 14_074_000, mode: 'FT8', startTime: 1_700_000_000_000 } as unknown as QSORecord;
// A precise QTH that is not the centre of the QSOs' own grid square.
const stationInfo = { qth: { latitude: 21.4, longitude: 110.3, grid: 'OL61' } } as never;
const calling = {
  id: 'op-1',
  currentSlot: 'TX2',
  context: { targetCall: 'VK2JEH', targetGrid: 'QF56', myGrid: 'OM89' },
} as unknown as OperatorStatus;

describe('QSOs in progress on the logbook globe', () => {
  // Regression: arcs in progress left from the station info's QTH while the
  // home marker (and every history arc) stood on the QSOs' grid.
  it('leaves from the home point the globe shows', () => {
    const model = buildPagedQSOGlobeModel([qso], stationInfo);
    const home = model.homePoint!;
    const [arc] = buildInProgressQSOGlobeModel([calling], stationInfo, home).arcs;
    expect(arc).toMatchObject({ startLat: home.lat, startLng: home.lng });
    expect(model.arcs[0]).toMatchObject({ startLat: home.lat, startLng: home.lng });
  });

  it('falls back to the station info without a home point', () => {
    const [arc] = buildInProgressQSOGlobeModel([calling], stationInfo).arcs;
    expect(arc).toMatchObject({ startLat: 21.4, startLng: 110.3 });
  });
});
