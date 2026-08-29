import { createHash } from 'node:crypto';

import type { QSORecord } from '@tx5dr/contracts';
import {
  getBandFromFrequency,
  normalizeQsoModeForStorage,
  toAdifMode,
} from '@tx5dr/core';
import {
  buildCommentFromMessageHistory,
  parseQsoTextFields,
  resolveQsoComment,
  sanitizeAdifFieldValue,
} from '@tx5dr/plugin-api';

export const ADIF_MAX_TAG_HEADER_BYTES = 64 * 1024;

export interface AdifByteRange {
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  end: number;
}

export type AdifScanIssueCode =
  | 'malformed-tag'
  | 'invalid-field-length'
  | 'incomplete-field-value'
  | 'unexpected-eoh'
  | 'non-whitespace-between-records';

export interface AdifScanIssue {
  code: AdifScanIssueCode;
  offset: number;
  message: string;
}

export interface ScannedAdifField {
  /** Normalized lowercase field name. */
  name: string;
  /** Original field spelling, without angle brackets or length metadata. */
  rawName: string;
  value: string;
  range: AdifByteRange;
  valueRange: AdifByteRange;
}

export interface ScannedAdifRecord {
  /** Separator bytes immediately before this record. Empty for the first record. */
  leadingRange: AdifByteRange;
  /** Exact record bytes from its first tag through the complete EOR tag. */
  range: AdifByteRange;
  fields: readonly ScannedAdifField[];
  rawHash: string;
  syntacticallyValid: boolean;
  issues: readonly AdifScanIssue[];
}

export interface AdifScanResult {
  byteLength: number;
  /** Header bytes through EOH, when present. This is a subset of prefixRange. */
  headerRange?: AdifByteRange;
  /** Exact bytes before the first complete record. */
  prefixRange: AdifByteRange;
  records: readonly ScannedAdifRecord[];
  /** Whitespace after the last complete record that is safe to retain. */
  safeTrailingRange: AdifByteRange;
  /** Non-whitespace bytes after the last safe boundary. */
  incompleteTailRange?: AdifByteRange;
  /** Truncating here removes only an incomplete tail, retaining safe whitespace. */
  safeEnd: number;
  issues: readonly AdifScanIssue[];
}

export interface EncodeAdifRecordOptions {
  fallbackMyGrid?: string;
}

interface ParsedTag {
  kind: 'field' | 'eoh' | 'eor' | 'malformed' | 'incomplete';
  start: number;
  end: number;
  nextOffset: number;
  field?: ScannedAdifField;
  issue?: AdifScanIssue;
}

function makeRange(start: number, end: number): AdifByteRange {
  return { start, end };
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

function firstNonWhitespace(source: Buffer, start: number, end: number): number {
  let offset = start;
  while (offset < end && isAsciiWhitespace(source[offset]!)) {
    offset += 1;
  }
  return offset;
}

function hashRange(source: Buffer, range: AdifByteRange): string {
  return createHash('sha256').update(source.subarray(range.start, range.end)).digest('hex');
}

function malformedTag(start: number, end: number, message: string): ParsedTag {
  return {
    kind: 'malformed',
    start,
    end,
    nextOffset: Math.max(start + 1, end),
    issue: { code: 'malformed-tag', offset: start, message },
  };
}

function parseTagAt(source: Buffer, start: number): ParsedTag {
  const close = source.indexOf(0x3e, start + 1); // >
  if (close < 0) {
    return {
      kind: 'incomplete',
      start,
      end: source.length,
      nextOffset: source.length,
      issue: {
        code: 'malformed-tag',
        offset: start,
        message: 'ADIF tag is missing its closing angle bracket',
      },
    };
  }

  if (close - start - 1 > ADIF_MAX_TAG_HEADER_BYTES) {
    return malformedTag(
      start,
      close + 1,
      `ADIF tag header exceeds the ${ADIF_MAX_TAG_HEADER_BYTES}-byte scan limit`,
    );
  }

  const header = source.subarray(start + 1, close).toString('ascii').trim();
  if (!header) {
    return malformedTag(start, close + 1, 'ADIF tag name is empty');
  }

  const parts = header.split(':');
  const rawName = parts[0]?.trim() ?? '';
  if (!/^[A-Za-z0-9_]+$/.test(rawName)) {
    return malformedTag(start, close + 1, `Invalid ADIF field name: ${rawName || '(empty)'}`);
  }

  const normalizedName = rawName.toLowerCase();
  if (parts.length === 1 && normalizedName === 'eoh') {
    return { kind: 'eoh', start, end: close + 1, nextOffset: close + 1 };
  }
  if (parts.length === 1 && normalizedName === 'eor') {
    return { kind: 'eor', start, end: close + 1, nextOffset: close + 1 };
  }

  const rawLength = parts[1]?.trim();
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    return {
      kind: 'malformed',
      start,
      end: close + 1,
      nextOffset: close + 1,
      issue: {
        code: 'invalid-field-length',
        offset: start,
        message: `ADIF field ${rawName} has an invalid byte length`,
      },
    };
  }

  const length = Number.parseInt(rawLength, 10);
  if (!Number.isSafeInteger(length) || length < 0) {
    return {
      kind: 'malformed',
      start,
      end: close + 1,
      nextOffset: close + 1,
      issue: {
        code: 'invalid-field-length',
        offset: start,
        message: `ADIF field ${rawName} byte length is outside the supported range`,
      },
    };
  }

  const valueStart = close + 1;
  const valueEnd = valueStart + length;
  if (valueEnd > source.length) {
    return {
      kind: 'incomplete',
      start,
      end: source.length,
      nextOffset: source.length,
      issue: {
        code: 'incomplete-field-value',
        offset: start,
        message: `ADIF field ${rawName} declares ${length} bytes but the file ends early`,
      },
    };
  }

  return {
    kind: 'field',
    start,
    end: valueEnd,
    nextOffset: valueEnd,
    field: {
      name: normalizedName,
      rawName,
      value: source.subarray(valueStart, valueEnd).toString('utf8'),
      range: makeRange(start, valueEnd),
      valueRange: makeRange(valueStart, valueEnd),
    },
  };
}

function findHeaderRange(source: Buffer): AdifByteRange | undefined {
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf(0x3c, cursor); // <
    if (open < 0) return undefined;
    const tag = parseTagAt(source, open);
    if (tag.kind === 'eoh') return makeRange(0, tag.end);
    if (tag.kind === 'eor' || tag.kind === 'incomplete') return undefined;
    cursor = tag.nextOffset;
  }
  return undefined;
}

/**
 * Scan one complete in-memory ADIF snapshot without decoding it as text first.
 * All offsets and declared field lengths are bytes, so UTF-8 values cannot move
 * subsequent tag boundaries and length-delimited values may safely contain tags.
 */
export function scanAdifBuffer(
  source: Buffer,
  onRecordsScanned?: (recordsScanned: number) => void,
): AdifScanResult {
  const headerRange = findHeaderRange(source);
  const bodyStart = headerRange?.end ?? 0;
  const records: ScannedAdifRecord[] = [];
  const issues: AdifScanIssue[] = [];

  let cursor = bodyStart;
  let boundary = bodyStart;
  let firstTagStart: number | undefined;
  let fields: ScannedAdifField[] = [];
  let recordIssues: AdifScanIssue[] = [];
  let stoppedAtIncompleteTag = false;

  while (cursor < source.length) {
    const open = source.indexOf(0x3c, cursor);
    if (open < 0) break;

    const tag = parseTagAt(source, open);
    if (tag.kind === 'incomplete') {
      firstTagStart ??= open;
      if (tag.issue) {
        recordIssues.push(tag.issue);
        issues.push(tag.issue);
      }
      stoppedAtIncompleteTag = true;
      break;
    }

    if (tag.kind === 'field') {
      firstTagStart ??= open;
      fields.push(tag.field!);
      cursor = tag.nextOffset;
      continue;
    }

    if (tag.kind === 'malformed') {
      firstTagStart ??= open;
      if (tag.issue) {
        recordIssues.push(tag.issue);
        issues.push(tag.issue);
      }
      cursor = tag.nextOffset;
      continue;
    }

    if (tag.kind === 'eoh') {
      firstTagStart ??= open;
      const issue: AdifScanIssue = {
        code: 'unexpected-eoh',
        offset: open,
        message: 'EOH marker appears after the record body has started',
      };
      recordIssues.push(issue);
      issues.push(issue);
      cursor = tag.nextOffset;
      continue;
    }

    const recordStart = firstTagStart ?? open;
    const separatorStart = records.length === 0 ? recordStart : boundary;
    const separatorNonWhitespace = firstNonWhitespace(source, separatorStart, recordStart);
    if (records.length > 0 && separatorNonWhitespace < recordStart) {
      const issue: AdifScanIssue = {
        code: 'non-whitespace-between-records',
        offset: separatorNonWhitespace,
        message: 'Non-whitespace bytes appear between complete ADIF records',
      };
      issues.push(issue);
    }

    const range = makeRange(recordStart, tag.end);
    records.push({
      leadingRange: records.length === 0
        ? makeRange(recordStart, recordStart)
        : makeRange(boundary, recordStart),
      range,
      fields,
      rawHash: hashRange(source, range),
      syntacticallyValid: recordIssues.length === 0,
      issues: recordIssues,
    });
    if (records.length % 1000 === 0) onRecordsScanned?.(records.length);

    boundary = tag.end;
    firstTagStart = undefined;
    fields = [];
    recordIssues = [];
    cursor = tag.nextOffset;
  }

  const firstRecordStart = records[0]?.range.start;
  let safeEnd: number;
  let incompleteTailRange: AdifByteRange | undefined;
  const tailBoundary = records.at(-1)?.range.end ?? bodyStart;
  const possibleTailStart = firstNonWhitespace(source, tailBoundary, source.length);
  const hasPartialRecord = firstTagStart !== undefined || stoppedAtIncompleteTag;

  if (possibleTailStart < source.length || hasPartialRecord) {
    safeEnd = Math.min(possibleTailStart, firstTagStart ?? possibleTailStart);
    incompleteTailRange = makeRange(safeEnd, source.length);
  } else {
    safeEnd = source.length;
  }

  const prefixEnd = firstRecordStart ?? (records.length === 0 ? safeEnd : bodyStart);
  const safeTrailingStart = records.at(-1)?.range.end ?? prefixEnd;
  if (records.length > 0 && records.length % 1000 !== 0) onRecordsScanned?.(records.length);

  return {
    byteLength: source.length,
    headerRange,
    prefixRange: makeRange(0, prefixEnd),
    records,
    safeTrailingRange: makeRange(safeTrailingStart, safeEnd),
    incompleteTailRange,
    safeEnd,
    issues,
  };
}

export function getLastAdifFieldValue(record: ScannedAdifRecord, name: string): string | undefined {
  const normalizedName = name.trim().toLowerCase();
  for (let index = record.fields.length - 1; index >= 0; index -= 1) {
    if (record.fields[index]!.name === normalizedName) {
      return record.fields[index]!.value;
    }
  }
  return undefined;
}

const QSO_PROJECTION_FIELD_NAMES = new Set([
  'call',
  'qso_date',
  'time_on',
  'freq',
  'mode',
  'submode',
  'comment',
  'contest_id',
  'app_tx5dr_message_history',
  'app_tx5dr_id',
  'operator',
  'qso_date_off',
  'time_off',
  'gridsquare',
  'my_gridsquare',
  'station_callsign',
  'rst_sent',
  'rst_rcvd',
  'qth',
  'notes',
  'note',
  'dxcc',
  'country',
  'cqz',
  'ituz',
  'app_tx5dr_station_location_id',
  'my_dxcc',
  'my_cq_zone',
  'my_itu_zone',
  'my_state',
  'state',
  'my_cnty',
  'cnty',
  'my_iota',
  'iota',
  'app_tx5dr_dxcc_status',
  'app_tx5dr_dxcc_source',
  'app_tx5dr_dxcc_confidence',
  'app_tx5dr_dxcc_needs_review',
  'lotw_qsl_sent',
  'lotw_qsl_rcvd',
  'lotw_qslsdate',
  'lotw_qslrdate',
  'app_tx5dr_qrz_qsl_sent',
  'app_tx5dr_qrz_qsl_rcvd',
  'app_tx5dr_qrz_qslsdate',
  'app_tx5dr_qrz_qslrdate',
  'app_qrzlog_status',
]);

/** Fields required to create the compact QSO DTO returned by the scan worker. */
export function isAdifQsoProjectionField(name: string): boolean {
  return QSO_PROJECTION_FIELD_NAMES.has(name.trim().toLowerCase());
}

function parseAdifTimestamp(dateValue: string, timeValue: string): number | undefined {
  const date = dateValue.trim();
  const time = timeValue.trim();
  if (!/^\d{8}$/.test(date) || !/^\d{4}(?:\d{2})?$/.test(time)) return undefined;

  const normalizedTime = time.padEnd(6, '0');
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(4, 6), 10);
  const day = Number.parseInt(date.slice(6, 8), 10);
  const hour = Number.parseInt(normalizedTime.slice(0, 2), 10);
  const minute = Number.parseInt(normalizedTime.slice(2, 4), 10);
  const second = Number.parseInt(normalizedTime.slice(4, 6), 10);
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(value);

  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
    || check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return value;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAdifDateOnly(value: string | undefined): number | undefined {
  return value && /^\d{8}$/.test(value.trim())
    ? parseAdifTimestamp(value.trim(), '000000')
    : undefined;
}

function mapAdifMode(mode?: string, submode?: string): Pick<QSORecord, 'mode' | 'submode'> {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();
  if (normalizedMode === 'MFSK' && normalizedSubmode === 'FT4') {
    return { mode: 'FT4', submode: 'FT4' };
  }
  return normalizeQsoModeForStorage({
    mode: mode || 'FT8',
    submode: submode || undefined,
  });
}

function isOneOf<T extends string>(value: string | undefined, allowed: readonly T[]): value is T {
  return value !== undefined && allowed.includes(value as T);
}

/** Decode the fields used by TX-5DR. Unknown fields remain preserved in raw bytes. */
export function decodeAdifRecord(record: ScannedAdifRecord, runtimeId?: string): QSORecord | undefined {
  if (!record.syntacticallyValid) return undefined;

  const value = (name: string) => getLastAdifFieldValue(record, name);
  const callsign = value('call')?.trim();
  const qsoDate = value('qso_date');
  const timeOn = value('time_on');
  if (!callsign || !qsoDate || !timeOn) return undefined;

  const startTime = parseAdifTimestamp(qsoDate, timeOn);
  if (startTime === undefined) return undefined;

  const frequencyMhz = Number.parseFloat(value('freq')?.trim() || '0');
  if (!Number.isFinite(frequencyMhz)) return undefined;

  const mode = mapAdifMode(value('mode'), value('submode'));
  const text = parseQsoTextFields(value('comment'), value('app_tx5dr_message_history'));
  const explicitId = value('app_tx5dr_id')?.trim();
  const operator = value('operator')?.trim();
  const fallbackId = `${callsign}_${qsoDate.trim()}_${timeOn.trim()}${operator ? `_${operator}` : ''}`;
  const endDate = value('qso_date_off') || qsoDate;
  const endTimeValue = value('time_off');
  const endTime = endTimeValue ? parseAdifTimestamp(endDate, endTimeValue) : undefined;

  const qso: QSORecord = {
    id: runtimeId || explicitId || fallbackId,
    callsign,
    grid: value('gridsquare') || undefined,
    myGrid: value('my_gridsquare') || undefined,
    myCallsign: value('station_callsign') || undefined,
    frequency: frequencyMhz * 1_000_000,
    mode: mode.mode,
    submode: mode.submode,
    startTime,
    endTime,
    reportSent: value('rst_sent') || undefined,
    reportReceived: value('rst_rcvd') || undefined,
    messageHistory: text.messageHistory,
    comment: text.comment,
    contestId: value('contest_id') || undefined,
    qth: value('qth') || undefined,
    notes: value('notes') || value('note') || undefined,
  };

  qso.dxccId = parseOptionalInteger(value('dxcc'));
  qso.dxccEntity = value('country') || undefined;
  qso.cqZone = parseOptionalInteger(value('cqz'));
  qso.ituZone = parseOptionalInteger(value('ituz'));
  qso.stationLocationId = value('app_tx5dr_station_location_id') || undefined;
  qso.myDxccId = parseOptionalInteger(value('my_dxcc'));
  qso.myCqZone = parseOptionalInteger(value('my_cq_zone'));
  qso.myItuZone = parseOptionalInteger(value('my_itu_zone'));
  const hasLegacyTx5drFields = record.fields.some((candidate) => [
    'note',
    'app_tx5dr_station_location_id',
    'app_tx5dr_dxcc_status',
    'app_tx5dr_qrz_qsl_sent',
    'app_tx5dr_qrz_qsl_rcvd',
    'app_tx5dr_qrz_qslsdate',
    'app_tx5dr_qrz_qslrdate',
  ].includes(candidate.name));
  qso.myState = value('my_state') || (hasLegacyTx5drFields ? value('state') : undefined) || undefined;
  qso.myCounty = value('my_cnty') || (hasLegacyTx5drFields ? value('cnty') : undefined) || undefined;
  qso.myIota = value('my_iota') || (hasLegacyTx5drFields ? value('iota') : undefined) || undefined;

  const dxccStatus = value('app_tx5dr_dxcc_status');
  if (isOneOf(dxccStatus, ['current', 'deleted', 'none', 'unknown'] as const)) qso.dxccStatus = dxccStatus;
  const dxccSource = value('app_tx5dr_dxcc_source');
  if (isOneOf(dxccSource, ['resolver', 'adif', 'lotw', 'manual_override'] as const)) qso.dxccSource = dxccSource;
  const dxccConfidence = value('app_tx5dr_dxcc_confidence');
  if (isOneOf(dxccConfidence, ['exception', 'prefix', 'heuristic', 'manual', 'unknown'] as const)) {
    qso.dxccConfidence = dxccConfidence;
  }
  const needsReview = value('app_tx5dr_dxcc_needs_review')?.toUpperCase();
  if (needsReview === 'Y' || needsReview === 'N') qso.dxccNeedsReview = needsReview === 'Y';

  const lotwSent = value('lotw_qsl_sent')?.toUpperCase();
  if (isOneOf(lotwSent, ['Y', 'N', 'R', 'Q', 'I'] as const)) qso.lotwQslSent = lotwSent;
  const lotwReceived = value('lotw_qsl_rcvd')?.toUpperCase();
  if (isOneOf(lotwReceived, ['Y', 'N', 'R', 'I', 'V'] as const)) qso.lotwQslReceived = lotwReceived;
  qso.lotwQslSentDate = parseAdifDateOnly(value('lotw_qslsdate'));
  qso.lotwQslReceivedDate = parseAdifDateOnly(value('lotw_qslrdate'));

  const qrzSent = value('app_tx5dr_qrz_qsl_sent')?.toUpperCase();
  if (isOneOf(qrzSent, ['Y', 'N'] as const)) qso.qrzQslSent = qrzSent;
  const qrzReceived = value('app_tx5dr_qrz_qsl_rcvd')?.toUpperCase()
    || value('app_qrzlog_status')?.toUpperCase();
  if (qrzReceived === 'C' || qrzReceived === 'Y') qso.qrzQslReceived = 'Y';
  if (qrzReceived === 'N') qso.qrzQslReceived = 'N';
  qso.qrzQslSentDate = parseAdifDateOnly(value('app_tx5dr_qrz_qslsdate'));
  qso.qrzQslReceivedDate = parseAdifDateOnly(value('app_tx5dr_qrz_qslrdate'));

  return qso;
}

function field(name: string, value: string): string {
  return `<${name}:${Buffer.byteLength(value, 'utf8')}>${value}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10).replace(/-/g, '');
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19).replace(/:/g, '');
}

/** Encode one canonical TX-5DR QSO record. The returned buffer always ends in EOR + LF. */
export function encodeAdifRecord(qso: QSORecord, options: EncodeAdifRecordOptions = {}): Buffer {
  const adifMode = toAdifMode(qso);
  const frequency = (qso.frequency / 1_000_000).toFixed(6);
  const parts: string[] = [
    field('CALL', qso.callsign),
    ...(qso.id ? [field('APP_TX5DR_ID', qso.id)] : []),
    field('QSO_DATE', formatDate(qso.startTime)),
    field('TIME_ON', formatTime(qso.startTime)),
    field('MODE', adifMode.mode),
    ...(adifMode.submode ? [field('SUBMODE', adifMode.submode)] : []),
    field('FREQ', frequency),
    field('BAND', getBandFromFrequency(qso.frequency)),
  ];

  const append = (name: string, value: string | undefined) => {
    if (value) parts.push(field(name, value));
  };
  const appendNumber = (name: string, value: number | undefined) => {
    if (value !== undefined) append(name, String(value));
  };
  const appendDate = (name: string, value: number | undefined) => {
    if (value !== undefined) append(name, formatDate(value));
  };

  append('GRIDSQUARE', qso.grid);
  append('CONTEST_ID', qso.contestId);
  appendNumber('DXCC', qso.dxccId);
  append('COUNTRY', qso.dxccEntity);
  appendNumber('CQZ', qso.cqZone);
  appendNumber('ITUZ', qso.ituZone);
  if (qso.endTime !== undefined) {
    append('QSO_DATE_OFF', formatDate(qso.endTime));
    append('TIME_OFF', formatTime(qso.endTime));
  }
  append('RST_SENT', qso.reportSent);
  append('RST_RCVD', qso.reportReceived);

  append('APP_TX5DR_MESSAGE_HISTORY', sanitizeAdifFieldValue(
    buildCommentFromMessageHistory(qso.messageHistory) ?? '',
  ) || undefined);
  append('COMMENT', sanitizeAdifFieldValue(resolveQsoComment(qso) ?? '') || undefined);
  append('QTH', qso.qth ? sanitizeAdifFieldValue(qso.qth) || undefined : undefined);
  append('NOTES', qso.notes ? sanitizeAdifFieldValue(qso.notes) || undefined : undefined);

  append('MY_GRIDSQUARE', options.fallbackMyGrid ?? qso.myGrid);
  append('STATION_CALLSIGN', qso.myCallsign);
  appendNumber('MY_DXCC', qso.myDxccId);
  appendNumber('MY_CQ_ZONE', qso.myCqZone);
  appendNumber('MY_ITU_ZONE', qso.myItuZone);
  append('MY_STATE', qso.myState);
  append('MY_CNTY', qso.myCounty);
  append('MY_IOTA', qso.myIota);
  append('APP_TX5DR_STATION_LOCATION_ID', qso.stationLocationId);
  append('APP_TX5DR_DXCC_STATUS', qso.dxccStatus);
  append('APP_TX5DR_DXCC_SOURCE', qso.dxccSource);
  append('APP_TX5DR_DXCC_CONFIDENCE', qso.dxccConfidence);
  if (qso.dxccNeedsReview !== undefined) append('APP_TX5DR_DXCC_NEEDS_REVIEW', qso.dxccNeedsReview ? 'Y' : 'N');

  append('LOTW_QSL_SENT', qso.lotwQslSent);
  append('LOTW_QSL_RCVD', qso.lotwQslReceived);
  appendDate('LOTW_QSLSDATE', qso.lotwQslSentDate);
  appendDate('LOTW_QSLRDATE', qso.lotwQslReceivedDate);
  append('APP_TX5DR_QRZ_QSL_SENT', qso.qrzQslSent);
  append('APP_TX5DR_QRZ_QSL_RCVD', qso.qrzQslReceived);
  if (qso.qrzQslReceived === 'Y') append('APP_QRZLOG_STATUS', 'C');
  appendDate('APP_TX5DR_QRZ_QSLSDATE', qso.qrzQslSentDate);
  appendDate('APP_TX5DR_QRZ_QSLRDATE', qso.qrzQslReceivedDate);
  append('OPERATOR', qso.myCallsign);

  return Buffer.from(`${parts.join('')}<EOR>\n`, 'utf8');
}

export function encodeAdifHeader(programVersion = '1.0.0'): Buffer {
  return Buffer.from([
    'TX-5DR Log File',
    '<ADIF_VER:5>3.1.4',
    '<PROGRAMID:6>TX-5DR',
    field('PROGRAMVERSION', programVersion),
    '<EOH>',
    '',
    '',
  ].join('\n'), 'utf8');
}

export function sliceAdifRange(source: Buffer, range: AdifByteRange): Buffer {
  return source.subarray(range.start, range.end);
}
