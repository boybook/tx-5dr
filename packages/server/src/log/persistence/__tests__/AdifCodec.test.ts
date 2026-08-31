import { createHash } from 'node:crypto';

import type { QSORecord } from '@tx5dr/contracts';
import { describe, expect, it } from 'vitest';

import {
  decodeAdifRecord,
  encodeAdifRecord,
  getLastAdifFieldValue,
  scanAdifBuffer,
} from '../AdifCodec.js';

function field(name: string, value: string): string {
  return `<${name}:${Buffer.byteLength(value, 'utf8')}>${value}`;
}

function record(overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id: 'codec-record',
    callsign: 'BG5DRB',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-10T01:02:03Z'),
    messageHistory: [],
    ...overrides,
  };
}

describe('AdifCodec byte scanner', () => {
  it('preserves header, CRLF separators, case, unknown fields, and byte ranges', () => {
    const first = '<call:5>BG2AA<qso_date:8>20260810<time_on:6>010203<mode:3>FT8<freq:9>14.074000<app_other:3>YES<eOr>';
    const second = '<CALL:5>BG2BB<QSO_DATE:8>20260810<TIME_ON:6>010303<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const source = Buffer.from(`Logger header\r\n<ADIF_VER:5>3.1.4\r\n<eOh>\r\n\r\n${first}\r\n${second}\r\n`, 'utf8');

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(2);
    expect(source.subarray(0, scan.headerRange?.end).toString()).toContain('<eOh>');
    expect(source.subarray(scan.prefixRange.start, scan.prefixRange.end).toString()).toBe(
      'Logger header\r\n<ADIF_VER:5>3.1.4\r\n<eOh>\r\n\r\n',
    );
    expect(source.subarray(scan.records[0]!.range.start, scan.records[0]!.range.end).toString()).toBe(first);
    expect(source.subarray(
      scan.records[1]!.leadingRange.start,
      scan.records[1]!.leadingRange.end,
    ).toString()).toBe('\r\n');
    expect(getLastAdifFieldValue(scan.records[0]!, 'APP_OTHER')).toBe('YES');
    expect(scan.records.every((entry) => entry.syntacticallyValid)).toBe(true);
    expect(source.subarray(scan.safeTrailingRange.start, scan.safeTrailingRange.end).toString()).toBe('\r\n');
    expect(scan.incompleteTailRange).toBeUndefined();
    expect(scan.safeEnd).toBe(source.length);
  });

  it('accepts headerless ADIF and keeps arbitrary pre-record bytes as prefix', () => {
    const raw = '<CALL:5>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const source = Buffer.from(`Imported by another logger\n\n${raw}`, 'utf8');

    const scan = scanAdifBuffer(source);

    expect(scan.headerRange).toBeUndefined();
    expect(source.subarray(scan.prefixRange.start, scan.prefixRange.end).toString()).toBe('Imported by another logger\n\n');
    expect(scan.records).toHaveLength(1);
    expect(source.subarray(scan.records[0]!.range.start, scan.records[0]!.range.end).toString()).toBe(raw);
  });

  it('uses declared byte lengths and ignores EOR text inside a field value', () => {
    const comment = 'before<EOR>\u53f0\u5317after';
    const raw = [
      field('COMMENT', comment),
      '<CALL:5>BG2AA',
      '<QSO_DATE:8>20260810',
      '<TIME_ON:6>010203',
      '<MODE:3>FT8',
      '<FREQ:9>14.074000',
      '<EOR>',
    ].join('');
    const source = Buffer.from(raw, 'utf8');

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]!.range.end).toBe(source.length);
    expect(getLastAdifFieldValue(scan.records[0]!, 'comment')).toBe(comment);
    expect(scan.records[0]!.fields[0]!.valueRange.end - scan.records[0]!.fields[0]!.valueRange.start)
      .toBe(Buffer.byteLength(comment));
  });

  it('does not mistake EOH text inside a length-delimited header value for the marker', () => {
    const headerComment = 'contains <EOH> text';
    const raw = '<CALL:5>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const source = Buffer.from(`${field('COMMENT', headerComment)}<ADIF_VER:5>3.1.4<EOH>\n${raw}`);

    const scan = scanAdifBuffer(source);

    expect(source.subarray(0, scan.headerRange?.end).toString()).toBe(
      `${field('COMMENT', headerComment)}<ADIF_VER:5>3.1.4<EOH>`,
    );
    expect(scan.records).toHaveLength(1);
  });

  it('keeps duplicate complete records as distinct scan entries', () => {
    const raw = '<CALL:5>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const source = Buffer.from(`${raw}\n${raw}`);
    const expectedHash = createHash('sha256').update(raw).digest('hex');

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(2);
    expect(scan.records.map((entry) => entry.rawHash)).toEqual([expectedHash, expectedHash]);
    expect(scan.records[0]!.range).not.toEqual(scan.records[1]!.range);
  });

  it('retains malformed complete frames as syntactically opaque records', () => {
    const source = Buffer.from(
      '<CALL:nope>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>',
    );

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]!.syntacticallyValid).toBe(false);
    expect(scan.records[0]!.issues.map((issue) => issue.code)).toContain('invalid-field-length');
    expect(decodeAdifRecord(scan.records[0]!)).toBeUndefined();
    expect(source.subarray(scan.records[0]!.range.start, scan.records[0]!.range.end)).toEqual(source);
  });

  it('keeps invalid UTF-8 contest envelopes opaque instead of rewriting damaged bytes', () => {
    const source = Buffer.concat([
      Buffer.from('<CALL:5>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<APP_TX5DR_CONTEST_ENTRY:2>'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<EOR>'),
    ]);

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.syntacticallyValid).toBe(false);
    expect(scan.records[0]?.issues.map((issue) => issue.code)).toContain('invalid-field-encoding');
    expect(decodeAdifRecord(scan.records[0]!)).toBeUndefined();
  });

  it('separates safe trailing whitespace from an incomplete final record', () => {
    const complete = '<CALL:5>BG2AA<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const source = Buffer.from(`${complete}\r\n\t<CALL:5>PART`);

    const scan = scanAdifBuffer(source);

    expect(scan.records).toHaveLength(1);
    expect(source.subarray(scan.safeTrailingRange.start, scan.safeTrailingRange.end).toString()).toBe('\r\n\t');
    expect(scan.safeEnd).toBe(Buffer.byteLength(`${complete}\r\n\t`));
    expect(source.subarray(scan.incompleteTailRange!.start, scan.incompleteTailRange!.end).toString()).toBe('<CALL:5>PART');

    const whitespaceOnly = scanAdifBuffer(Buffer.from(`${complete}\r\n\t`));
    expect(whitespaceOnly.safeEnd).toBe(Buffer.byteLength(`${complete}\r\n\t`));
    expect(whitespaceOnly.incompleteTailRange).toBeUndefined();
  });
});

describe('AdifCodec QSO mapping', () => {
  it('encodes UTF-8 field lengths as bytes and always terminates with EOR plus LF', () => {
    const utf8Qth = '\u53f0\u5317';
    const utf8Notes = '\u6d4b\u8bd5';
    const encoded = encodeAdifRecord(record({
      qth: utf8Qth,
      notes: utf8Notes,
      myCallsign: 'BG5DRB',
      myGrid: 'PL05AA',
    }));
    const text = encoded.toString('utf8');

    expect(text).toContain(`<QTH:6>${utf8Qth}`);
    expect(text).toContain(`<NOTES:6>${utf8Notes}`);
    expect(text.endsWith('<EOR>\n')).toBe(true);

    const scan = scanAdifBuffer(encoded);
    expect(scan.records).toHaveLength(1);
    expect(scan.incompleteTailRange).toBeUndefined();
    expect(scan.safeTrailingRange.end - scan.safeTrailingRange.start).toBe(1);
  });

  it('round-trips the persisted TX-5DR QSO field set without a second parser', () => {
    const source = record({
      id: 'round-trip',
      mode: 'FT4',
      submode: 'FT4',
      endTime: Date.parse('2026-08-10T01:03:04Z'),
      reportSent: '-12',
      reportReceived: '-09',
      messageHistory: ['BG5DRB N0CALL -12'],
      comment: 'TU',
      contestId: 'WW-DIGI',
      contestEntry: {
        schemaVersion: 1,
        contestId: 'WW-DIGI',
        editionId: '2026',
        rulesetVersion: '2026.1',
        sent: { grid: 'PL05', note: '\u53f0\u5317<portable>' },
        received: { grid: 'PL05', snr: '-09' },
        annotations: { status: 'included', transmitter: 1, reviewed: false },
      },
      grid: 'PL05AA',
      myGrid: 'PL04AA',
      myCallsign: 'BG5DRB',
      qth: 'Taipei',
      notes: 'Portable',
      dxccId: 291,
      dxccEntity: 'United States',
      cqZone: 4,
      ituZone: 7,
      dxccStatus: 'current',
      dxccSource: 'adif',
      dxccConfidence: 'manual',
      dxccNeedsReview: false,
      stationLocationId: 'home',
      myDxccId: 386,
      myCqZone: 24,
      myItuZone: 44,
      myState: 'TW',
      myCounty: 'TPE',
      myIota: 'AS-020',
      lotwQslSent: 'Y',
      lotwQslReceived: 'V',
      lotwQslSentDate: Date.parse('2026-08-11T00:00:00Z'),
      lotwQslReceivedDate: Date.parse('2026-08-12T00:00:00Z'),
      qrzQslSent: 'Y',
      qrzQslReceived: 'Y',
      qrzQslSentDate: Date.parse('2026-08-13T00:00:00Z'),
      qrzQslReceivedDate: Date.parse('2026-08-14T00:00:00Z'),
    });

    const scan = scanAdifBuffer(encodeAdifRecord(source));
    const decoded = decodeAdifRecord(scan.records[0]!);

    expect(decoded).toMatchObject({
      id: source.id,
      callsign: source.callsign,
      mode: 'FT4',
      submode: 'FT4',
      startTime: source.startTime,
      endTime: source.endTime,
      qth: source.qth,
      notes: source.notes,
      contestId: source.contestId,
      contestEntry: source.contestEntry,
      dxccId: source.dxccId,
      dxccEntity: source.dxccEntity,
      dxccStatus: source.dxccStatus,
      stationLocationId: source.stationLocationId,
      myState: source.myState,
      lotwQslReceived: source.lotwQslReceived,
      qrzQslReceived: source.qrzQslReceived,
    });
    expect(decoded?.messageHistory).toEqual(source.messageHistory);
    expect(decoded?.comment).toContain('TU');
  });
});
