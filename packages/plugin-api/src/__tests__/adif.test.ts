import { describe, expect, it } from 'vitest';

import { convertQSOToADIF, parseADIFRecord } from '../utils/adif.js';
import type { QSORecord } from '@tx5dr/contracts';

function createQso(overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id: 'voice-qso',
    callsign: 'N0CALL',
    frequency: 14_270_000,
    mode: 'SSB',
    submode: 'USB',
    startTime: Date.parse('2026-04-17T12:00:00.000Z'),
    endTime: Date.parse('2026-04-17T12:05:00.000Z'),
    reportSent: '59',
    reportReceived: '59',
    messageHistory: [],
    myCallsign: 'BG5DRB',
    myGrid: 'PM01AA',
    ...overrides,
  };
}

describe('ADIF QSO mode projection', () => {
  it('exports standard SSB ADIF with sideband submode', () => {
    const adif = convertQSOToADIF(createQso());

    expect(adif).toContain('<mode:3>SSB');
    expect(adif).toContain('<submode:3>USB');
  });

  it('normalizes legacy sideband modes while parsing ADIF', () => {
    const parsed = parseADIFRecord(
      '<CALL:6>N0CALL<QSO_DATE:8>20260417<TIME_ON:6>120000<MODE:3>USB<FREQ:9>14.270000<EOR>',
      'test',
    );

    expect(parsed?.mode).toBe('SSB');
    expect(parsed?.submode).toBe('USB');
  });
});
