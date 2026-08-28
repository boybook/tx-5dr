import { describe, expect, it } from 'vitest';
import { calculateWWDigiGridDistance, calculateWWDigiQsoPoints, summarizeWWDigiScore } from './score.js';

function qso(overrides: Partial<{
  qsoId: string; callsign: string; sentGrid: string; receivedGrid?: string;
  band: string; startTime: number; status: 'included' | 'x-qso' | 'review';
}> = {}) {
  return {
    qsoId: 'qso-1',
    callsign: 'JA1AAA',
    sentGrid: 'NN00',
    receivedGrid: 'NN00',
    band: '20M',
    startTime: 1,
    status: 'included' as const,
    ...overrides,
  };
}

describe('WW Digi claimed score projection', () => {
  it('uses one point plus one point for every complete 3000 km', () => {
    expect(calculateWWDigiQsoPoints('NN00', 'NN00')).toBe(1);
    const distance = calculateWWDigiGridDistance('OL32', 'FN42')!;
    const distant = calculateWWDigiQsoPoints('OL32', 'FN42');
    expect(distant).toBe(1 + Math.floor(distance / 3_000));
    expect(calculateWWDigiQsoPoints('NN00', 'ZZ00')).toBeNull();
  });

  it('scores callsigns and Grid Fields independently on each band', () => {
    const summary = summarizeWWDigiScore([
      qso(),
      qso({ qsoId: 'dupe', startTime: 2, receivedGrid: 'OO00' }),
      qso({ qsoId: 'same-field', callsign: 'K1BBB', startTime: 3, receivedGrid: 'NN01' }),
      qso({ qsoId: 'other-band', band: '40M', startTime: 4, receivedGrid: 'OO00' }),
      qso({ qsoId: 'excluded', callsign: 'VK1CCC', startTime: 5, status: 'x-qso', receivedGrid: 'PP00' }),
    ]);

    expect(summary.rows.map((row) => ({ id: row.record.qsoId, dupe: row.dupe, mult: row.newMultiplier })))
      .toEqual([
        { id: 'qso-1', dupe: false, mult: true },
        { id: 'dupe', dupe: true, mult: false },
        { id: 'same-field', dupe: false, mult: false },
        { id: 'other-band', dupe: false, mult: true },
        { id: 'excluded', dupe: false, mult: false },
      ]);
    expect(summary.bands.find((band) => band.band === '20M')).toMatchObject({ qsos: 2, gridFields: 1 });
    expect(summary.bands.find((band) => band.band === '40M')).toMatchObject({ qsos: 1, gridFields: 1 });
    expect(summary.claimedScore).toBe(summary.qsoPoints * 2);
  });

  it('limits the claimed score to the selected single band while keeping all band rows', () => {
    const summary = summarizeWWDigiScore([
      qso(),
      qso({ qsoId: '40m', band: '40M', callsign: 'K1BBB', receivedGrid: 'OO00' }),
    ], '20M');

    expect(summary.bands).toHaveLength(6);
    expect(summary.scoredQsos).toBe(1);
    expect(summary.gridFields).toBe(1);
    expect(summary.claimedScore).toBe(summary.qsoPoints);
  });
});
