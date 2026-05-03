import { describe, expect, it } from 'vitest';

import { convertQSOToADIF, parseADIFRecord } from '../adif-utils.js';

describe('adif-utils', () => {
  it('exports FT4, COMMENT/NOTES, MY_* fields, and QSO_DATE_OFF in standard ADIF shape', () => {
    const adif = convertQSOToADIF({
      id: 'ft4',
      callsign: 'BG2AA',
      frequency: 14074000,
      mode: 'FT4',
      submode: 'FT4',
      startTime: Date.parse('2026-01-01T23:59:55Z'),
      endTime: Date.parse('2026-01-02T00:00:10Z'),
      messageHistory: ['CQ TEST'],
      myCallsign: 'BG2XYZ',
      myGrid: 'PM00AA',
      myState: 'CA',
      myCounty: 'LA',
      myIota: 'AS-007',
      notes: 'Manual note',
    });

    expect(adif).toContain('<mode:4>MFSK');
    expect(adif).toContain('<submode:3>FT4');
    expect(adif).toContain('<qso_date_off:8>20260102');
    expect(adif).toContain('<my_state:2>CA');
    expect(adif).toContain('<my_cnty:2>LA');
    expect(adif).toContain('<my_iota:6>AS-007');
    expect(adif).toContain('<comment:7>CQ TEST');
    expect(adif).toContain('<notes:11>Manual note');
    expect(adif).not.toContain('<state:2>CA');
  });

  it('parses standard FT4, COMMENT/NOTES, and MY_* fields without treating contacted station fields as my location', () => {
    const record = parseADIFRecord(
      '<call:5>BG2AA<qso_date:8>20260101<time_on:6>235955<qso_date_off:8>20260102<time_off:6>000010<mode:4>MFSK<submode:3>FT4<freq:9>14.074000<comment:14>CQ TEST | RR73<state:2>TX<cnty:3>DAL<iota:6>EU-001<my_state:2>CA<my_cnty:2>LA<my_iota:6>AS-007<notes:11>Manual note<eor>',
      'adif'
    );

    expect(record).not.toBeNull();
    expect(record?.mode).toBe('FT4');
    expect(record?.submode).toBe('FT4');
    expect(record?.myState).toBe('CA');
    expect(record?.myCounty).toBe('LA');
    expect(record?.myIota).toBe('AS-007');
    expect(record?.comment).toBe('CQ TEST | RR73');
    expect(record?.messageHistory).toEqual(['CQ TEST', 'RR73']);
    expect(record?.notes).toBe('Manual note');
    expect(record?.endTime).toBe(Date.parse('2026-01-02T00:00:10Z'));
  });
});
