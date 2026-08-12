import type { QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';

import {
  type AdifByteRange,
  type AdifScanResult,
  decodeAdifRecord,
  encodeAdifRecord,
  getLastAdifFieldValue,
  scanAdifBuffer,
} from './AdifCodec.js';

export type LogbookSegmentSource = 'tx5dr' | 'external' | 'opaque';

/** Compact per-record domain projection returned by the scan worker. */
export interface LogbookRecordProjection {
  readonly runtimeId: string;
  readonly explicitId?: string;
  readonly qso?: Readonly<QSORecord>;
}

export interface LogbookSourcePart {
  readonly kind: 'source';
  /** Byte range in the source generation used to build this document. */
  readonly range: AdifByteRange;
}

export interface LogbookBytesPart {
  readonly kind: 'bytes';
  /** Small inline content introduced by a prepared mutation. */
  readonly bytes: Buffer;
}

export type LogbookRewritePart = LogbookSourcePart | LogbookBytesPart;

export interface LogbookSourceAdapter {
  read(range: AdifByteRange): Buffer;
}

/** Memory-only adapter used by tests and import parsing. */
export class BufferLogbookSourceAdapter implements LogbookSourceAdapter {
  private readonly source: Buffer;

  constructor(source: Buffer) {
    this.source = Buffer.from(source);
  }

  read(range: AdifByteRange): Buffer {
    if (range.start < 0 || range.end < range.start || range.end > this.source.length) {
      throw new RangeError(`Source range ${range.start}:${range.end} is outside the ${this.source.length}-byte buffer`);
    }
    return Buffer.from(this.source.subarray(range.start, range.end));
  }
}

export interface LogbookDocumentSegment {
  readonly segmentId: string;
  readonly source: LogbookSegmentSource;
  /** Byte range in the logical candidate document. */
  readonly leadingRange: AdifByteRange;
  /** Byte range in the logical candidate document. */
  readonly rawRange: AdifByteRange;
  /** Original source ranges, absent when this content was introduced inline. */
  readonly leadingSourceRanges: readonly AdifByteRange[];
  readonly rawSourceRange?: AdifByteRange;
  readonly rawHash: string;
  readonly syntacticallyValid: boolean;
  readonly qso?: Readonly<QSORecord>;
}

export interface LogbookImportAppend {
  type: 'append';
  raw: Buffer;
  qso?: QSORecord;
}

export interface LogbookImportReplace {
  type: 'replace';
  id: string;
  qso: QSORecord;
}

export interface LogbookImportDelete {
  type: 'delete';
  id: string;
}

export type LogbookRewriteOperation =
  | LogbookImportAppend
  | LogbookImportReplace
  | LogbookImportDelete;

export interface PreparedAppendMutation {
  readonly kind: 'append';
  /** Exact bytes to append at the current physical EOF. */
  readonly appendBytes: Buffer;
  readonly addedIds: readonly string[];
  readonly nextDocument: LogbookDocument;
}

export interface PreparedRewriteMutation {
  readonly kind: 'rewrite';
  /** Ordered candidate content. Source ranges are copied before the atomic rename. */
  readonly rewriteParts: readonly LogbookRewritePart[];
  readonly changedIds: readonly string[];
  readonly nextDocument: LogbookDocument;
}

export type PreparedLogbookMutation = PreparedAppendMutation | PreparedRewriteMutation;

interface StoredSegment {
  segmentId: string;
  source: LogbookSegmentSource;
  explicitId?: string;
  leading: StoredPart[];
  raw: StoredPart;
  rawHash: string;
  syntacticallyValid: boolean;
  qso?: Readonly<QSORecord>;
  leadingRange: AdifByteRange;
  rawRange: AdifByteRange;
}

type StoredPart = LogbookSourcePart | LogbookBytesPart;

interface DocumentParts {
  prefix: StoredPart[];
  headerEnd?: number;
  segments: StoredSegment[];
  safeTrailing: StoredPart[];
  incompleteTail: StoredPart[];
  sourceAdapter?: LogbookSourceAdapter;
}

interface RecordFragment {
  prefix: Buffer;
  raw: Buffer;
  trailing: Buffer;
  scan: AdifScanResult['records'][number];
  fullBytes: Buffer;
}

export interface LogbookRenderOptions {
  includeIncompleteTail?: boolean;
}

function cloneQso(qso: QSORecord, id = qso.id): Readonly<QSORecord> {
  return Object.freeze({
    ...qso,
    id,
    messageHistory: Object.freeze([...(qso.messageHistory ?? [])]) as unknown as string[],
  });
}

function sourcePart(range: AdifByteRange): LogbookSourcePart {
  return Object.freeze({ kind: 'source', range: Object.freeze({ ...range }) });
}

function bytesPart(bytes: Buffer): LogbookBytesPart {
  return Object.freeze({ kind: 'bytes', bytes: Buffer.from(bytes) });
}

function partLength(part: StoredPart): number {
  return part.kind === 'source'
    ? part.range.end - part.range.start
    : part.bytes.length;
}

function partsLength(parts: readonly StoredPart[]): number {
  return parts.reduce((total, part) => total + partLength(part), 0);
}

function clonePart(part: StoredPart): StoredPart {
  return part.kind === 'source' ? sourcePart(part.range) : bytesPart(part.bytes);
}

function cloneParts(parts: readonly StoredPart[]): StoredPart[] {
  return parts.map(clonePart);
}

function cloneSegment(segment: StoredSegment): StoredSegment {
  return {
    ...segment,
    leading: cloneParts(segment.leading),
    raw: clonePart(segment.raw),
    leadingRange: { ...segment.leadingRange },
    rawRange: { ...segment.rawRange },
  };
}

function reprojectSegments(input: readonly StoredSegment[]): StoredSegment[] {
  const rawOrdinals = new Map<string, number>();
  const usedIds = new Set<string>();

  return input.map((candidate) => {
    const segment = cloneSegment(candidate);
    const ordinal = (rawOrdinals.get(segment.rawHash) ?? 0) + 1;
    rawOrdinals.set(segment.rawHash, ordinal);
    const preferredId = !segment.explicitId
      ? externalIdFor(segment.rawHash, ordinal)
      : !usedIds.has(segment.explicitId)
        ? segment.explicitId
        : duplicateIdFor(segment.rawHash, ordinal);
    const runtimeId = allocateRuntimeId(usedIds, preferredId, segment.rawHash, ordinal);
    const qso = segment.qso
      ? cloneQso(segment.qso as QSORecord, runtimeId)
      : undefined;
    if (qso) usedIds.add(qso.id);
    return {
      ...segment,
      segmentId: segmentIdFor(segment.rawHash, ordinal, qso?.id),
      source: !qso ? 'opaque' : segment.explicitId ? 'tx5dr' : 'external',
      qso,
    };
  });
}

function sourceRanges(parts: readonly StoredPart[]): readonly AdifByteRange[] {
  return Object.freeze(parts
    .filter((part): part is LogbookSourcePart => part.kind === 'source')
    .map((part) => Object.freeze({ ...part.range })));
}

function asSegmentView(segment: StoredSegment): LogbookDocumentSegment {
  return Object.freeze({
    segmentId: segment.segmentId,
    source: segment.source,
    leadingRange: Object.freeze({ ...segment.leadingRange }),
    rawRange: Object.freeze({ ...segment.rawRange }),
    leadingSourceRanges: sourceRanges(segment.leading),
    rawSourceRange: segment.raw.kind === 'source'
      ? Object.freeze({ ...segment.raw.range })
      : undefined,
    rawHash: segment.rawHash,
    syntacticallyValid: segment.syntacticallyValid,
    qso: segment.qso,
  });
}

function hashOrdinalKey(rawHash: string, ordinal: number): string {
  return `${rawHash}:${ordinal}`;
}

function segmentIdFor(rawHash: string, ordinal: number, qsoId?: string): string {
  return qsoId ? `qso:${qsoId}` : `opaque:${hashOrdinalKey(rawHash, ordinal)}`;
}

function externalIdFor(rawHash: string, ordinal: number): string {
  return `external:${hashOrdinalKey(rawHash, ordinal)}`;
}

function duplicateIdFor(rawHash: string, ordinal: number): string {
  return `duplicate:${hashOrdinalKey(rawHash, ordinal)}`;
}

function allocateRuntimeId(
  usedIds: ReadonlySet<string>,
  preferredId: string,
  rawHash: string,
  ordinal: number,
): string {
  if (!usedIds.has(preferredId)) return preferredId;
  let collision = 1;
  while (usedIds.has(`collision:${hashOrdinalKey(rawHash, ordinal)}:${collision}`)) collision += 1;
  return `collision:${hashOrdinalKey(rawHash, ordinal)}:${collision}`;
}

/**
 * Convert structural scan records into stable runtime identities and QSO DTOs.
 * Keeping this in the document layer makes worker and in-process construction
 * follow exactly the same duplicate-ID rules.
 */
export class LogbookRecordProjector {
  private readonly rawOrdinals = new Map<string, number>();
  private readonly usedQsoIds = new Set<string>();

  constructor(
    existingRecords: readonly AdifScanResult['records'][number][] = [],
    existingProjections: readonly LogbookRecordProjection[] = [],
  ) {
    if (existingRecords.length !== existingProjections.length) {
      throw new Error('Existing scan records and projections must have the same length');
    }
    for (let index = 0; index < existingRecords.length; index += 1) {
      const record = existingRecords[index]!;
      this.rawOrdinals.set(record.rawHash, (this.rawOrdinals.get(record.rawHash) ?? 0) + 1);
      const qso = existingProjections[index]!.qso;
      if (qso) this.usedQsoIds.add(qso.id);
    }
  }

  project(record: AdifScanResult['records'][number]): LogbookRecordProjection {
    const ordinal = (this.rawOrdinals.get(record.rawHash) ?? 0) + 1;
    this.rawOrdinals.set(record.rawHash, ordinal);
    const explicitId = getLastAdifFieldValue(record, 'app_tx5dr_id')?.trim() || undefined;
    const preferredId = !explicitId
      ? externalIdFor(record.rawHash, ordinal)
      : !this.usedQsoIds.has(explicitId)
        ? explicitId
        : duplicateIdFor(record.rawHash, ordinal);
    const runtimeId = allocateRuntimeId(this.usedQsoIds, preferredId, record.rawHash, ordinal);
    const decoded = decodeAdifRecord(record, runtimeId);
    if (decoded) this.usedQsoIds.add(decoded.id);
    return Object.freeze({
      runtimeId,
      explicitId,
      qso: decoded ? cloneQso(decoded) : undefined,
    });
  }
}

export function projectLogbookRecords(
  records: AdifScanResult['records'],
): readonly LogbookRecordProjection[] {
  const projector = new LogbookRecordProjector();
  return Object.freeze(records.map(record => projector.project(record)));
}

function concatenate(buffers: readonly Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  return Buffer.concat(buffers);
}

function inlinePart(bytes: Buffer): StoredPart[] {
  return bytes.length > 0 ? [bytesPart(bytes)] : [];
}

function rangedPart(range: AdifByteRange): StoredPart[] {
  return range.end > range.start ? [sourcePart(range)] : [];
}

function parseRecordFragment(rawInput: Buffer): RecordFragment {
  const fullBytes = Buffer.from(rawInput);
  const scan = scanAdifBuffer(fullBytes);
  if (scan.records.length !== 1 || scan.incompleteTailRange) {
    throw new Error('Imported raw ADIF input must contain exactly one complete record and no incomplete tail');
  }

  const record = scan.records[0]!;
  return {
    prefix: Buffer.from(fullBytes.subarray(scan.prefixRange.start, scan.prefixRange.end)),
    raw: Buffer.from(fullBytes.subarray(record.range.start, record.range.end)),
    trailing: Buffer.from(fullBytes.subarray(scan.safeTrailingRange.start, scan.safeTrailingRange.end)),
    scan: record,
    fullBytes,
  };
}

function resolvePart(part: StoredPart, adapter?: LogbookSourceAdapter): Buffer {
  if (part.kind === 'bytes') return Buffer.from(part.bytes);
  if (!adapter) {
    throw new Error('This LogbookDocument is source-backed; provide a LogbookSourceAdapter to materialize it');
  }
  const bytes = adapter.read(part.range);
  if (bytes.length !== partLength(part)) {
    throw new Error(`Source adapter returned ${bytes.length} bytes for a ${partLength(part)}-byte range`);
  }
  return bytes;
}

/**
 * Ordered, byte-preserving view of an ADIF file.
 *
 * Worker-created documents retain only source ranges and decoded QSO DTOs. A
 * prepared rewrite therefore copies untouched ranges from the current file and
 * carries inline buffers only for records introduced or changed by that mutation.
 */
export class LogbookDocument {
  readonly byteLength: number;
  readonly headerRange?: AdifByteRange;
  readonly prefixRange: AdifByteRange;
  readonly safeTrailingRange: AdifByteRange;
  readonly incompleteTailRange?: AdifByteRange;

  private readonly prefix: readonly StoredPart[];
  private readonly segments: readonly StoredSegment[];
  private readonly safeTrailing: readonly StoredPart[];
  private readonly incompleteTail: readonly StoredPart[];
  private readonly sourceAdapter?: LogbookSourceAdapter;
  private readonly segmentViews: readonly LogbookDocumentSegment[];
  private readonly qsoById: ReadonlyMap<string, Readonly<QSORecord>>;
  private readonly segmentsByQsoId: ReadonlyMap<string, LogbookDocumentSegment>;
  private readonly qsosByCallsign: ReadonlyMap<string, readonly Readonly<QSORecord>[]>;
  private readonly workedCallsignBands: ReadonlySet<string>;

  private constructor(parts: DocumentParts) {
    this.prefix = Object.freeze(cloneParts(parts.prefix));
    this.safeTrailing = Object.freeze(cloneParts(parts.safeTrailing));
    this.incompleteTail = Object.freeze(cloneParts(parts.incompleteTail));
    this.sourceAdapter = parts.sourceAdapter;

    let offset = partsLength(this.prefix);
    const laidOutSegments = parts.segments.map((input) => {
      const segment = cloneSegment(input);
      const leadingLength = partsLength(segment.leading);
      segment.leadingRange = { start: offset, end: offset + leadingLength };
      offset = segment.leadingRange.end;
      segment.rawRange = { start: offset, end: offset + partLength(segment.raw) };
      offset = segment.rawRange.end;
      return segment;
    });
    this.segments = Object.freeze(laidOutSegments);

    this.prefixRange = Object.freeze({ start: 0, end: partsLength(this.prefix) });
    this.headerRange = parts.headerEnd === undefined
      ? undefined
      : Object.freeze({ start: 0, end: parts.headerEnd });
    this.safeTrailingRange = Object.freeze({ start: offset, end: offset + partsLength(this.safeTrailing) });
    offset = this.safeTrailingRange.end;
    this.incompleteTailRange = partsLength(this.incompleteTail) > 0
      ? Object.freeze({ start: offset, end: offset + partsLength(this.incompleteTail) })
      : undefined;
    this.byteLength = offset + partsLength(this.incompleteTail);

    this.segmentViews = Object.freeze(this.segments.map(asSegmentView));

    const qsoById = new Map<string, Readonly<QSORecord>>();
    const segmentsByQsoId = new Map<string, LogbookDocumentSegment>();
    const qsosByCallsign = new Map<string, Readonly<QSORecord>[]>();
    const workedCallsignBands = new Set<string>();

    for (let index = 0; index < this.segments.length; index += 1) {
      const segment = this.segments[index]!;
      const qso = segment.qso;
      if (!qso) continue;
      if (qsoById.has(qso.id)) {
        throw new Error(`Duplicate runtime QSO ID in LogbookDocument: ${qso.id}`);
      }
      qsoById.set(qso.id, qso);
      segmentsByQsoId.set(qso.id, this.segmentViews[index]!);

      const callsign = qso.callsign.trim().toUpperCase();
      const callsignRecords = qsosByCallsign.get(callsign) ?? [];
      callsignRecords.push(qso);
      qsosByCallsign.set(callsign, callsignRecords);
      workedCallsignBands.add(`${callsign}\u0000${getBandFromFrequency(qso.frequency)}`);
    }

    for (const records of qsosByCallsign.values()) Object.freeze(records);
    this.qsoById = qsoById;
    this.segmentsByQsoId = segmentsByQsoId;
    this.qsosByCallsign = qsosByCallsign;
    this.workedCallsignBands = workedCallsignBands;
  }

  /** Build the normal runtime form directly from a worker scan, without raw file bytes. */
  static fromScan(
    scan: AdifScanResult,
    projections?: readonly LogbookRecordProjection[],
  ): LogbookDocument {
    return LogbookDocument.fromScanInternal(scan, undefined, projections);
  }

  /** Build the memory-backed convenience form used by tests/import/migration. */
  static fromBuffer(source: Buffer, scan = scanAdifBuffer(source)): LogbookDocument {
    if (scan.byteLength !== source.length) {
      throw new Error('ADIF scan byte length does not match the source buffer');
    }
    return LogbookDocument.fromScanInternal(scan, new BufferLogbookSourceAdapter(source));
  }

  private static fromScanInternal(
    scan: AdifScanResult,
    sourceAdapter?: LogbookSourceAdapter,
    suppliedProjections?: readonly LogbookRecordProjection[],
  ): LogbookDocument {
    if (suppliedProjections && suppliedProjections.length !== scan.records.length) {
      throw new Error('ADIF scan record projection count does not match the structural scan');
    }
    const projections = suppliedProjections ?? projectLogbookRecords(scan.records);
    const rawOrdinals = new Map<string, number>();

    const segments = scan.records.map((record, index) => {
      const ordinal = (rawOrdinals.get(record.rawHash) ?? 0) + 1;
      rawOrdinals.set(record.rawHash, ordinal);
      const projection = projections[index]!;
      const explicitId = projection.explicitId;
      const decoded = projection.qso;
      const sourceKind: LogbookSegmentSource = !decoded
        ? 'opaque'
        : explicitId
          ? 'tx5dr'
          : 'external';

      return {
        segmentId: segmentIdFor(record.rawHash, ordinal, decoded?.id),
        source: sourceKind,
        explicitId,
        leading: rangedPart(record.leadingRange),
        raw: sourcePart(record.range),
        rawHash: record.rawHash,
        syntacticallyValid: record.syntacticallyValid,
        qso: decoded ? cloneQso(decoded) : undefined,
        leadingRange: { ...record.leadingRange },
        rawRange: { ...record.range },
      };
    });

    return new LogbookDocument({
      prefix: rangedPart(scan.prefixRange),
      headerEnd: scan.headerRange?.end,
      segments,
      safeTrailing: rangedPart(scan.safeTrailingRange),
      incompleteTail: scan.incompleteTailRange ? rangedPart(scan.incompleteTailRange) : [],
      sourceAdapter,
    });
  }

  getSegments(): readonly LogbookDocumentSegment[] {
    return this.segmentViews;
  }

  getOpaqueSegments(): readonly LogbookDocumentSegment[] {
    return this.segmentViews.filter((segment) => !segment.qso);
  }

  getQsoRecords(): readonly Readonly<QSORecord>[] {
    return [...this.qsoById.values()];
  }

  getQso(id: string): Readonly<QSORecord> | undefined {
    return this.qsoById.get(id);
  }

  getSegmentForQso(id: string): LogbookDocumentSegment | undefined {
    return this.segmentsByQsoId.get(id);
  }

  findByCallsign(callsign: string): readonly Readonly<QSORecord>[] {
    return this.qsosByCallsign.get(callsign.trim().toUpperCase()) ?? [];
  }

  getLastQsoWithCallsign(callsign: string): Readonly<QSORecord> | undefined {
    const records = this.findByCallsign(callsign);
    let latest: Readonly<QSORecord> | undefined;
    for (const record of records) {
      if (!latest || record.startTime > latest.startTime) latest = record;
    }
    return latest;
  }

  hasWorkedCallsign(callsign: string, band?: string): boolean {
    const normalizedCallsign = callsign.trim().toUpperCase();
    if (!band) return (this.qsosByCallsign.get(normalizedCallsign)?.length ?? 0) > 0;
    return this.workedCallsignBands.has(`${normalizedCallsign}\u0000${band}`);
  }

  hasIncompleteTail(): boolean {
    return partsLength(this.incompleteTail) > 0;
  }

  isSourceBacked(): boolean {
    return this.sourceAdapter === undefined;
  }

  getRawRecord(segmentId: string, adapter = this.sourceAdapter): Buffer | undefined {
    const segment = this.segments.find((candidate) => candidate.segmentId === segmentId);
    return segment ? resolvePart(segment.raw, adapter) : undefined;
  }

  /** Return ordered source-copy and inline-byte parts without materializing source ranges. */
  getContentParts(options: LogbookRenderOptions = {}): readonly LogbookRewritePart[] {
    const parts: StoredPart[] = [...this.prefix];
    for (const segment of this.segments) parts.push(...segment.leading, segment.raw);
    parts.push(...this.safeTrailing);
    if (options.includeIncompleteTail !== false) parts.push(...this.incompleteTail);
    return Object.freeze(parts.map(clonePart));
  }

  *renderChunks(
    options: LogbookRenderOptions = {},
    adapter = this.sourceAdapter,
  ): Iterable<Buffer> {
    for (const part of this.getContentParts(options)) yield resolvePart(part, adapter);
  }

  toBuffer(options: LogbookRenderOptions = {}, adapter = this.sourceAdapter): Buffer {
    return concatenate([...this.renderChunks(options, adapter)]);
  }

  prepareAppend(qso: QSORecord): PreparedAppendMutation {
    if (this.qsoById.has(qso.id)) throw new Error(`QSO with id ${qso.id} already exists`);
    return this.prepareAppendInputs([{ type: 'append', qso, raw: encodeAdifRecord(qso) }]);
  }

  prepareUpdate(id: string, updates: Partial<QSORecord>): PreparedRewriteMutation {
    const existing = this.qsoById.get(id);
    if (!existing) throw new Error(`QSO with id ${id} not found`);
    const qso = cloneQso({ ...existing, ...updates, id } as QSORecord, id) as QSORecord;
    return this.prepareRewrite([{ type: 'replace', id, qso }]);
  }

  prepareDelete(id: string): PreparedRewriteMutation {
    if (!this.qsoById.has(id)) throw new Error(`QSO with id ${id} not found`);
    return this.prepareRewrite([{ type: 'delete', id }]);
  }

  /** Pure additions remain append mutations; any replacement/deletion becomes one rewrite. */
  prepareImport(operations: readonly LogbookRewriteOperation[]): PreparedLogbookMutation {
    if (operations.every((operation) => operation.type === 'append')) {
      return this.prepareAppendInputs(operations as readonly LogbookImportAppend[]);
    }
    return this.prepareRewrite(operations);
  }

  prepareRewrite(operations: readonly LogbookRewriteOperation[]): PreparedRewriteMutation {
    this.assertMutationSafe();
    let segments = this.segments.map(cloneSegment);
    let safeTrailing = cloneParts(this.safeTrailing);
    const changedIds: string[] = [];

    for (const operation of operations) {
      if (operation.type === 'delete') {
        const index = segments.findIndex((segment) => segment.qso?.id === operation.id);
        if (index < 0) throw new Error(`QSO with id ${operation.id} not found`);
        segments.splice(index, 1);
        changedIds.push(operation.id);
        continue;
      }

      if (operation.type === 'replace') {
        const index = segments.findIndex((segment) => segment.qso?.id === operation.id);
        if (index < 0) throw new Error(`QSO with id ${operation.id} not found`);
        const replacementId = operation.qso.id?.trim() || operation.id;
        if (
          replacementId !== operation.id
          && segments.some(segment => segment.qso?.id === replacementId)
        ) {
          throw new Error(`QSO with id ${replacementId} already exists`);
        }
        const replacement = { ...operation.qso, id: replacementId };
        const fragment = parseRecordFragment(encodeAdifRecord(replacement));
        const previous = segments[index]!;
        const nextSegment = segments[index + 1];
        if (fragment.trailing.length > 0) {
          if (nextSegment && partsLength(nextSegment.leading) === 0) {
            nextSegment.leading = inlinePart(fragment.trailing);
          } else if (!nextSegment && partsLength(safeTrailing) === 0) {
            safeTrailing = inlinePart(fragment.trailing);
          }
        }
        segments[index] = {
          ...previous,
          source: 'tx5dr',
          explicitId: replacementId,
          raw: bytesPart(fragment.raw),
          rawHash: fragment.scan.rawHash,
          syntacticallyValid: fragment.scan.syntacticallyValid,
          qso: cloneQso(replacement, replacementId),
        };
        changedIds.push(operation.id);
        if (replacementId !== operation.id) changedIds.push(replacementId);
        continue;
      }

      const appended = this.appendFragments(segments, safeTrailing, [operation]);
      segments = appended.segments;
      safeTrailing = appended.safeTrailing;
      changedIds.push(...appended.addedIds);
    }

    const nextDocument = this.withParts(segments, safeTrailing);
    return Object.freeze({
      kind: 'rewrite',
      rewriteParts: nextDocument.getContentParts({ includeIncompleteTail: false }),
      changedIds: Object.freeze(changedIds),
      nextDocument,
    });
  }

  private prepareAppendInputs(inputs: readonly LogbookImportAppend[]): PreparedAppendMutation {
    this.assertMutationSafe();
    if (inputs.length === 0) {
      return Object.freeze({
        kind: 'append',
        appendBytes: Buffer.alloc(0),
        addedIds: Object.freeze([]),
        nextDocument: this,
      });
    }

    const segments = this.segments.map(cloneSegment);
    const appended = this.appendFragments(segments, cloneParts(this.safeTrailing), inputs);
    const nextDocument = this.withParts(appended.segments, appended.safeTrailing);
    return Object.freeze({
      kind: 'append',
      appendBytes: concatenate(inputs.map((input) => Buffer.from(input.raw))),
      addedIds: Object.freeze(appended.addedIds),
      nextDocument,
    });
  }

  private appendFragments(
    initialSegments: StoredSegment[],
    initialSafeTrailing: StoredPart[],
    inputs: readonly LogbookImportAppend[],
  ): { segments: StoredSegment[]; safeTrailing: StoredPart[]; addedIds: string[] } {
    const segments = initialSegments;
    let safeTrailing = initialSafeTrailing;
    const addedIds: string[] = [];
    const rawOrdinals = new Map<string, number>();
    const usedIds = new Set(this.qsoById.keys());
    for (const segment of segments) {
      rawOrdinals.set(segment.rawHash, (rawOrdinals.get(segment.rawHash) ?? 0) + 1);
      if (segment.qso) usedIds.add(segment.qso.id);
    }

    for (const input of inputs) {
      const fragment = parseRecordFragment(input.raw);
      const ordinal = (rawOrdinals.get(fragment.scan.rawHash) ?? 0) + 1;
      rawOrdinals.set(fragment.scan.rawHash, ordinal);
      const explicitId = getLastAdifFieldValue(fragment.scan, 'app_tx5dr_id')?.trim();
      const preferredId = !explicitId
        ? externalIdFor(fragment.scan.rawHash, ordinal)
        : !usedIds.has(explicitId)
          ? explicitId
          : duplicateIdFor(fragment.scan.rawHash, ordinal);
      const runtimeId = allocateRuntimeId(usedIds, preferredId, fragment.scan.rawHash, ordinal);

      const decoded = input.qso
        ? cloneQso(input.qso, runtimeId)
        : decodeAdifRecord(fragment.scan, runtimeId);
      if (decoded && usedIds.has(decoded.id)) throw new Error(`QSO with id ${decoded.id} already exists`);
      if (decoded) {
        usedIds.add(decoded.id);
        addedIds.push(decoded.id);
      }

      const leading = [...safeTrailing, ...inlinePart(fragment.prefix)];
      segments.push({
        segmentId: segmentIdFor(fragment.scan.rawHash, ordinal, decoded?.id),
        source: !decoded ? 'opaque' : explicitId ? 'tx5dr' : 'external',
        explicitId: explicitId || undefined,
        leading,
        raw: bytesPart(fragment.raw),
        rawHash: fragment.scan.rawHash,
        syntacticallyValid: fragment.scan.syntacticallyValid,
        qso: decoded ? cloneQso(decoded as QSORecord) : undefined,
        leadingRange: { start: 0, end: 0 },
        rawRange: { start: 0, end: 0 },
      });
      safeTrailing = inlinePart(fragment.trailing);
    }

    return { segments, safeTrailing, addedIds };
  }

  private withParts(segments: StoredSegment[], safeTrailing: StoredPart[]): LogbookDocument {
    return new LogbookDocument({
      prefix: cloneParts(this.prefix),
      headerEnd: this.headerRange?.end,
      segments: reprojectSegments(segments),
      safeTrailing,
      incompleteTail: cloneParts(this.incompleteTail),
      sourceAdapter: this.sourceAdapter,
    });
  }

  private assertMutationSafe(): void {
    if (partsLength(this.incompleteTail) > 0) {
      throw new Error('Cannot mutate an ADIF document until its incomplete tail has been recovered');
    }
  }
}
