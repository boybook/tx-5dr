import { createHash } from 'node:crypto';

import type { LegacyLogbookFileStore } from './LegacyLogbookFileStore.js';
import type { LegacyLogbookArtifact } from './legacyLogbookArtifacts.js';

export type LegacyJournalOperation = 'add' | 'update' | 'delete' | 'import';

export interface LegacyJournalEntry<RecordType extends { id: string }> {
  txId: string;
  timestamp: number;
  operation: LegacyJournalOperation;
  payload: Record<string, unknown> & { record?: RecordType };
  checksum: string;
}

export interface LegacyJournalTransaction<RecordType extends { id: string }> {
  entry: LegacyJournalEntry<RecordType>;
  sourcePath: string;
  line: number;
  sourceOrder: number;
}

export interface LegacyJournalIssue {
  code: string;
  path: string;
  line?: number;
  message: string;
}

export interface LegacyJournalReadResult<RecordType extends { id: string }> {
  transactions: LegacyJournalTransaction<RecordType>[];
  /** Entries that passed JSON, schema, and checksum validation before txId deduplication. */
  verifiedTransactionCount: number;
  issues: LegacyJournalIssue[];
  sourceSha256: Map<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRecordId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === 'string' && value.id.length > 0;
}

function isImportOperation(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.type !== 'string') return false;
  if (value.type === 'add' || value.type === 'update') return hasRecordId(value.record);
  if (value.type === 'delete') return typeof value.id === 'string' && value.id.length > 0;
  if (value.type === 'raw') return typeof value.rawLine === 'string';
  return false;
}

function validatePayload(operation: LegacyJournalOperation, payload: Record<string, unknown>): boolean {
  if (operation === 'add' || operation === 'update') return hasRecordId(payload.record);
  if (operation === 'delete') return typeof payload.id === 'string' && payload.id.length > 0;
  return Array.isArray(payload.operations) && payload.operations.every(isImportOperation);
}

function parseEntry<RecordType extends { id: string }>(
  line: string,
): LegacyJournalEntry<RecordType> | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;

  const operation = value.operation;
  if (operation !== 'add' && operation !== 'update' && operation !== 'delete' && operation !== 'import') {
    return null;
  }
  if (typeof value.txId !== 'string' || value.txId.length === 0) return null;
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return null;
  if (!isPlainObject(value.payload) || !validatePayload(operation, value.payload)) return null;
  if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum)) return null;

  const { checksum, ...withoutChecksum } = value;
  const expected = createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
  if (checksum !== expected) return null;
  return value as unknown as LegacyJournalEntry<RecordType>;
}

function artifactReplayOrder(left: LegacyLogbookArtifact, right: LegacyLogbookArtifact): number {
  const leftTime = left.journalStream === 'archive' ? (left.archiveAtMs ?? left.mtimeMs) : Number.MAX_SAFE_INTEGER;
  const rightTime = right.journalStream === 'archive' ? (right.archiveAtMs ?? right.mtimeMs) : Number.MAX_SAFE_INTEGER;
  const leftFamily = left.journalFamily === 'adi-prefixed' ? 0 : 1;
  const rightFamily = right.journalFamily === 'adi-prefixed' ? 0 : 1;
  return leftTime - rightTime
    || leftFamily - rightFamily
    || left.name.localeCompare(right.name);
}

export async function readLegacyJournalTransactions<RecordType extends { id: string }>(
  artifacts: LegacyLogbookArtifact[],
  fileStore: LegacyLogbookFileStore,
): Promise<LegacyJournalReadResult<RecordType>> {
  const issues: LegacyJournalIssue[] = [];
  const sourceSha256 = new Map<string, string>();
  const parsed: LegacyJournalTransaction<RecordType>[] = [];
  const orderedArtifacts = [...artifacts].sort(artifactReplayOrder);

  for (let sourceOrder = 0; sourceOrder < orderedArtifacts.length; sourceOrder += 1) {
    const artifact = orderedArtifacts[sourceOrder];
    let data: Buffer;
    try {
      data = await fileStore.readFile(artifact.path);
    } catch (error) {
      issues.push({ code: 'JOURNAL_READ_FAILED', path: artifact.path, message: (error as Error).message });
      continue;
    }
    sourceSha256.set(artifact.path, createHash('sha256').update(data).digest('hex'));

    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < data.length - 1) {
      issues.push({
        code: 'JOURNAL_PARTIAL_TAIL_SKIPPED',
        path: artifact.path,
        message: 'The non-newline-terminated journal tail was not durable and was skipped',
      });
    }
    if (lastNewline < 0) continue;

    const lines = data.subarray(0, lastNewline + 1).toString('utf8').split('\n');
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const entry = parseEntry<RecordType>(line);
      if (!entry) {
        issues.push({
          code: 'JOURNAL_LINE_INVALID',
          path: artifact.path,
          line: index + 1,
          message: 'Journal JSON, schema, or checksum validation failed',
        });
        continue;
      }
      parsed.push({ entry, sourcePath: artifact.path, line: index + 1, sourceOrder });
    }
  }

  const byTxId = new Map<string, LegacyJournalTransaction<RecordType>>();
  const conflicts = new Set<string>();
  for (const transaction of parsed) {
    const existing = byTxId.get(transaction.entry.txId);
    if (!existing) {
      if (!conflicts.has(transaction.entry.txId)) byTxId.set(transaction.entry.txId, transaction);
      continue;
    }
    if (existing.entry.checksum === transaction.entry.checksum) {
      issues.push({
        code: 'JOURNAL_TX_DUPLICATE_SKIPPED',
        path: transaction.sourcePath,
        line: transaction.line,
        message: `Duplicate transaction ${transaction.entry.txId} was skipped`,
      });
      continue;
    }

    byTxId.delete(transaction.entry.txId);
    conflicts.add(transaction.entry.txId);
    issues.push({
      code: 'JOURNAL_TX_CONFLICT_SKIPPED',
      path: transaction.sourcePath,
      line: transaction.line,
      message: `Conflicting payloads share transaction id ${transaction.entry.txId}`,
    });
  }

  const transactions = [...byTxId.values()].sort((left, right) => (
    left.sourceOrder - right.sourceOrder
    || left.line - right.line
    || left.entry.txId.localeCompare(right.entry.txId)
  ));
  return {
    transactions,
    verifiedTransactionCount: parsed.length,
    issues,
    sourceSha256,
  };
}
