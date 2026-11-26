import { describe, expect, it } from 'vitest';
import type { OperatorStatus, QSORecord } from '@tx5dr/contracts';
import { buildInProgressQSOGlobeModel, buildPagedQSOGlobeModel, keepDatumObjects, type GlobeArc } from './logbookGlobe';

const keepArcObjects = (previous: ReadonlyMap<string, GlobeArc>, next: GlobeArc[]) => {
  const kept = keepDatumObjects(previous, next, ['color']);
  return { arcs: kept.items, byKey: kept.byKey };
};

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

describe('arc objects across model rebuilds', () => {
  // Regression: every logbook reload rebuilt the model with new arc objects,
  // and globe.gl dropped and rebuilt every tube, so all the arcs blinked.
  it('keeps the object of an arc that still describes the same QSO', () => {
    const first = keepArcObjects(new Map(), buildPagedQSOGlobeModel([qso], stationInfo).arcs);
    const rebuilt = buildPagedQSOGlobeModel([{ ...qso }], stationInfo).arcs;
    expect(rebuilt[0]).not.toBe(first.arcs[0]);
    const second = keepArcObjects(first.byKey, rebuilt);
    expect(second.arcs[0]).toBe(first.arcs[0]);
  });

  it('carries a new colour onto the kept object', () => {
    const [arc] = buildPagedQSOGlobeModel([qso], stationInfo).arcs;
    const first = keepArcObjects(new Map(), [arc]);
    const faded = { ...arc, color: 'rgba(59, 130, 246, 0.2)' };
    const second = keepArcObjects(first.byKey, [faded]);
    expect(second.arcs[0]).toBe(arc);
    expect(arc.color).toBe('rgba(59, 130, 246, 0.2)');
  });

  it('gives a changed QSO its own object and keeps equal ones apart', () => {
    const [arc] = buildPagedQSOGlobeModel([qso], stationInfo).arcs;
    const twin = { ...arc };
    const first = keepArcObjects(new Map(), [arc, twin]);
    const changed = { ...arc, mode: 'FT4' };
    const second = keepArcObjects(first.byKey, [{ ...arc }, changed, { ...arc }]);
    expect(second.arcs[0]).toBe(arc);
    expect(second.arcs[1]).toBe(changed);
    expect(second.arcs[2]).toBe(twin);
  });

  // Regression: a new ring object starts an extra pulse at once, so the rings
  // on reception targets, QSO targets and home flashed on every refresh.
  it('keeps ring objects across rebuilds', () => {
    const ring = () => ({ id: 'target:JA1ABC', lat: 35, lng: 139, color: ['a', 'b'], maxRadius: 2.4, propagationSpeed: 1.3, repeatPeriod: 2400 });
    const first = keepDatumObjects(new Map(), [ring()]);
    const second = keepDatumObjects(first.byKey, [ring(), { ...ring(), id: 'ping:JA1ABC:2' }]);
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).not.toBe(first.items[0]);
  });
});

describe('red arcs', () => {
  // Users found the red arcs of QSOs in progress too heavy next to the history.
  it('stay close to the width of the history arcs', () => {
    const history = buildPagedQSOGlobeModel([qso], stationInfo).arcs[0];
    const [inProgress] = buildInProgressQSOGlobeModel([calling], stationInfo).arcs;
    expect(inProgress.stroke).toBeLessThanOrEqual(history.stroke * 1.6);
  });

  // Regression: each operator update stamped the arc with a new start time and
  // strategy state, so the arc was rebuilt and its dashes restarted.
  it('keep their object while the QSO goes on', () => {
    const first = keepArcObjects(new Map(), buildInProgressQSOGlobeModel([calling], stationInfo).arcs);
    const later = { ...calling, currentSlot: 'TX3', strategy: { name: 'x', state: 'TX3', availableSlots: [] } } as unknown as OperatorStatus;
    const second = keepArcObjects(first.byKey, buildInProgressQSOGlobeModel([later], stationInfo).arcs);
    expect(second.arcs[0]).toBe(first.arcs[0]);
  });
});
