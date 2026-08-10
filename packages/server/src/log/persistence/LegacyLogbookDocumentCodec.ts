import { type QSORecord } from '@tx5dr/contracts';

import {
  decodeAdifRecord,
  encodeAdifHeader,
  encodeAdifRecord,
  scanAdifBuffer,
} from './AdifCodec.js';
import {
  LogbookDocument,
  type PreparedLogbookMutation,
} from './LogbookDocument.js';
import type {
  LegacyCandidateValidation,
  LegacyDecodedSnapshot,
  LegacyLogbookMigrationCodec,
  LegacyRecordMatch,
} from './LegacyLogbookMigrator.js';

export type LegacyQsoRecord = QSORecord & Record<string, unknown>;

/** Mutable shell used only while replaying one legacy migration transaction set. */
export interface LegacyMutableLogbookDocument {
  document: LogbookDocument;
  /** Migration-only aliases from legacy fallback ids to current runtime ids. */
  aliases: Map<string, Set<string>>;
}

function addAlias(document: LegacyMutableLogbookDocument, alias: string, targetId: string): void {
  const targets = document.aliases.get(alias) ?? new Set<string>();
  targets.add(targetId);
  document.aliases.set(alias, targets);
}

function matchingIds(document: LegacyMutableLogbookDocument, id: string): string[] {
  const matches = new Set(document.document.getSegments()
    .filter(segment => segment.qso?.id === id)
    .map(segment => segment.qso!.id));
  for (const targetId of document.aliases.get(id) ?? []) {
    if (document.document.getQso(targetId) !== undefined) matches.add(targetId);
  }
  return [...matches];
}

function uniqueMatchingId(document: LegacyMutableLogbookDocument, id: string): string | undefined {
  const matches = matchingIds(document, id);
  return matches.length === 1 ? matches[0] : undefined;
}

function retargetAliases(
  document: LegacyMutableLogbookDocument,
  previousId: string,
  nextId?: string,
): void {
  for (const [alias, targets] of document.aliases) {
    if (!targets.delete(previousId)) continue;
    if (nextId) targets.add(nextId);
    if (targets.size === 0) document.aliases.delete(alias);
  }
}

function asCompleteRecord(rawLine: string): Buffer {
  const bytes = Buffer.from(rawLine, 'utf8');
  const scan = scanAdifBuffer(bytes);
  if (scan.records.length !== 1 || scan.incompleteTailRange) {
    throw new Error('Legacy raw ADIF payload is not exactly one complete record');
  }
  return bytes.at(-1) === 0x0a ? bytes : Buffer.concat([bytes, Buffer.from('\n')]);
}

function committedDocument(mutation: PreparedLogbookMutation): LogbookDocument {
  return mutation.nextDocument;
}

function sameRecord(left: QSORecord, right: QSORecord): boolean {
  return encodeAdifRecord(left).equals(encodeAdifRecord(right));
}

function sameRecordIgnoringRuntimeId(left: QSORecord, right: QSORecord): boolean {
  return sameRecord({ ...left, id: right.id }, right);
}

/** Bridges the generic legacy replay engine to the byte-preserving domain model. */
export class LegacyLogbookDocumentCodec implements LegacyLogbookMigrationCodec<
  LegacyMutableLogbookDocument,
  LegacyQsoRecord
> {
  constructor(private readonly onRecordsScanned?: (recordsScanned: number) => void) {}

  async decodeSnapshot(
    data: Buffer,
    _sourcePath: string,
  ): Promise<LegacyDecodedSnapshot<LegacyMutableLogbookDocument>> {
    const scan = scanAdifBuffer(data, this.onRecordsScanned);
    const hasSafeBaseline = data.length === 0
      || scan.headerRange !== undefined
      || scan.records.length > 0;
    const health = !hasSafeBaseline
      ? 'invalid'
      : scan.incompleteTailRange
        ? 'salvageable'
        : 'healthy';

    const document: LegacyMutableLogbookDocument = {
      document: LogbookDocument.fromBuffer(data, scan),
      aliases: new Map(),
    };
    const segments = document.document.getSegments();
    for (let index = 0; index < scan.records.length; index += 1) {
      const targetId = segments[index]?.qso?.id;
      const legacyRecord = decodeAdifRecord(scan.records[index]!);
      if (targetId && legacyRecord) addAlias(document, legacyRecord.id, targetId);
    }

    return {
      health,
      document,
      recordCount: scan.records.length,
      trailingPartial: scan.incompleteTailRange !== undefined,
      reason: health === 'invalid' ? 'No complete ADIF header or record could be recovered' : undefined,
    };
  }

  createEmptyDocument(): LegacyMutableLogbookDocument {
    return { document: LogbookDocument.fromBuffer(encodeAdifHeader()), aliases: new Map() };
  }

  cloneDocument(document: LegacyMutableLogbookDocument): LegacyMutableLogbookDocument {
    return {
      document: document.document,
      aliases: new Map([...document.aliases].map(([alias, targets]) => [alias, new Set(targets)])),
    };
  }

  getRecordMatch(document: LegacyMutableLogbookDocument, id: string): LegacyRecordMatch {
    const matches = matchingIds(document, id).length;
    return matches === 0 ? 'missing' : matches === 1 ? 'unique' : 'ambiguous';
  }

  associateRecordByRaw(
    document: LegacyMutableLogbookDocument,
    id: string,
    rawLine: string,
  ): LegacyRecordMatch {
    let candidateHash: string;
    try {
      const candidate = LogbookDocument.fromBuffer(asCompleteRecord(rawLine)).getSegments()[0];
      if (!candidate) return 'missing';
      candidateHash = candidate.rawHash;
    } catch {
      return 'missing';
    }

    const targetIds = new Set(document.document.getSegments()
      .filter(segment => segment.rawHash === candidateHash && segment.qso)
      .map(segment => segment.qso!.id));
    if (targetIds.size !== 1) return targetIds.size === 0 ? 'missing' : 'ambiguous';

    addAlias(document, id, [...targetIds][0]!);
    return this.getRecordMatch(document, id);
  }

  isRecordEquivalent(
    document: LegacyMutableLogbookDocument,
    id: string,
    record: LegacyQsoRecord,
  ): boolean {
    const targetId = uniqueMatchingId(document, id);
    const existing = targetId ? document.document.getQso(targetId) : undefined;
    return existing !== undefined && sameRecordIgnoringRuntimeId(existing as QSORecord, record);
  }

  replaceRecordInPlace(
    document: LegacyMutableLogbookDocument,
    id: string,
    record: LegacyQsoRecord,
    _rawLine?: string,
  ): boolean {
    const targetId = uniqueMatchingId(document, id);
    if (!targetId) return false;
    const replacement = {
      ...record,
      id: record.id,
      messageHistory: [...(record.messageHistory ?? [])],
    };
    document.document = document.document.prepareRewrite([{
      type: 'replace',
      id: targetId,
      qso: replacement,
    }]).nextDocument;
    retargetAliases(document, targetId, replacement.id);
    addAlias(document, id, replacement.id);
    return true;
  }

  appendRecord(
    document: LegacyMutableLogbookDocument,
    record: LegacyQsoRecord,
    rawLine?: string,
  ): void {
    const normalized = {
      ...record,
      messageHistory: [...(record.messageHistory ?? [])],
    };
    const raw = rawLine ? asCompleteRecord(rawLine) : encodeAdifRecord(normalized);
    const beforeCount = document.document.getSegments().length;
    document.document = committedDocument(document.document.prepareImport([{
      type: 'append',
      raw,
      qso: normalized,
    }]));
    const appended = document.document.getSegments()[beforeCount];
    if (appended?.qso) addAlias(document, record.id, appended.qso.id);
  }

  removeRecord(document: LegacyMutableLogbookDocument, id: string): number {
    const targetId = uniqueMatchingId(document, id);
    if (!targetId) return 0;
    document.document = document.document.prepareDelete(targetId).nextDocument;
    retargetAliases(document, targetId);
    return 1;
  }

  containsRaw(document: LegacyMutableLogbookDocument, rawLine: string): boolean {
    const raw = asCompleteRecord(rawLine);
    const candidate = LogbookDocument.fromBuffer(raw).getSegments()[0];
    return candidate !== undefined
      && document.document.getSegments().some(segment => segment.rawHash === candidate.rawHash);
  }

  appendRaw(document: LegacyMutableLogbookDocument, rawLine: string): void {
    document.document = committedDocument(document.document.prepareImport([{
      type: 'append',
      raw: asCompleteRecord(rawLine),
    }]));
  }

  async encodeDocument(document: LegacyMutableLogbookDocument): Promise<Buffer> {
    return document.document.toBuffer({ includeIncompleteTail: false });
  }

  async validateCandidate(
    data: Buffer,
    expectedDocument: LegacyMutableLogbookDocument,
  ): Promise<LegacyCandidateValidation> {
    const scan = scanAdifBuffer(data, this.onRecordsScanned);
    if (scan.incompleteTailRange) {
      return { valid: false, reason: 'Candidate has an incomplete ADIF tail' };
    }

    const actual = LogbookDocument.fromBuffer(data, scan).getSegments();
    const expected = expectedDocument.document.getSegments();
    if (actual.length !== expected.length) {
      return { valid: false, reason: `Expected ${expected.length} segments, found ${actual.length}` };
    }

    for (let index = 0; index < expected.length; index += 1) {
      const left = expected[index]!;
      const right = actual[index]!;
      if (left.rawHash !== right.rawHash || left.qso?.id !== right.qso?.id) {
        return { valid: false, reason: `Segment ${index} differs from the prepared migration document` };
      }
    }
    return { valid: true };
  }
}
