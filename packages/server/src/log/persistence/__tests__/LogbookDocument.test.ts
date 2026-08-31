import { createHash } from 'node:crypto';

import type { QSORecord } from '@tx5dr/contracts';
import { describe, expect, it } from 'vitest';

import { encodeAdifRecord, getLastAdifFieldValue, scanAdifBuffer } from '../AdifCodec.js';
import {
  BufferLogbookSourceAdapter,
  LogbookDocument,
  type LogbookRewritePart,
} from '../LogbookDocument.js';

function rawRecord(callsign: string, time: string, frequency = '14.074000', extra = ''): string {
  return `<call:${Buffer.byteLength(callsign)}>${callsign}<qso_date:8>20260810<time_on:6>${time}<mode:3>FT8<freq:${Buffer.byteLength(frequency)}>${frequency}${extra}<eor>`;
}

function qso(overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id: 'new-qso',
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-10T02:00:00Z'),
    messageHistory: [],
    ...overrides,
  };
}

function materializeParts(parts: readonly LogbookRewritePart[], source: Buffer): Buffer {
  return Buffer.concat(parts.map((part) => part.kind === 'bytes'
    ? part.bytes
    : source.subarray(part.range.start, part.range.end)));
}

describe('LogbookDocument loading and indexes', () => {
  it('builds from worker scan DTOs without retaining or materializing the source file', () => {
    const first = rawRecord('BG2AA', '010203');
    const second = rawRecord('BG2BB', '010303');
    const source = Buffer.from(`<ADIF_VER:5>3.1.4<EOH>\r\n${first}\r\n${second}\r\n`);
    const document = LogbookDocument.fromScan(scanAdifBuffer(source));

    expect(document.isSourceBacked()).toBe(true);
    expect(document.getContentParts().every((part) => part.kind === 'source')).toBe(true);
    expect(document.getSegments().every((segment) => segment.rawSourceRange !== undefined)).toBe(true);
    expect(document.getQsoRecords().map((record) => record.callsign)).toEqual(['BG2AA', 'BG2BB']);
    expect(() => document.toBuffer()).toThrow(/source-backed/);
    expect(document.toBuffer({}, new BufferLogbookSourceAdapter(source))).toEqual(source);
  });

  it('preserves physical order and gives identical external records distinct deterministic IDs', () => {
    const raw = rawRecord('BG2AA', '010203');
    const source = Buffer.from(`Header\r\n<ADIF_VER:5>3.1.4<EOH>\r\n${raw}\r\n${raw}\r\n`);
    const hash = createHash('sha256').update(raw).digest('hex');

    const document = LogbookDocument.fromBuffer(source);
    const segments = document.getSegments();
    const records = document.getQsoRecords();

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.segmentId)).toEqual([
      `qso:external:${hash}:1`,
      `qso:external:${hash}:2`,
    ]);
    expect(records.map((record) => record.id)).toEqual([
      `external:${hash}:1`,
      `external:${hash}:2`,
    ]);
    expect(records).toHaveLength(2);
    expect(source.subarray(segments[0]!.rawRange.start, segments[0]!.rawRange.end).toString()).toBe(raw);
    expect(source.subarray(segments[1]!.rawRange.start, segments[1]!.rawRange.end).toString()).toBe(raw);
    expect(document.toBuffer()).toEqual(source);
  });

  it('reprojects identical external record IDs after deleting or editing the first duplicate', () => {
    const raw = rawRecord('BG2AA', '010203');
    const source = Buffer.from(`${raw}\n${raw}\n`);
    const document = LogbookDocument.fromBuffer(source);
    const [first, second] = document.getQsoRecords();

    const deleted = document.prepareDelete(first!.id).nextDocument;
    const reloadedDelete = LogbookDocument.fromBuffer(deleted.toBuffer());
    expect(deleted.getQsoRecords().map(record => record.id))
      .toEqual(reloadedDelete.getQsoRecords().map(record => record.id));
    expect(deleted.getQsoRecords()).toHaveLength(1);
    expect(deleted.getQsoRecords()[0]!.id).not.toBe(second!.id);

    const updated = document.prepareUpdate(first!.id, { notes: 'edited' }).nextDocument;
    const reloadedUpdate = LogbookDocument.fromBuffer(updated.toBuffer());
    expect(updated.getQsoRecords().map(record => record.id))
      .toEqual(reloadedUpdate.getQsoRecords().map(record => record.id));
    expect(updated.getQso(first!.id)?.notes).toBe('edited');
    expect(updated.getQsoRecords()).toHaveLength(2);
  });

  it('retains opaque records alongside parsed records without polluting query indexes', () => {
    const opaque = '<CALL:nope>BAD<QSO_DATE:8>20260810<TIME_ON:6>010203<EOR>';
    const valid = rawRecord('BG2OK', '010303', '7.074000', '<APP_UNKNOWN:3>YES');
    const document = LogbookDocument.fromBuffer(Buffer.from(`${opaque}\n${valid}`));

    expect(document.getSegments()).toHaveLength(2);
    expect(document.getOpaqueSegments()).toHaveLength(1);
    expect(document.getQsoRecords()).toHaveLength(1);
    expect(document.findByCallsign('bg2ok')).toHaveLength(1);
    expect(document.hasWorkedCallsign('BG2OK', '40m')).toBe(true);
    expect(document.hasWorkedCallsign('BG2OK', '20m')).toBe(false);
  });

  it('indexes every duplicate and finds the latest QSO independently of physical order', () => {
    const latest = rawRecord('BG2AA', '020000');
    const earliest = rawRecord('BG2AA', '010000');
    const document = LogbookDocument.fromBuffer(Buffer.from(`${latest}\n${earliest}`));

    expect(document.findByCallsign('BG2AA')).toHaveLength(2);
    expect(document.getLastQsoWithCallsign('bg2aa')?.startTime).toBe(Date.parse('2026-08-10T02:00:00Z'));
  });

  it('never overwrites duplicate explicit TX-5DR IDs', () => {
    const encoded = encodeAdifRecord(qso({ id: 'same-explicit-id' }));
    const document = LogbookDocument.fromBuffer(Buffer.concat([encoded, encoded]));
    const records = document.getQsoRecords();

    expect(records).toHaveLength(2);
    expect(records[0]!.id).toBe('same-explicit-id');
    expect(records[1]!.id).toMatch(/^duplicate:[a-f0-9]{64}:2$/);
    expect(document.getQso('same-explicit-id')).toBe(records[0]);
    expect(document.getQso(records[1]!.id)).toBe(records[1]);
  });

  it('owns its input bytes instead of exposing mutable caller buffers', () => {
    const source = Buffer.from(rawRecord('BG2AA', '010203'));
    const expected = Buffer.from(source);
    const document = LogbookDocument.fromBuffer(source);

    source.fill(0x78);
    const rendered = document.toBuffer();
    expect(rendered).toEqual(expected);

    rendered.fill(0x79);
    expect(document.toBuffer()).toEqual(expected);
  });
});

describe('LogbookDocument prepared mutations', () => {
  it('preserves an undecodable future contest envelope across unrelated updates', () => {
    const futureEnvelope = JSON.stringify({
      schemaVersion: 2,
      contestId: 'FUTURE-TEST',
      editionId: '2027',
      rulesetVersion: '2027.1',
      sent: { grid: 'PL04' },
      received: { grid: 'FN31' },
    });
    const privateField = `<APP_TX5DR_CONTEST_ENTRY:${Buffer.byteLength(futureEnvelope)}>${futureEnvelope}`;
    const source = Buffer.from(rawRecord(
      'BG2AA',
      '010203',
      '14.074000',
      `<CONTEST_ID:11>FUTURE-TEST${privateField}`,
    ));
    const document = LogbookDocument.fromScan(scanAdifBuffer(source));
    const target = document.getQsoRecords()[0]!;
    expect(target.contestEntry).toBeUndefined();

    const mutation = document.prepareUpdate(target.id, { notes: 'reviewed' });
    const candidate = materializeParts(mutation.rewriteParts, source);
    const record = scanAdifBuffer(candidate).records[0]!;

    expect(getLastAdifFieldValue(record, 'app_tx5dr_contest_entry')).toBe(futureEnvelope);
    expect(getLastAdifFieldValue(record, 'notes')).toBe('reviewed');

    const canonical = {
      schemaVersion: 1 as const,
      contestId: 'FUTURE-TEST',
      editionId: '2027',
      rulesetVersion: '2027.2',
      sent: { grid: 'PL04' },
      received: { grid: 'FN31' },
    };
    const replaced = document.prepareUpdate(target.id, { contestEntry: canonical });
    const replacedRecord = scanAdifBuffer(materializeParts(replaced.rewriteParts, source)).records[0]!;
    expect(replacedRecord.fields.filter((field) => field.name === 'app_tx5dr_contest_entry')).toHaveLength(1);
    expect(JSON.parse(getLastAdifFieldValue(replacedRecord, 'app_tx5dr_contest_entry')!))
      .toEqual(canonical);
  });

  it('exposes a range-backed rewrite plan and inlines only the changed record', () => {
    const first = rawRecord('BG2AA', '010203', '14.074000', '<APP_OTHER:3>ONE');
    const middle = rawRecord('BG2BB', '010303', '14.075000', '<APP_OTHER:3>TWO');
    const last = rawRecord('BG2CC', '010403', '7.074000', '<APP_OTHER:5>THREE');
    const source = Buffer.from(`<ADIF_VER:5>3.1.4<EOH>\n${first}\n${middle}\n${last}\n`);
    const document = LogbookDocument.fromScan(scanAdifBuffer(source));
    const target = document.getQsoRecords()[1]!;

    const mutation = document.prepareUpdate(target.id, { notes: 'range rewrite' });
    const [firstSegment, changedSegment, lastSegment] = mutation.nextDocument.getSegments();

    expect(mutation.rewriteParts.some((part) => part.kind === 'bytes')).toBe(true);
    expect(mutation.rewriteParts.some((part) => part.kind === 'source')).toBe(true);
    expect(firstSegment!.rawSourceRange).toEqual(document.getSegments()[0]!.rawRange);
    expect(changedSegment!.rawSourceRange).toBeUndefined();
    expect(lastSegment!.rawSourceRange).toEqual(document.getSegments()[2]!.rawRange);
    expect(firstSegment!.rawRange.end).toBeLessThan(changedSegment!.rawRange.start);
    expect(changedSegment!.rawRange.end).toBeLessThan(lastSegment!.rawRange.start);

    const candidate = materializeParts(mutation.rewriteParts, source).toString();
    expect(candidate).toContain(first);
    expect(candidate).toContain('<NOTES:13>range rewrite');
    expect(candidate).toContain(last);
    expect(candidate.indexOf(first)).toBeLessThan(candidate.indexOf('<CALL:5>BG2BB'));
    expect(candidate.indexOf('<CALL:5>BG2BB')).toBeLessThan(candidate.indexOf(last));
  });

  it('keeps exact append bytes while retaining old content as source ranges', () => {
    const source = Buffer.from(`${rawRecord('BG2AA', '010203')}\r\n`);
    const document = LogbookDocument.fromScan(scanAdifBuffer(source));
    const added = qso({ id: 'source-backed-append' });

    const mutation = document.prepareAppend(added);
    const parts = mutation.nextDocument.getContentParts();

    expect(mutation.appendBytes).toEqual(encodeAdifRecord(added));
    expect(parts.some((part) => part.kind === 'source')).toBe(true);
    expect(parts.some((part) => part.kind === 'bytes')).toBe(true);
    expect(materializeParts(parts, source)).toEqual(Buffer.concat([source, mutation.appendBytes]));
  });

  it('prepares a physical EOF append without mutating the current document', () => {
    const existingRaw = rawRecord('BG2AA', '010203');
    const source = Buffer.from(`<ADIF_VER:5>3.1.4<EOH>\r\n${existingRaw}\r\n`);
    const document = LogbookDocument.fromBuffer(source);
    const originalSegment = document.getSegments()[0]!;
    const appendedQso = qso({ id: 'appended-at-eof' });

    const mutation = document.prepareAppend(appendedQso);

    expect(mutation.kind).toBe('append');
    expect(mutation.appendBytes).toEqual(encodeAdifRecord(appendedQso));
    expect(mutation.nextDocument.toBuffer()).toEqual(Buffer.concat([source, mutation.appendBytes]));
    expect(document.toBuffer()).toEqual(source);
    expect(document.getQso('appended-at-eof')).toBeUndefined();
    expect(mutation.nextDocument.getQso('appended-at-eof')).toMatchObject(appendedQso);
    expect(mutation.nextDocument.getSegments()[0]).toMatchObject({
      segmentId: originalSegment.segmentId,
      rawHash: originalSegment.rawHash,
    });
    expect(mutation.nextDocument.getSegments()[1]!.rawRange.start).toBeGreaterThan(originalSegment.rawRange.end);
    expect(Object.isFrozen(mutation)).toBe(true);
    expect(() => document.prepareAppend(qso({ id: document.getQsoRecords()[0]!.id }))).toThrow(/already exists/);
  });

  it('prepares an in-place ordered rewrite for updates and leaves other raw records untouched', () => {
    const firstRaw = rawRecord('BG2AA', '010203', '14.074000', '<APP_OTHER:3>ONE');
    const secondRaw = rawRecord('BG2BB', '010303', '14.075000', '<APP_OTHER:3>TWO');
    const source = Buffer.from(`${firstRaw}\r\n${secondRaw}\r\n`);
    const document = LogbookDocument.fromBuffer(source);
    const first = document.getQsoRecords()[0]!;
    const firstSegmentId = document.getSegments()[0]!.segmentId;
    const secondSegmentId = document.getSegments()[1]!.segmentId;

    const mutation = document.prepareUpdate(first.id, { notes: 'edited' });
    const rewritten = mutation.nextDocument.toBuffer().toString();

    expect(mutation.kind).toBe('rewrite');
    expect(rewritten).toContain('<NOTES:6>edited');
    expect(rewritten).toContain(secondRaw);
    expect(rewritten.indexOf('<CALL:5>BG2AA')).toBeLessThan(rewritten.indexOf(secondRaw));
    expect(mutation.nextDocument.getSegments()[0]!.segmentId).toBe(firstSegmentId);
    expect(mutation.nextDocument.getSegments()[1]!.segmentId).toBe(secondSegmentId);
    expect(document.toBuffer()).toEqual(source);
    expect(document.getQso(first.id)?.notes).toBeUndefined();

    const reloaded = LogbookDocument.fromBuffer(mutation.nextDocument.toBuffer());
    expect(reloaded.getSegments()[0]!.segmentId).toBe(firstSegmentId);

    const repeated = mutation.nextDocument.prepareUpdate(first.id, { notes: 'edited-again' });
    expect(repeated.nextDocument.toBuffer().toString().match(/\r?\n/g)?.length)
      .toBe(mutation.nextDocument.toBuffer().toString().match(/\r?\n/g)?.length);
  });

  it('prepares deletion without reordering or rewriting surviving raw segments', () => {
    const firstRaw = rawRecord('BG2AA', '010203');
    const secondRaw = rawRecord('BG2BB', '010303');
    const thirdRaw = rawRecord('BG2CC', '010403');
    const document = LogbookDocument.fromBuffer(Buffer.from(`${firstRaw}\n${secondRaw}\n${thirdRaw}\n`));
    const deletedId = document.getQsoRecords()[1]!.id;

    const mutation = document.prepareDelete(deletedId);
    const rewritten = mutation.nextDocument.toBuffer().toString();

    expect(rewritten).toContain(firstRaw);
    expect(rewritten).not.toContain(secondRaw);
    expect(rewritten).toContain(thirdRaw);
    expect(rewritten.indexOf(firstRaw)).toBeLessThan(rewritten.indexOf(thirdRaw));
    expect(mutation.nextDocument.getQso(deletedId)).toBeUndefined();
    expect(document.getQso(deletedId)).toBeDefined();
  });

  it('keeps append-only imports as append mutations, including opaque and duplicate raw records', () => {
    const document = LogbookDocument.fromBuffer(Buffer.from('<ADIF_VER:5>3.1.4<EOH>\n'));
    const valid = Buffer.from(`${rawRecord('BG2AA', '010203')}\n`);
    const opaque = Buffer.from('<CALL:nope>BAD<QSO_DATE:8>20260810<TIME_ON:6>010203<EOR>\n');

    const mutation = document.prepareImport([
      { type: 'append', raw: valid },
      { type: 'append', raw: valid },
      { type: 'append', raw: opaque },
    ]);

    expect(mutation.kind).toBe('append');
    expect(mutation.nextDocument.getSegments()).toHaveLength(3);
    expect(mutation.nextDocument.getQsoRecords()).toHaveLength(2);
    expect(mutation.nextDocument.getOpaqueSegments()).toHaveLength(1);
    expect(mutation.nextDocument.getQsoRecords()[0]!.id).not.toBe(mutation.nextDocument.getQsoRecords()[1]!.id);
    expect(mutation.nextDocument.toBuffer()).toEqual(Buffer.concat([
      document.toBuffer(),
      valid,
      valid,
      opaque,
    ]));
  });

  it('promotes a mixed import plan to one immutable rewrite', () => {
    const firstRaw = rawRecord('BG2AA', '010203');
    const secondRaw = rawRecord('BG2BB', '010303');
    const document = LogbookDocument.fromBuffer(Buffer.from(`${firstRaw}\n${secondRaw}\n`));
    const [first, second] = document.getQsoRecords();
    const appended = Buffer.from(`${rawRecord('BG2CC', '010403')}\n`);

    const mutation = document.prepareImport([
      { type: 'replace', id: first!.id, qso: { ...first!, notes: 'merged', messageHistory: [] } },
      { type: 'delete', id: second!.id },
      { type: 'append', raw: appended },
    ]);

    expect(mutation.kind).toBe('rewrite');
    expect(mutation.nextDocument.getQso(first!.id)?.notes).toBe('merged');
    expect(mutation.nextDocument.getQso(second!.id)).toBeUndefined();
    expect(mutation.nextDocument.findByCallsign('BG2CC')).toHaveLength(1);
    expect(document.getQso(second!.id)).toBeDefined();
  });

  it('refuses every mutation while an incomplete tail remains unresolved', () => {
    const source = Buffer.from(`${rawRecord('BG2AA', '010203')}\n<CALL:5>PART`);
    const document = LogbookDocument.fromBuffer(source, scanAdifBuffer(source));

    expect(document.hasIncompleteTail()).toBe(true);
    expect(() => document.prepareAppend(qso())).toThrow(/incomplete tail/);
    expect(() => document.prepareDelete(document.getQsoRecords()[0]!.id)).toThrow(/incomplete tail/);
  });
});
