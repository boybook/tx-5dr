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

  it('round-trips the contest identifier used for WW Digi recovery', () => {
    const adif = convertQSOToADIF(createQso({
      mode: 'FT8',
      submode: undefined,
      contestId: 'WW-DIGI',
    }));

    expect(adif).toContain('<contest_id:7>WW-DIGI');
    expect(parseADIFRecord(adif, 'test')?.contestId).toBe('WW-DIGI');
  });

  it('round-trips the atomic contest envelope with Unicode exchange data', () => {
    const contestEntry = {
      schemaVersion: 1 as const,
      contestId: 'FT-CHALLENGE',
      editionId: '2026-weekend-1',
      rulesetVersion: '2026.1',
      sent: { grid: 'PL05', operatorNote: '台北<portable>' },
      received: { grid: 'PM96', snr: '-12' },
      annotations: { status: 'included', transmitter: 1, reviewed: false },
    };
    const adif = convertQSOToADIF(createQso({
      contestId: contestEntry.contestId,
      contestEntry,
    }));

    expect(adif).toContain('<contest_id:12>FT-CHALLENGE');
    expect(adif).toMatch(/<app_tx5dr_contest_entry:\d+>\{"schemaVersion":1/);
    expect(parseADIFRecord(adif, 'test')).toMatchObject({
      contestId: contestEntry.contestId,
      contestEntry,
    });
  });

  it('parses external Unicode contest envelopes using ADIF byte lengths', () => {
    const contestEntry = {
      schemaVersion: 1 as const,
      contestId: 'FT-CHALLENGE',
      editionId: '2026-weekend-1',
      rulesetVersion: '2026.1',
      sent: { grid: 'PL05', operatorNote: '台北' },
      received: { grid: 'PM96', snr: '-12' },
    };
    const rawEnvelope = JSON.stringify(contestEntry);
    const adif = '<CALL:6>N0CALL<QSO_DATE:8>20260417<TIME_ON:6>120000<MODE:3>FT8<FREQ:9>14.074000'
      + '<CONTEST_ID:12>FT-CHALLENGE'
      + `<APP_TX5DR_CONTEST_ENTRY:${Buffer.byteLength(rawEnvelope)}>${rawEnvelope}<EOR>`;

    expect(parseADIFRecord(adif, 'test')).toMatchObject({ contestEntry });
  });

  it('round-trips Unicode QTH and notes with UTF-8 byte lengths', () => {
    const adif = convertQSOToADIF(createQso({ qth: '台北', notes: '測試' }));

    expect(adif).toContain('<qth:6>台北');
    expect(adif).toContain('<notes:6>測試');
    expect(parseADIFRecord(adif, 'test')).toMatchObject({ qth: '台北', notes: '測試' });
  });

  it('does not attach a private contest envelope that conflicts with CONTEST_ID', () => {
    const encoded = convertQSOToADIF(createQso({
      contestId: 'FT-CHALLENGE',
      contestEntry: {
        schemaVersion: 1,
        contestId: 'FT-CHALLENGE',
        editionId: '2026-weekend-1',
        rulesetVersion: '2026.1',
        sent: {},
        received: {},
      },
    })).replace('FT-CHALLENGE', 'WW-DIGI     ');

    const parsed = parseADIFRecord(encoded, 'test');
    expect(parsed?.contestId).toBe('WW-DIGI     ');
    expect(parsed?.contestEntry).toBeUndefined();
  });
});

describe('ADIF QSO comments', () => {
  it('exports WSJT-X compatible signal reports in COMMENT', () => {
    const adif = convertQSOToADIF(createQso({
      mode: 'FT8',
      submode: undefined,
      reportSent: '-12',
      reportReceived: '-09',
    }));

    expect(adif).toMatch(/<comment:\d+>FT8 {2}Sent: -12 {2}Rcvd: -09/);
  });

  it('keeps operator comments after the signal report COMMENT prefix', () => {
    const adif = convertQSOToADIF(createQso({
      mode: 'FT8',
      submode: undefined,
      reportSent: '-12',
      reportReceived: '-09',
      comment: 'TU',
    }));

    expect(adif).toMatch(/<comment:\d+>FT8 {2}Sent: -12 {2}Rcvd: -09 \| TU/);
  });

  it('stores message history in a TX-5DR private field instead of COMMENT', () => {
    const adif = convertQSOToADIF(createQso({
      mode: 'FT8',
      submode: undefined,
      reportSent: undefined,
      reportReceived: undefined,
      messageHistory: ['CQ TEST', 'RR73'],
    }));

    expect(adif).toMatch(/<app_tx5dr_message_history:\d+>CQ TEST \| RR73/);
    expect(adif).not.toMatch(/<comment:\d+>CQ TEST/);
  });

  it('parses private message history and legacy COMMENT history', () => {
    const parsedPrivate = parseADIFRecord(
      '<call:6>N0CALL<qso_date:8>20260417<time_on:6>120000<mode:3>FT8<freq:9>14.074000<comment:25>FT8  Sent: -12  Rcvd: -09<app_tx5dr_message_history:14>CQ TEST | RR73<eor>',
      'test',
    );
    const parsedLegacy = parseADIFRecord(
      '<call:6>N0CALL<qso_date:8>20260417<time_on:6>120000<mode:3>FT8<freq:9>14.074000<comment:14>CQ TEST | RR73<eor>',
      'test',
    );

    expect(parsedPrivate?.comment).toBe('FT8  Sent: -12  Rcvd: -09');
    expect(parsedPrivate?.messageHistory).toEqual(['CQ TEST', 'RR73']);
    expect(parsedLegacy?.comment).toBe('CQ TEST | RR73');
    expect(parsedLegacy?.messageHistory).toEqual(['CQ TEST', 'RR73']);
  });
});
