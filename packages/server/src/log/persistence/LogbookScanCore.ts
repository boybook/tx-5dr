import { createHash, type Hash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

import {
  ADIF_MAX_TAG_HEADER_BYTES,
  isAdifQsoProjectionField,
  type AdifByteRange,
  type AdifScanIssue,
  type AdifScanResult,
  type ScannedAdifField,
  type ScannedAdifRecord,
} from './AdifCodec.js';
import {
  LogbookRecordProjector,
  type LogbookRecordProjection,
} from './LogbookDocument.js';
import type {
  GenerationToken,
  LogbookFileScanResult,
  LogbookScanProgress,
} from './LogbookScanTypes.js';

const READ_CHUNK_BYTES = 64 * 1024;
const READ_PROGRESS_BYTES = 1024 * 1024;

export class LogbookFileChangedDuringScanError extends Error {
  readonly code = 'LOGBOOK_FILE_CHANGED_DURING_SCAN';

  constructor(public readonly filePath: string) {
    super(`Logbook changed while it was being scanned: ${filePath}`);
    this.name = 'LogbookFileChangedDuringScanError';
  }
}

export class LogbookScanNotAFileError extends Error {
  readonly code = 'LOGBOOK_SCAN_NOT_A_FILE';

  constructor(public readonly filePath: string) {
    super(`Logbook path is not a regular file: ${filePath}`);
    this.name = 'LogbookScanNotAFileError';
  }
}

type ParsedStreamTag =
  | { kind: 'field'; name: string; rawName: string; length: number }
  | { kind: 'eoh' }
  | { kind: 'eor' }
  | { kind: 'malformed'; issue: AdifScanIssue };

interface PendingField {
  name: string;
  rawName: string;
  tagStart: number;
  valueStart: number;
  valueEnd: number;
  declaredLength: number;
  remaining: number;
  capture?: Buffer;
  captureOffset: number;
}

function makeRange(start: number, end: number): AdifByteRange {
  return { start, end };
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0d
    || byte === 0x0b
    || byte === 0x0c;
}

function parseStreamTagHeader(header: Buffer, start: number, overflowed: boolean): ParsedStreamTag {
  if (overflowed) {
    return {
      kind: 'malformed',
      issue: {
        code: 'malformed-tag',
        offset: start,
        message: `ADIF tag header exceeds the ${ADIF_MAX_TAG_HEADER_BYTES}-byte scan limit`,
      },
    };
  }

  const text = header.toString('ascii').trim();
  if (!text) {
    return {
      kind: 'malformed',
      issue: { code: 'malformed-tag', offset: start, message: 'ADIF tag name is empty' },
    };
  }

  const parts = text.split(':');
  const rawName = parts[0]?.trim() ?? '';
  if (!/^[A-Za-z0-9_]+$/.test(rawName)) {
    return {
      kind: 'malformed',
      issue: {
        code: 'malformed-tag',
        offset: start,
        message: `Invalid ADIF field name: ${rawName || '(empty)'}`,
      },
    };
  }

  const name = rawName.toLowerCase();
  if (parts.length === 1 && name === 'eoh') return { kind: 'eoh' };
  if (parts.length === 1 && name === 'eor') return { kind: 'eor' };

  const rawLength = parts[1]?.trim();
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    return {
      kind: 'malformed',
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
      issue: {
        code: 'invalid-field-length',
        offset: start,
        message: `ADIF field ${rawName} byte length is outside the supported range`,
      },
    };
  }
  return { kind: 'field', name, rawName, length };
}

class StreamingHeaderDetector {
  private mode: 'search' | 'tag' | 'value' | 'done' = 'search';
  private tagStart = 0;
  private tagChunks: Buffer[] = [];
  private tagLength = 0;
  private tagOverflowed = false;
  private valueRemaining = 0;
  private detectedHeaderEnd?: number;

  push(chunk: Buffer, absoluteStart: number): void {
    if (this.mode === 'done') return;
    let index = 0;
    while (index < chunk.length && this.mode !== 'done') {
      if (this.mode === 'search') {
        const open = chunk.indexOf(0x3c, index);
        if (open < 0) return;
        this.beginTag(absoluteStart + open);
        index = open + 1;
        continue;
      }

      if (this.mode === 'value') {
        const consumed = Math.min(this.valueRemaining, chunk.length - index);
        this.valueRemaining -= consumed;
        index += consumed;
        if (this.valueRemaining === 0) this.mode = 'search';
        continue;
      }

      const close = chunk.indexOf(0x3e, index);
      const headerEnd = close < 0 ? chunk.length : close;
      this.appendTagBytes(chunk.subarray(index, headerEnd));
      if (close < 0) return;

      const tagEnd = absoluteStart + close + 1;
      const parsed = parseStreamTagHeader(
        Buffer.concat(this.tagChunks, this.tagLength),
        this.tagStart,
        this.tagOverflowed,
      );
      index = close + 1;

      if (parsed.kind === 'eoh') {
        this.detectedHeaderEnd = tagEnd;
        this.mode = 'done';
      } else if (parsed.kind === 'eor') {
        this.mode = 'done';
      } else if (parsed.kind === 'field' && parsed.length > 0) {
        this.valueRemaining = parsed.length;
        this.mode = 'value';
      } else {
        this.mode = 'search';
      }
    }
  }

  finish(): number | undefined {
    return this.detectedHeaderEnd;
  }

  private beginTag(start: number): void {
    this.mode = 'tag';
    this.tagStart = start;
    this.tagChunks = [];
    this.tagLength = 0;
    this.tagOverflowed = false;
  }

  private appendTagBytes(bytes: Buffer): void {
    if (bytes.length === 0 || this.tagOverflowed) return;
    const remaining = ADIF_MAX_TAG_HEADER_BYTES - this.tagLength;
    if (bytes.length > remaining) {
      if (remaining > 0) {
        this.tagChunks.push(Buffer.from(bytes.subarray(0, remaining)));
        this.tagLength += remaining;
      }
      this.tagOverflowed = true;
      return;
    }
    this.tagChunks.push(Buffer.from(bytes));
    this.tagLength += bytes.length;
  }
}

class StreamingBodyScanner {
  private mode: 'search' | 'tag' | 'value' = 'search';
  private readonly records: ScannedAdifRecord[] = [];
  private readonly projections: LogbookRecordProjection[] = [];
  private readonly issues: AdifScanIssue[] = [];
  private readonly warnings: string[] = [];
  private readonly projector = new LogbookRecordProjector();
  private readonly fields = new Map<string, ScannedAdifField>();
  private readonly recordIssues: AdifScanIssue[] = [];
  private boundary: number;
  private firstTagStart?: number;
  private recordHasher?: Hash;
  private tagStart = 0;
  private tagChunks: Buffer[] = [];
  private tagLength = 0;
  private tagOverflowed = false;
  private pendingField?: PendingField;
  private tailFirstNonWhitespace?: number;
  private stoppedAtIncompleteTag = false;

  constructor(
    private readonly bodyStart: number,
    private readonly onRecordsScanned?: (recordsScanned: number) => void,
  ) {
    this.boundary = bodyStart;
  }

  push(chunk: Buffer, absoluteStart: number): void {
    let index = 0;
    while (index < chunk.length) {
      if (this.mode === 'search') {
        const open = chunk.indexOf(0x3c, index);
        const end = open < 0 ? chunk.length : open;
        this.consumeBetweenTags(chunk.subarray(index, end), absoluteStart + index);
        if (open < 0) return;

        this.beginTag(absoluteStart + open);
        this.recordHasher!.update(chunk.subarray(open, open + 1));
        index = open + 1;
        continue;
      }

      if (this.mode === 'value') {
        index = this.consumeFieldValue(chunk, index);
        continue;
      }

      const close = chunk.indexOf(0x3e, index);
      const headerEnd = close < 0 ? chunk.length : close;
      const headerBytes = chunk.subarray(index, headerEnd);
      this.recordHasher!.update(headerBytes);
      this.appendTagBytes(headerBytes);
      if (close < 0) return;

      this.recordHasher!.update(chunk.subarray(close, close + 1));
      const tagEnd = absoluteStart + close + 1;
      const parsed = parseStreamTagHeader(
        Buffer.concat(this.tagChunks, this.tagLength),
        this.tagStart,
        this.tagOverflowed,
      );
      index = close + 1;
      this.handleParsedTag(parsed, tagEnd);
    }
  }

  finish(byteLength: number, headerRange?: AdifByteRange): {
    scan: AdifScanResult;
    projections: readonly LogbookRecordProjection[];
    warnings: readonly string[];
  } {
    if (this.mode === 'tag') {
      const issue: AdifScanIssue = {
        code: 'malformed-tag',
        offset: this.tagStart,
        message: 'ADIF tag is missing its closing angle bracket',
      };
      this.addRecordIssue(issue);
      this.stoppedAtIncompleteTag = true;
    } else if (this.mode === 'value' && this.pendingField) {
      const issue: AdifScanIssue = {
        code: 'incomplete-field-value',
        offset: this.pendingField.tagStart,
        message: `ADIF field ${this.pendingField.rawName} declares ${this.pendingField.declaredLength} bytes but the file ends early`,
      };
      this.addRecordIssue(issue);
      this.stoppedAtIncompleteTag = true;
    }

    const possibleTailStart = this.tailFirstNonWhitespace ?? byteLength;
    const hasPartialRecord = this.firstTagStart !== undefined || this.stoppedAtIncompleteTag;
    let safeEnd = byteLength;
    let incompleteTailRange: AdifByteRange | undefined;
    if (possibleTailStart < byteLength || hasPartialRecord) {
      safeEnd = Math.min(possibleTailStart, this.firstTagStart ?? possibleTailStart);
      incompleteTailRange = makeRange(safeEnd, byteLength);
    }

    const firstRecordStart = this.records[0]?.range.start;
    const prefixEnd = firstRecordStart ?? safeEnd;
    const safeTrailingStart = this.records.at(-1)?.range.end ?? prefixEnd;
    if (this.records.length > 0 && this.records.length % 1000 !== 0) {
      this.onRecordsScanned?.(this.records.length);
    }

    return {
      scan: {
        byteLength,
        headerRange,
        prefixRange: makeRange(0, prefixEnd),
        records: this.records,
        safeTrailingRange: makeRange(safeTrailingStart, safeEnd),
        incompleteTailRange,
        safeEnd,
        issues: this.issues,
      },
      projections: Object.freeze([...this.projections]),
      warnings: Object.freeze([...this.warnings, ...this.issues.map(issue => issue.message)]),
    };
  }

  private consumeBetweenTags(bytes: Buffer, absoluteStart: number): void {
    if (bytes.length === 0) return;
    if (this.firstTagStart !== undefined) {
      this.recordHasher!.update(bytes);
      return;
    }
    if (this.tailFirstNonWhitespace !== undefined) return;
    for (let index = 0; index < bytes.length; index += 1) {
      if (!isAsciiWhitespace(bytes[index]!)) {
        this.tailFirstNonWhitespace = absoluteStart + index;
        return;
      }
    }
  }

  private beginTag(start: number): void {
    if (this.firstTagStart === undefined) {
      this.firstTagStart = start;
      this.recordHasher = createHash('sha256');
      this.fields.clear();
      this.recordIssues.length = 0;
    }
    this.mode = 'tag';
    this.tagStart = start;
    this.tagChunks = [];
    this.tagLength = 0;
    this.tagOverflowed = false;
  }

  private appendTagBytes(bytes: Buffer): void {
    if (bytes.length === 0 || this.tagOverflowed) return;
    const remaining = ADIF_MAX_TAG_HEADER_BYTES - this.tagLength;
    if (bytes.length > remaining) {
      if (remaining > 0) {
        this.tagChunks.push(Buffer.from(bytes.subarray(0, remaining)));
        this.tagLength += remaining;
      }
      this.tagOverflowed = true;
      return;
    }
    this.tagChunks.push(Buffer.from(bytes));
    this.tagLength += bytes.length;
  }

  private handleParsedTag(tag: ParsedStreamTag, tagEnd: number): void {
    if (tag.kind === 'malformed') {
      this.addRecordIssue(tag.issue);
      this.mode = 'search';
      return;
    }
    if (tag.kind === 'eoh') {
      this.addRecordIssue({
        code: 'unexpected-eoh',
        offset: this.tagStart,
        message: 'EOH marker appears after the record body has started',
      });
      this.mode = 'search';
      return;
    }
    if (tag.kind === 'eor') {
      this.finishRecord(tagEnd);
      this.mode = 'search';
      return;
    }

    const valueEnd = tagEnd + tag.length;
    const capture = isAdifQsoProjectionField(tag.name)
      ? Buffer.allocUnsafe(tag.length)
      : undefined;
    this.pendingField = {
      name: tag.name,
      rawName: tag.rawName,
      tagStart: this.tagStart,
      valueStart: tagEnd,
      valueEnd,
      declaredLength: tag.length,
      remaining: tag.length,
      capture,
      captureOffset: 0,
    };
    if (tag.length === 0) {
      this.finishField();
      this.mode = 'search';
    } else {
      this.mode = 'value';
    }
  }

  private consumeFieldValue(chunk: Buffer, index: number): number {
    const field = this.pendingField!;
    const consumed = Math.min(field.remaining, chunk.length - index);
    const bytes = chunk.subarray(index, index + consumed);
    this.recordHasher!.update(bytes);
    if (field.capture) {
      bytes.copy(field.capture, field.captureOffset);
      field.captureOffset += consumed;
    }
    field.remaining -= consumed;
    index += consumed;
    if (field.remaining === 0) {
      this.finishField();
      this.mode = 'search';
    }
    return index;
  }

  private finishField(): void {
    const field = this.pendingField!;
    if (isAdifQsoProjectionField(field.name)) {
      this.fields.set(field.name, {
        name: field.name,
        rawName: field.rawName,
        value: field.capture?.toString('utf8') ?? '',
        range: makeRange(field.tagStart, field.valueEnd),
        valueRange: makeRange(field.valueStart, field.valueEnd),
      });
    }
    this.pendingField = undefined;
  }

  private finishRecord(tagEnd: number): void {
    const recordStart = this.firstTagStart!;
    if (
      this.records.length > 0
      && this.tailFirstNonWhitespace !== undefined
      && this.tailFirstNonWhitespace < recordStart
    ) {
      this.issues.push({
        code: 'non-whitespace-between-records',
        offset: this.tailFirstNonWhitespace,
        message: 'Non-whitespace bytes appear between complete ADIF records',
      });
    }

    const fullRecord: ScannedAdifRecord = {
      leadingRange: this.records.length === 0
        ? makeRange(recordStart, recordStart)
        : makeRange(this.boundary, recordStart),
      range: makeRange(recordStart, tagEnd),
      fields: [...this.fields.values()],
      rawHash: this.recordHasher!.digest('hex'),
      syntacticallyValid: this.recordIssues.length === 0,
      issues: [...this.recordIssues],
    };
    const projected = this.projector.project(fullRecord);
    this.projections.push(projected);
    this.records.push({ ...fullRecord, fields: [] });
    if (this.records.length % 1000 === 0) this.onRecordsScanned?.(this.records.length);

    this.boundary = tagEnd;
    this.firstTagStart = undefined;
    this.recordHasher = undefined;
    this.fields.clear();
    this.recordIssues.length = 0;
    this.tailFirstNonWhitespace = undefined;
  }

  private addRecordIssue(issue: AdifScanIssue): void {
    this.recordIssues.push(issue);
    this.issues.push(issue);
  }
}

/** Scan the file once with bounded state while hashing and projecting records. */
export async function scanLogbookFileInline(
  filePath: string,
  onProgress?: (progress: LogbookScanProgress) => void,
): Promise<LogbookFileScanResult> {
  const before = await fs.stat(filePath);
  if (!before.isFile()) throw new LogbookScanNotAFileError(filePath);

  const headerDetector = new StreamingHeaderDetector();
  const contentHasher = createHash('sha256');
  let headerEnd: number | undefined;
  let bodyScanner = new StreamingBodyScanner(0, (recordsScanned) => {
    onProgress?.({ phase: 'records', recordsScanned, totalRecords: recordsScanned });
  });
  const bytesRead = await streamFile(filePath, (chunk, absoluteStart) => {
    contentHasher.update(chunk);
    if (headerEnd !== undefined) {
      bodyScanner.push(chunk, absoluteStart);
      return;
    }

    headerDetector.push(chunk, absoluteStart);
    const detectedHeaderEnd = headerDetector.finish();
    if (detectedHeaderEnd === undefined) {
      bodyScanner.push(chunk, absoluteStart);
      return;
    }

    headerEnd = detectedHeaderEnd;
    bodyScanner = new StreamingBodyScanner(headerEnd, (recordsScanned) => {
      onProgress?.({ phase: 'records', recordsScanned, totalRecords: recordsScanned });
    });
    const chunkEnd = absoluteStart + chunk.length;
    if (chunkEnd > headerEnd) {
      const localStart = Math.max(0, headerEnd - absoluteStart);
      bodyScanner.push(chunk.subarray(localStart), absoluteStart + localStart);
    }
  }, before.size, onProgress);
  const contentHash = contentHasher.digest('hex');
  const after = await fs.stat(filePath);
  if (!sameFileGeneration(before, after) || bytesRead !== after.size) {
    throw new LogbookFileChangedDuringScanError(filePath);
  }

  const headerRange = headerEnd === undefined ? undefined : makeRange(0, headerEnd);
  const scanned = bodyScanner.finish(after.size, headerRange);
  const scanHash = hashStructuralScan(scanned.scan);
  const generation = buildGenerationToken(
    after.size,
    after.mtimeMs,
    contentHash,
    scanHash,
    after.dev,
    after.ino,
  );

  return {
    generation,
    recordProjections: scanned.projections,
    scan: scanned.scan,
    warnings: scanned.warnings,
  };
}

async function streamFile(
  filePath: string,
  consume: (chunk: Buffer, absoluteStart: number) => void,
  totalBytes: number,
  onProgress?: (progress: LogbookScanProgress) => void,
): Promise<number> {
  let bytesRead = 0;
  let nextProgress = READ_PROGRESS_BYTES;
  let lastReportedBytes = -1;
  const reportRead = (reportedBytes: number) => {
    if (reportedBytes === lastReportedBytes) return;
    lastReportedBytes = reportedBytes;
    onProgress?.({ phase: 'read', bytesRead: reportedBytes, totalBytes });
  };

  // Keep the public MiB milestones, but surface smaller real read advances so
  // the worker watchdog does not mistake a slow filesystem for a stalled scan.
  for await (const value of createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    consume(chunk, bytesRead);
    bytesRead += chunk.length;
    while (bytesRead >= nextProgress) {
      reportRead(nextProgress);
      nextProgress += READ_PROGRESS_BYTES;
    }
    reportRead(bytesRead);
  }
  if (bytesRead === 0) reportRead(0);
  return bytesRead;
}

export function buildGenerationToken(
  size: number,
  mtimeMs: number,
  contentHash: string,
  scanHash: string,
  dev?: number,
  ino?: number,
): GenerationToken {
  const token = createHash('sha256')
    .update(JSON.stringify({ size, mtimeMs, dev, ino, contentHash, scanHash }))
    .digest('hex');
  return { size, mtimeMs, dev, ino, contentHash, scanHash, token };
}

export function hashStructuralScan(scan: AdifScanResult): string {
  const structural = {
    byteLength: scan.byteLength,
    headerRange: scan.headerRange,
    prefixRange: scan.prefixRange,
    records: scan.records.map(record => ({
      leadingRange: record.leadingRange,
      range: record.range,
      rawHash: record.rawHash,
      syntacticallyValid: record.syntacticallyValid,
      issues: record.issues,
    })),
    safeTrailingRange: scan.safeTrailingRange,
    incompleteTailRange: scan.incompleteTailRange,
    safeEnd: scan.safeEnd,
    issues: scan.issues,
  };
  return createHash('sha256').update(JSON.stringify(structural)).digest('hex');
}

function sameFileGeneration(
  before: { size: number; mtimeMs: number; dev: number; ino: number },
  after: { size: number; mtimeMs: number; dev: number; ino: number },
): boolean {
  return before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.dev === after.dev
    && before.ino === after.ino;
}
