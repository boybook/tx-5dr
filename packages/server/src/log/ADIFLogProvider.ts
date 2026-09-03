import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
  ContestQsoEnvelope,
  LogBookDxccSummary,
  LogBookImportResult,
  LogbookBackupStatus,
  LogbookHealth,
  LogbookHealthIssue,
  LogbookRestorePreflight,
  QSORecord,
} from '@tx5dr/contracts';
import {
  type CallsignAnalysis,
  type ILogProvider,
  type LogbookBatchMutation,
  type LogbookBatchOutcome,
  type LogbookBatchOptions,
  type LogbookBatchResult,
  type LogbookQsoSnapshot,
  type LogbookWriteFailure,
  LogbookOperationError,
  type LogQueryOptions,
  type LogStatistics,
} from '@tx5dr/core';
import { resolveQsoComment } from '@tx5dr/plugin-api';

import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';
import { MutationBlockedError, PersistenceCoordinator } from '../utils/persistence/index.js';
import {
  buildImportedQsoFingerprint,
  parseTx5drCsvContent,
} from './logImportUtils.js';
import {
  LogbookRecordService,
  mergeImportedQso,
  normalizeQsoForPersistence,
} from './LogbookRecordService.js';
import {
  AdifBackupService,
  generationRevision,
  type AdifBackupServiceOptions,
  type BackupDownload,
  LogbookBackupError,
} from './backup/AdifBackupService.js';
import {
  decodeAdifRecord,
  encodeAdifHeader,
  encodeAdifRecord,
  scanAdifBuffer,
  type AdifScanResult,
} from './persistence/AdifCodec.js';
import {
  AdifFileCommitError,
  AdifFileStateUncertainError,
  AdifFileStore,
  AdifFileStoreReadOnlyError,
  AdifGenerationConflictError,
  type AdifFileStoreOptions,
  type AdifFileStoreHealth,
  type AdifFileStoreIssue,
  type OpenResult,
} from './persistence/AdifFileStore.js';
import {
  BufferLogbookSourceAdapter,
  LogbookDocument,
  type LogbookRecordProjection,
  type LogbookRewriteOperation,
  type PreparedLogbookMutation,
} from './persistence/LogbookDocument.js';
import type { GenerationToken } from './persistence/LogbookScanTypes.js';

const logger = createLogger('ADIFLogProvider');

export interface ADIFLogProviderOptions {
  logBookId?: string;
  logFilePath?: string;
  autoCreateFile?: boolean;
  logFileName?: string;
  /** Test seam; production always uses the isolated worker-backed store. */
  fileStoreFactory?: (filePath: string, options: AdifFileStoreOptions) => AdifFileStore;
  /** Test seam; production uses the isolated worker-backed backup service. */
  backupServiceFactory?: (
    logBookId: string,
    filePath: string,
    store: AdifFileStore,
    options: AdifBackupServiceOptions,
  ) => AdifBackupService;
}

interface ImportCandidate {
  qso?: QSORecord;
  raw: Buffer;
}

interface WorkingImportRecord {
  record: QSORecord;
  operationIndex: number;
  targetId?: string;
  canonicalId?: string;
}

interface WorkingBatchOutcome {
  inputIndex: number;
  status: LogbookBatchOutcome['status'];
  targetId: string;
}

function initialHealth(): LogbookHealth {
  return {
    state: 'loading',
    readable: false,
    writable: false,
    issues: [],
    updatedAt: Date.now(),
  };
}

function cloneRecord(record: Readonly<QSORecord>): QSORecord {
  return {
    ...record,
    messageHistory: [...record.messageHistory],
    contestEntry: cloneContestEntry(record.contestEntry),
  };
}

function cloneContestEntry(
  entry: Readonly<ContestQsoEnvelope> | undefined,
): ContestQsoEnvelope | undefined {
  return entry ? {
    ...entry,
    sent: { ...entry.sent },
    received: { ...entry.received },
    annotations: entry.annotations ? { ...entry.annotations } : undefined,
  } : undefined;
}

function cloneHealth(health: LogbookHealth): LogbookHealth {
  return {
    ...health,
    issues: health.issues.map(issue => ({ ...issue })),
  };
}

function qsoRecordsEqual(left: Readonly<QSORecord>, right: Readonly<QSORecord>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof QSORecord>);
  for (const key of keys) {
    // Enrichment refreshes this diagnostic timestamp even when persisted QSO data is unchanged.
    if (key === 'dxccResolvedAt') continue;
    const leftValue = left[key];
    const rightValue = right[key];
    if (!isDeepStrictEqual(leftValue, rightValue)) return false;
  }
  return true;
}

function issueKey(issue: LogbookHealthIssue): string {
  return `${issue.code}\u0000${issue.message}\u0000${issue.recoveryFileName ?? ''}`;
}

function dedupeIssues(issues: readonly LogbookHealthIssue[]): LogbookHealthIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function storeIssue(issue: AdifFileStoreIssue): LogbookHealthIssue {
  const issueFileName = issue.path ? path.basename(issue.path) : undefined;
  return {
    code: issue.code,
    message: issue.message,
    affectedBytes: issue.affectedBytes,
    // Store diagnostics usually point at the formal ADIF or its directory.
    // Only the fixed adjacent rewrite candidate is a user-recoverable artifact.
    recoveryFileName: issueFileName?.endsWith('.rewrite.tmp') ? issueFileName : undefined,
    occurredAt: Date.now(),
  };
}

function systemErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let domainCode: string | undefined;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) {
        if (!code.startsWith('ADIF_') && !code.startsWith('LOGBOOK_')) return code;
        domainCode ??= code;
      }
    }
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return domainCode;
}

function substantiveFilter(options?: LogQueryOptions): boolean {
  if (!options) return false;
  return Boolean(
    options.callsign
    || options.grid
    || options.frequencyRange
    || options.timeRange
    || options.mode
    || options.band
    || options.dxccStatus
    || options.qslFlow
    || options.excludeModes?.length
    || options.qslStatus
    || options.limit !== undefined
    || options.offset !== undefined,
  );
}

function escapeCsvField(value: string): string {
  if (!value) return '';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function ensureRecordLine(bytes: Buffer): Buffer {
  return bytes.at(-1) === 0x0a ? bytes : Buffer.concat([bytes, Buffer.from('\n')]);
}

/**
 * Thin logbook facade. The document owns domain state and the file store owns
 * every access to the formal ADIF file; this class only prepares transactions.
 */
export class ADIFLogProvider implements ILogProvider {
  private readonly options: Required<Pick<ADIFLogProviderOptions, 'autoCreateFile' | 'logFileName'>>
    & Omit<ADIFLogProviderOptions, 'autoCreateFile' | 'logFileName'>;
  private logFilePath = '';
  private store?: AdifFileStore;
  private backup?: AdifBackupService;
  private document?: LogbookDocument;
  private records = new LogbookRecordService([]);
  private generation?: GenerationToken;
  private health = initialHealth();
  private stickyIssues: LogbookHealthIssue[] = [];
  private readonly healthListeners = new Set<(health: LogbookHealth) => void>();
  private readonly writeFailureListeners = new Set<(failure: LogbookWriteFailure) => void>();
  private initializePromise?: Promise<LogbookHealth>;
  private mutationTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private closing = false;
  private restoreQueued = false;
  private unsubscribeStore?: () => void;
  private unregisterPersistence?: () => void;

  constructor(options: ADIFLogProviderOptions = {}) {
    this.options = {
      autoCreateFile: true,
      logFileName: 'tx5dr.adi',
      ...options,
    };
    if (!this.options.logFileName.trim()) throw new TypeError('logFileName must not be empty');
  }

  initialize(): Promise<LogbookHealth> {
    if (this.initialized) return Promise.resolve(this.getHealth());
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal().finally(() => {
      this.initializePromise = undefined;
    });
    return this.initializePromise;
  }

  getHealth(): LogbookHealth {
    return cloneHealth(this.health);
  }

  onHealthChanged(listener: (health: LogbookHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  onWriteFailed(listener: (failure: LogbookWriteFailure) => void): () => void {
    this.writeFailureListeners.add(listener);
    return () => this.writeFailureListeners.delete(listener);
  }

  retryOpen(): Promise<LogbookHealth> {
    if (this.closing) return Promise.resolve(this.getHealth());
    return this.enqueue(async () => {
      this.publishHealth({ state: 'loading', readable: false, writable: false, issues: [] });
      return this.openCurrentPath(true);
    });
  }

  async addQSO(record: QSORecord, operatorId?: string): Promise<QSORecord> {
    let attemptedRecord = cloneRecord(record);
    return this.executeWrite('append', () => attemptedRecord, operatorId, async () => {
      this.assertWritable();
      PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:add');
      return this.enqueue(async () => {
        this.assertWritable();
        const requestedId = record.id?.trim();
        const id = requestedId && !this.document!.getQso(requestedId)
          ? requestedId
          : `tx5dr-${randomUUID()}`;
        const persisted = normalizeQsoForPersistence({
          ...record,
          id,
          messageHistory: [...(record.messageHistory ?? [])],
        });
        attemptedRecord = persisted;
        const mutation = this.document!.prepareAppend(persisted);
        await this.commitMutation(mutation);
        return cloneRecord(this.records.get(id)!);
      });
    });
  }

  async updateQSO(id: string, updates: Partial<QSORecord>, operatorId?: string): Promise<QSORecord> {
    let attemptedRecord: QSORecord | undefined;
    return this.executeWrite('rewrite', () => attemptedRecord, operatorId, async () => {
      this.assertWritable();
      PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:update');
      return this.enqueue(async () => {
        this.assertWritable();
        const existing = this.records.get(id);
        if (!existing) throw new Error(`QSO with id ${id} not found`);
        const next = normalizeQsoForPersistence({
          ...existing,
          ...updates,
          id,
          submode: updates.mode !== undefined && updates.submode === undefined
            ? undefined
            : updates.submode ?? existing.submode,
          messageHistory: [...(updates.messageHistory ?? existing.messageHistory)],
        });
        attemptedRecord = next;
        const mutation = this.document!.prepareUpdate(id, next);
        await this.commitMutation(mutation);
        return cloneRecord(this.records.get(id)!);
      });
    });
  }

  async readQsoSnapshot(options?: LogQueryOptions): Promise<LogbookQsoSnapshot> {
    const queryOptions = options ? {
      ...options,
      frequencyRange: options.frequencyRange ? { ...options.frequencyRange } : undefined,
      timeRange: options.timeRange ? { ...options.timeRange } : undefined,
      excludeModes: options.excludeModes ? [...options.excludeModes] : undefined,
    } : undefined;
    this.assertReadable();
    return this.enqueue(async () => {
      this.assertReadable();
      return {
        revision: generationRevision(this.generation),
        records: this.records.query(queryOptions),
      };
    });
  }

  async applyQsoBatch(
    mutations: readonly LogbookBatchMutation[],
    options: LogbookBatchOptions,
    operatorId?: string,
  ): Promise<LogbookBatchResult> {
    const requestedMutations = mutations.map((mutation): LogbookBatchMutation => (
      mutation.type === 'add'
        ? { type: 'add', record: cloneRecord(mutation.record) }
        : {
            type: 'update',
            qsoId: mutation.qsoId,
            updates: {
              ...mutation.updates,
              messageHistory: mutation.updates.messageHistory
                ? [...mutation.updates.messageHistory]
                : undefined,
              ...('contestEntry' in mutation.updates ? {
                contestEntry: cloneContestEntry(mutation.updates.contestEntry),
              } : {}),
            },
          }
    ));
    const expectedRevision = options.expectedRevision;

    return this.executeWrite('batch', undefined, operatorId, async () => {
      this.assertWritable();
      return this.enqueue(async () => {
        this.assertWritable();
        const currentRevision = generationRevision(this.generation);
        if (!expectedRevision || expectedRevision !== currentRevision) {
          throw new LogbookOperationError(
            'LOGBOOK_REVISION_CONFLICT',
            'The logbook changed after the QSO snapshot was read; refresh and retry the batch',
          );
        }

        if (requestedMutations.length === 0) {
          return { revision: currentRevision, outcomes: [] };
        }

        // Batch mutations are usually tiny (LoTW normally updates one QSO).
        // Keep a working copy only for records touched by this batch instead
        // of cloning the entire logbook before preparing the physical write.
        const originalRecords = new Map<string, QSORecord>();
        const workingRecords = new Map<string, QSORecord>();
        const getWorkingRecord = (id: string): QSORecord | null => (
          workingRecords.get(id) ?? this.records.get(id)
        );
        const addedIds = new Set<string>();
        const addedOrder: string[] = [];
        const updatedExistingOrder: string[] = [];
        const updatedExistingIds = new Set<string>();
        const outcomes: WorkingBatchOutcome[] = [];

        for (let inputIndex = 0; inputIndex < requestedMutations.length; inputIndex += 1) {
          const mutation = requestedMutations[inputIndex]!;
          if (mutation.type === 'add') {
            const requestedId = mutation.record.id?.trim();
            let id = requestedId && !workingRecords.has(requestedId) && !this.records.get(requestedId)
              ? requestedId
              : `tx5dr-${randomUUID()}`;
            while (workingRecords.has(id) || this.records.get(id)) id = `tx5dr-${randomUUID()}`;
            const persisted = normalizeQsoForPersistence({
              ...mutation.record,
              id,
              messageHistory: [...(mutation.record.messageHistory ?? [])],
            });
            workingRecords.set(id, persisted);
            addedIds.add(id);
            addedOrder.push(id);
            outcomes.push({ inputIndex, status: 'added', targetId: id });
            continue;
          }

          const existing = getWorkingRecord(mutation.qsoId);
          if (!existing) throw new Error(`QSO with id ${mutation.qsoId} not found`);
          if (!workingRecords.has(mutation.qsoId) && !addedIds.has(mutation.qsoId)) {
            originalRecords.set(mutation.qsoId, cloneRecord(existing));
          }
          const updates = mutation.updates;
          const requested = {
            ...existing,
            ...updates,
            id: mutation.qsoId,
            submode: updates.mode !== undefined && updates.submode === undefined
              ? undefined
              : updates.submode ?? existing.submode,
            messageHistory: [...(updates.messageHistory ?? existing.messageHistory)],
          };
          const changed = !qsoRecordsEqual(existing, requested);
          if (changed) {
            const next = normalizeQsoForPersistence(requested);
            workingRecords.set(mutation.qsoId, next);
            if (!addedIds.has(mutation.qsoId) && !updatedExistingIds.has(mutation.qsoId)) {
              updatedExistingIds.add(mutation.qsoId);
              updatedExistingOrder.push(mutation.qsoId);
            }
          }
          outcomes.push({
            inputIndex,
            status: changed ? 'updated' : 'unchanged',
            targetId: mutation.qsoId,
          });
        }

        const changedExistingIds = updatedExistingOrder.filter((id) => {
          const original = originalRecords.get(id);
          const current = workingRecords.get(id);
          return Boolean(original && current && !qsoRecordsEqual(original, current));
        });
        const changedExistingIdSet = new Set(changedExistingIds);
        const operations: LogbookRewriteOperation[] = [
          ...changedExistingIds.map(id => ({
            type: 'replace' as const,
            id,
            qso: cloneRecord(workingRecords.get(id)!),
          })),
          ...addedOrder.map(id => {
            const record = cloneRecord(workingRecords.get(id)!);
            return {
              type: 'append' as const,
              raw: encodeAdifRecord(record),
              qso: record,
            };
          }),
        ];

        if (operations.length > 0) {
          PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:batch');
          const mutation = changedExistingIds.length > 0
            ? this.document!.prepareRewrite(operations)
            : this.document!.prepareImport(operations);
          await this.commitMutation(mutation);
        }

        const finalRevision = generationRevision(this.generation);
        return {
          revision: finalRevision,
          outcomes: outcomes.map((outcome) => {
            const record = operations.length > 0
              ? this.records.get(outcome.targetId)
              : getWorkingRecord(outcome.targetId);
            if (!record) throw new Error(`Committed QSO with id ${outcome.targetId} not found`);
            const finalStatus = outcome.status === 'updated'
              && originalRecords.has(outcome.targetId)
              && !changedExistingIdSet.has(outcome.targetId)
              ? 'unchanged'
              : outcome.status;
            return {
              inputIndex: outcome.inputIndex,
              status: finalStatus,
              record: cloneRecord(record),
            };
          }),
        };
      });
    });
  }

  async deleteQSO(id: string): Promise<void> {
    return this.executeWrite('rewrite', undefined, undefined, async () => {
      this.assertWritable();
      PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:delete');
      return this.enqueue(async () => {
        this.assertWritable();
        if (!this.records.get(id)) throw new Error(`QSO with id ${id} not found`);
        await this.commitMutation(this.document!.prepareDelete(id));
      });
    });
  }

  async getQSO(id: string): Promise<QSORecord | null> {
    this.assertReadable();
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async queryQSOs(options?: LogQueryOptions): Promise<QSORecord[]> {
    this.assertReadable();
    return this.records.query(options);
  }

  async countQSOs(options?: LogQueryOptions): Promise<number> {
    this.assertReadable();
    return this.records.count(options);
  }

  async hasWorkedCallsign(
    callsign: string,
    options?: { operatorId?: string; band?: string },
  ): Promise<boolean> {
    this.assertReadable();
    return this.records.hasWorked(callsign, options?.band);
  }

  async getLastQSOWithCallsign(callsign: string, _operatorId?: string): Promise<QSORecord | null> {
    this.assertReadable();
    const record = this.records.lastWithCallsign(callsign);
    return record ? cloneRecord(record) : null;
  }

  async analyzeCallsign(
    callsign: string,
    grid?: string,
    options?: { operatorId?: string; band?: string },
  ): Promise<CallsignAnalysis> {
    this.assertReadable();
    return this.records.analyze(callsign, grid, options?.band);
  }

  async getStatistics(_operatorId?: string): Promise<LogStatistics> {
    this.assertReadable();
    return this.records.statistics();
  }

  async getDXCCSummary(_operatorId?: string): Promise<LogBookDxccSummary> {
    this.assertReadable();
    return this.records.dxccSummary();
  }

  async exportADIF(
    options?: LogQueryOptions,
    exportOptions?: { fallbackGrid?: string },
  ): Promise<string> {
    this.assertReadable();
    return this.enqueue(async () => {
      this.assertReadable();
      const { data } = await this.store!.readAll(this.generation);
      const adapter = new BufferLogbookSourceAdapter(data);
      const selected = this.records.query({
        ...(options ?? {}),
        orderBy: 'time',
        orderDirection: 'asc',
      });
      const chunks: Buffer[] = [encodeAdifHeader()];

      if (!substantiveFilter(options)) {
        for (const segment of this.document!.getOpaqueSegments()) {
          const raw = this.document!.getRawRecord(segment.segmentId, adapter);
          if (raw) chunks.push(ensureRecordLine(raw));
        }
      }

      for (const qso of selected) {
        const segment = this.document!.getSegmentForQso(qso.id);
        if (segment?.source === 'external') {
          const raw = this.document!.getRawRecord(segment.segmentId, adapter);
          if (raw) {
            chunks.push(ensureRecordLine(raw));
            continue;
          }
        }
        chunks.push(encodeAdifRecord(qso, {
          fallbackMyGrid: exportOptions?.fallbackGrid,
          preservedContestEntry: segment?.unparsedContestEntry,
        }));
      }
      return Buffer.concat(chunks).toString('utf8');
    });
  }

  async exportCSV(options?: LogQueryOptions): Promise<string> {
    this.assertReadable();
    const headers = [
      'Date',
      'Time',
      'Callsign',
      'Grid',
      'Frequency (MHz)',
      'Mode',
      'Report Sent',
      'Report Received',
      'My Callsign',
      'My Grid',
      'Comments',
    ];
    const lines = [headers.join(',')];
    for (const qso of this.records.query(options)) {
      const date = new Date(qso.startTime).toISOString();
      lines.push([
        date.slice(0, 10),
        date.slice(11, 19),
        escapeCsvField(qso.callsign),
        escapeCsvField(qso.grid ?? ''),
        (qso.frequency / 1_000_000).toFixed(6),
        escapeCsvField(qso.mode),
        escapeCsvField(qso.reportSent ?? ''),
        escapeCsvField(qso.reportReceived ?? ''),
        escapeCsvField(qso.myCallsign ?? ''),
        escapeCsvField(qso.myGrid ?? ''),
        escapeCsvField(resolveQsoComment(qso) ?? ''),
      ].join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  async importADIF(content: string | Uint8Array): Promise<LogBookImportResult> {
    return this.executeWrite('import', undefined, undefined, async () => {
      this.assertWritable();
      PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:import:adif');
      const source = typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      const scan = scanAdifBuffer(source);
      const candidates = scan.records.map((record, index) => {
        const start = index === 0 ? record.range.start : record.leadingRange.start;
        const end = index === scan.records.length - 1 ? scan.safeTrailingRange.end : record.range.end;
        return {
          qso: decodeAdifRecord(record),
          raw: Buffer.from(source.subarray(start, end)),
        };
      });
      const incomplete = scan.incompleteTailRange
        && scan.incompleteTailRange.end > scan.incompleteTailRange.start
        ? 1
        : 0;
      return this.importCandidates(candidates, 'adif', scan.records.length + incomplete, incomplete);
    });
  }

  async importCSV(content: string): Promise<LogBookImportResult> {
    return this.executeWrite('import', undefined, undefined, async () => {
      this.assertWritable();
      PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:import:csv');
      const parsed = parseTx5drCsvContent(content);
      return this.importCandidates(
        parsed.records.map(qso => ({ qso, raw: Buffer.alloc(0) })),
        'csv',
        parsed.totalRead,
        parsed.skipped,
      );
    });
  }

  async flush(): Promise<void> {
    await this.mutationTail;
    await this.store?.drain();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.unregisterPersistence?.();
    this.unregisterPersistence = undefined;
    await this.flush();
    await this.backup?.flushWithin(30_000).catch((error) => {
      logger.warn('Logbook backup could not be refreshed before shutdown', {
        logBookId: this.options.logBookId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    await this.store?.close();
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  async getRevision(): Promise<string> {
    return generationRevision(this.generation);
  }

  async getBackupStatus(
    options: { admin: boolean; tokenId?: string; unsaved?: LogbookBackupStatus['unsaved'] },
  ): Promise<LogbookBackupStatus> {
    return this.requireBackup().getStatus(this.getHealth(), generationRevision(this.generation), options);
  }

  async createBackup(): Promise<LogbookBackupStatus> {
    await this.requireBackup().createBackup();
    return this.getBackupStatus({ admin: false });
  }

  async prepareBackupRestore(
    tokenId: string,
    expectedRevision: string,
  ): Promise<LogbookRestorePreflight> {
    const backup = this.requireBackup();
    if (this.restoreQueued || backup.maintenanceActive) {
      throw new LogbookBackupError('LOGBOOK_MAINTENANCE', 'A restore operation is already in progress');
    }
    return backup.prepareRestore(
      tokenId,
      expectedRevision,
      this.getHealth(),
      generationRevision(this.generation),
      this.generation,
    );
  }

  async restoreBackup(input: {
    tokenId: string;
    preflightToken: string;
    expectedRevision: string;
    beforeReplace?: () => Promise<void>;
  }): Promise<LogbookBackupStatus> {
    if (this.restoreQueued || this.requireBackup().maintenanceActive) {
      throw new LogbookBackupError('LOGBOOK_MAINTENANCE', 'A restore operation is already in progress');
    }
    this.restoreQueued = true;
    try {
      return await this.enqueue(async () => {
        const committed = await this.requireBackup().restore({
          ...input,
          currentRevision: generationRevision(this.generation),
          beforeReplace: input.beforeReplace,
        });
        this.installScan(committed.scan, committed.generation, committed.recordProjections);
        this.stickyIssues = [];
        this.refreshHealth();
        return this.getBackupStatus({ admin: true, tokenId: input.tokenId });
      });
    } finally {
      this.restoreQueued = false;
    }
  }

  openBackupDownload(kind: 'latest' | 'pre-restore'): Promise<BackupDownload> {
    return this.requireBackup().openDownload(kind);
  }

  private async initializeInternal(): Promise<LogbookHealth> {
    try {
      this.logFilePath = this.options.logFilePath
        ? path.resolve(this.options.logFilePath)
        : await getDataFilePath(this.options.logFileName);
      return await this.openCurrentPath(false);
    } catch (error) {
      logger.error('Logbook initialization was isolated as unavailable', {
        logFilePath: this.logFilePath || this.options.logFileName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.initialized = true;
      this.publishHealth({
        state: 'unavailable',
        readable: false,
        writable: false,
        issues: [{
          code: 'LOGBOOK_OPEN_FAILED',
          message: error instanceof Error ? error.message : String(error),
          occurredAt: Date.now(),
        }],
      });
      return this.getHealth();
    }
  }

  private async openCurrentPath(retry: boolean): Promise<LogbookHealth> {
    const logBookId = this.options.logBookId?.trim()
      || path.basename(this.logFilePath).replace(/\.adi$/i, '');
    if (
      !this.store
      || this.store.getState().status === 'closed'
    ) {
      if (this.store && this.store.getState().status !== 'closed') {
        await this.store.close();
      }
      this.unsubscribeStore?.();
      const storeOptions: AdifFileStoreOptions = {
        createIfMissing: this.options.autoCreateFile,
      };
      this.store = this.options.fileStoreFactory?.(this.logFilePath, storeOptions)
        ?? new AdifFileStore(this.logFilePath, storeOptions);
      this.unsubscribeStore = this.store.subscribeState((state, issues) => {
        if (!this.initialized) return;
        if (state === 'read-only' || state === 'uncertain' || state === 'unavailable') {
          this.publishStoreFailureState(state, issues);
        }
      });
    }

    const opened = retry ? await this.store.recoverOnOpen() : await this.store.open();
    this.stickyIssues = [];
    this.installOpenResult(opened);
    logger.info('Logbook opened', {
      logBookId,
      status: opened.status,
      qsoCount: this.document?.getQsoRecords().length ?? 0,
      segmentCount: this.document?.getSegments().length ?? 0,
      opaqueSegmentCount: this.document?.getOpaqueSegments().length ?? 0,
      generation: this.generation?.token.slice(0, 12) ?? null,
      generationSize: this.generation?.size ?? 0,
      retry,
    });
    if (!this.backup) {
      const backupOptions: AdifBackupServiceOptions = {
        onChanged: () => undefined,
      };
      this.backup = this.options.backupServiceFactory?.(
        logBookId,
        this.logFilePath,
        this.store,
        backupOptions,
      ) ?? new AdifBackupService(logBookId, this.logFilePath, this.store, backupOptions);
      await this.backup.initialize();
    }
    if (this.health.readable && !retry) {
      void this.backup.createInitialBackupInBackground().catch((error) => {
        logger.warn('Initial logbook backup failed without affecting the main ADIF', {
          logBookId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.initialized = true;
    if (!this.unregisterPersistence) {
      this.unregisterPersistence = PersistenceCoordinator.getInstance().register({
        name: `logbook:${this.logFilePath}`,
        flush: async () => this.flush(),
      });
    }
    return this.getHealth();
  }

  private installOpenResult(opened: OpenResult): void {
    if (opened.scan && opened.generation) {
      this.installScan(opened.scan, opened.generation, opened.recordProjections);
    } else {
      this.document = undefined;
      this.records = new LogbookRecordService([]);
      this.generation = undefined;
    }
    this.stickyIssues = dedupeIssues([
      ...this.stickyIssues,
      ...opened.issues.map(storeIssue),
    ]);
    this.refreshHealth(opened.status);
  }

  private installScan(
    scan: AdifScanResult,
    generation: GenerationToken,
    recordProjections?: readonly LogbookRecordProjection[],
  ): void {
    this.document = LogbookDocument.fromScan(scan, recordProjections);
    this.records = new LogbookRecordService(this.document.getQsoRecords());
    this.generation = generation;
  }

  private refreshHealth(status = this.store?.getState().status ?? 'unavailable'): void {
    const dynamicIssues = this.store?.getState().issues.map(storeIssue) ?? [];
    const opaqueCount = this.document?.getOpaqueSegments().length ?? 0;
    const issues = dedupeIssues([
      ...this.stickyIssues,
      ...dynamicIssues,
      ...(opaqueCount > 0 ? [{
        code: 'OPAQUE_ADIF_RECORDS',
        message: `${opaqueCount} complete ADIF record(s) were preserved but could not be shown as QSOs`,
        affectedRecords: opaqueCount,
        occurredAt: Date.now(),
      }] : []),
    ]);
    const hasDocument = this.document !== undefined;
    const unavailable = status === 'unavailable' || status === 'closed' || !hasDocument;
    const readOnly = !unavailable && (
      status === 'read-only'
      || status === 'uncertain'
      || this.backup?.maintenanceActive
    );
    const state = unavailable
      ? 'unavailable'
      : readOnly
        ? 'read_only'
        : status === 'degraded' || issues.length > 0
          ? 'degraded'
          : 'healthy';
    this.publishHealth({
      state,
      readable: hasDocument && !unavailable,
      writable: hasDocument && !readOnly && !unavailable,
      issues,
    });
  }

  private publishStoreFailureState(
    status: AdifFileStoreHealth,
    issues: readonly AdifFileStoreIssue[],
  ): void {
    this.stickyIssues = dedupeIssues([...this.stickyIssues, ...issues.map(storeIssue)]);
    this.refreshHealth(status);
  }

  private publishHealth(next: Omit<LogbookHealth, 'updatedAt'>): void {
    this.health = { ...next, updatedAt: Date.now() };
    const snapshot = this.getHealth();
    for (const listener of this.healthListeners) {
      try {
        listener(cloneHealth(snapshot));
      } catch (error) {
        logger.warn('Logbook health listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async commitMutation(mutation: PreparedLogbookMutation): Promise<void> {
    const logBookId = this.options.logBookId?.trim()
      || path.basename(this.logFilePath).replace(/\.adi$/i, '');
    const beforeRecordCount = this.document?.getQsoCount() ?? 0;
    const expectedRecordCount = mutation.nextDocument.getQsoCount();
    const changedIds = mutation.kind === 'append' ? mutation.addedIds : mutation.changedIds;
    const audit = {
      logBookId,
      mutationKind: mutation.kind,
      beforeRecordCount,
      expectedRecordCount,
      changedIdCount: changedIds.length,
      changedIds: changedIds.slice(0, 20),
      changedIdsTruncated: changedIds.length > 20,
      generationBefore: this.generation?.token.slice(0, 12) ?? null,
    };

    if (mutation.kind === 'rewrite') {
      logger.info('Logbook rewrite committing', audit);
    }

    try {
      if (mutation.kind === 'append') {
        const expected = mutation.nextDocument;
        const committed = await this.store!.commitAppend(
          [mutation.appendBytes],
          this.generation,
          {
            recordCount: expected.getSegments().length,
            validate: (scan, _generation, projections) => this.assertScanMatches(expected, scan, projections),
          },
        );
        this.installCommittedMutation(mutation, committed);
      } else {
        try {
          await this.requireBackup().ensureBeforeRewrite();
        } catch (error) {
          throw new LogbookOperationError(
            'LOGBOOK_BACKUP_FAILED',
            'A valid backup is required before rewriting the main logbook',
            { cause: error, systemCode: systemErrorCode(error) },
          );
        }
        const expected = mutation.nextDocument;
        const committed = await this.store!.commitRewrite(
          mutation.rewriteParts,
          this.generation,
          {
            recordCount: expected.getSegments().length,
            validate: (scan, _generation, projections) => this.assertScanMatches(expected, scan, projections),
          },
        );
        this.installCommittedMutation(mutation, committed);
      }
      this.backup?.markMutationCommitted();
      this.refreshHealth();
    } catch (error) {
      logger.warn('Logbook mutation failed', {
        ...audit,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (mutation.kind === 'rewrite') {
      logger.info('Logbook rewrite committed', {
        ...audit,
        actualRecordCount: this.document?.getQsoCount() ?? 0,
        generationAfter: this.generation?.token.slice(0, 12) ?? null,
        generationSize: this.generation?.size ?? 0,
      });
    }
  }

  private installCommittedMutation(
    mutation: PreparedLogbookMutation,
    committed: {
      scan: AdifScanResult;
      recordProjections: readonly LogbookRecordProjection[];
      generation: GenerationToken;
    },
  ): void {
    try {
      if (mutation.kind === 'append') {
        // Appends do not move any existing source ranges. Reusing the
        // prepared document avoids rebuilding every segment after each QSO.
        this.document = mutation.nextDocument;
        for (const id of mutation.addedIds) {
          const next = mutation.nextDocument.getQso(id);
          if (next) this.records.append(next);
        }
      } else {
        // Rewrites can change record lengths, so source ranges must come from
        // the verified post-rename scan rather than the pre-commit document.
        // Keep the established full installation for rewrites. It is outside
        // the TX critical path and preserves the scanner's external-record ID
        // and source semantics exactly.
        this.installScan(committed.scan, committed.generation, committed.recordProjections);
        return;
      }
      this.generation = committed.generation;
    } catch (error) {
      // The bytes are already durably committed and validated. If an
      // incremental projection update ever hits an unhandled ID edge case,
      // restore a coherent in-memory view from that verified generation.
      logger.error('Incremental logbook projection update failed; restored full committed projection', {
        mutationKind: mutation.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      this.installScan(committed.scan, committed.generation, committed.recordProjections);
    }
  }

  private assertScanMatches(
    expected: LogbookDocument,
    scan: AdifScanResult,
    projections?: readonly LogbookRecordProjection[],
  ): void {
    const wanted = expected.getSegments();
    if (scan.records.length !== wanted.length) {
      throw new Error(`Committed ADIF has ${scan.records.length} segments; expected ${wanted.length}`);
    }
    for (let index = 0; index < wanted.length; index += 1) {
      const left = wanted[index]!;
      const right = scan.records[index]!;
      if (left.rawHash !== right.rawHash) {
        throw new Error(`Committed ADIF segment ${index} has an unexpected raw hash`);
      }
      if (projections && Boolean(left.qso) !== Boolean(projections[index]?.qso)) {
        throw new Error(`Committed ADIF segment ${index} changed QSO visibility`);
      }
    }
  }

  private async importCandidates(
    candidates: readonly ImportCandidate[],
    detectedFormat: LogBookImportResult['detectedFormat'],
    totalRead: number,
    initialSkipped: number,
  ): Promise<LogBookImportResult> {
    return this.enqueue(async () => {
      this.assertWritable();
      const result: LogBookImportResult = {
        detectedFormat,
        totalRead,
        imported: 0,
        merged: 0,
        skipped: initialSkipped,
      };
      const operations: LogbookRewriteOperation[] = [];
      const existingFingerprints = this.records.fingerprintIndex();
      const working = new Map<string, WorkingImportRecord>();
      let forceRewrite = false;

      for (const candidate of candidates) {
        if (!candidate.qso) {
          operations.push({ type: 'append', raw: candidate.raw });
          result.skipped += 1;
          continue;
        }
        const incoming = candidate.qso;
        const fingerprint = buildImportedQsoFingerprint(incoming);
        let current = working.get(fingerprint);
        if (!current) {
          const existingId = existingFingerprints.get(fingerprint);
          if (existingId) {
            const existing = this.records.get(existingId);
            if (existing) {
              current = { record: existing, operationIndex: -1, targetId: existingId };
              working.set(fingerprint, current);
            }
          }
        }

        if (current) {
          const merged = mergeImportedQso(current.record, incoming);
          if (!merged.changed) {
            result.skipped += 1;
            continue;
          }
          result.merged += 1;
          forceRewrite = true;
          if (current.targetId) {
            const normalized = normalizeQsoForPersistence({ ...merged.record, id: current.targetId });
            const replacement: LogbookRewriteOperation = {
              type: 'replace',
              id: current.targetId,
              qso: normalized,
            };
            if (current.operationIndex < 0) {
              current.operationIndex = operations.push(replacement) - 1;
            } else {
              operations[current.operationIndex] = replacement;
            }
            current.record = normalized;
          } else {
            current.canonicalId ??= `tx5dr-import-${randomUUID()}`;
            const normalized = normalizeQsoForPersistence({
              ...merged.record,
              id: current.canonicalId,
            });
            operations[current.operationIndex] = {
              type: 'append',
              raw: encodeAdifRecord(normalized),
              qso: normalized,
            };
            current.record = normalized;
          }
          continue;
        }

        if (detectedFormat === 'adif') {
          const operationIndex = operations.push({
            type: 'append',
            raw: candidate.raw,
            qso: incoming,
          }) - 1;
          working.set(fingerprint, { record: incoming, operationIndex });
        } else {
          const normalized = normalizeQsoForPersistence({
            ...incoming,
            id: `tx5dr-import-${randomUUID()}`,
          });
          const operationIndex = operations.push({
            type: 'append',
            raw: encodeAdifRecord(normalized),
            qso: normalized,
          }) - 1;
          working.set(fingerprint, {
            record: normalized,
            operationIndex,
            canonicalId: normalized.id,
          });
        }
        result.imported += 1;
      }

      if (operations.length === 0) return result;
      const mutation = forceRewrite
        ? this.document!.prepareRewrite(operations)
        : this.document!.prepareImport(operations);
      await this.commitMutation(mutation);
      return result;
    });
  }

  private async executeWrite<T>(
    operation: LogbookWriteFailure['operation'],
    qsoRecord: (() => QSORecord | undefined) | undefined,
    operatorId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const mapped = this.mapWriteError(error);
      const attempted = qsoRecord?.();
      const failure: LogbookWriteFailure = {
        operation,
        error: {
          code: mapped.code,
          message: mapped.message,
          systemCode: mapped.systemCode,
          occurredAt: Date.now(),
        },
        qsoRecord: attempted ? cloneRecord(attempted) : undefined,
        operatorId,
      };
      for (const listener of this.writeFailureListeners) {
        try {
          listener({
            ...failure,
            error: { ...failure.error },
            qsoRecord: failure.qsoRecord ? cloneRecord(failure.qsoRecord) : undefined,
          });
        } catch (listenerError) {
          logger.warn('Logbook write-failure listener failed', {
            error: listenerError instanceof Error ? listenerError.message : String(listenerError),
          });
        }
      }
      // Preserve the coordinator's shutdown signal for existing callers while
      // still publishing the user-visible write failure exactly once.
      if (error instanceof MutationBlockedError) throw error;
      throw mapped;
    }
  }

  private mapWriteError(error: unknown): LogbookOperationError {
    if (error instanceof LogbookOperationError) return error;
    const uncertain = error instanceof AdifGenerationConflictError
      || error instanceof AdifFileStateUncertainError;
    if (uncertain) {
      this.refreshHealth('uncertain');
      return new LogbookOperationError(
        'LOGBOOK_WRITE_STATE_UNCERTAIN',
        error instanceof Error ? error.message : 'The logbook write state is uncertain',
        { cause: error, systemCode: systemErrorCode(error) },
      );
    }
    if (error instanceof AdifFileStoreReadOnlyError) {
      const state = this.store?.getState().status;
      const code = state === 'unavailable'
        ? 'LOGBOOK_UNAVAILABLE'
        : state === 'uncertain'
          ? 'LOGBOOK_WRITE_STATE_UNCERTAIN'
          : 'LOGBOOK_READ_ONLY';
      return new LogbookOperationError(code, error.message, {
        cause: error,
        systemCode: systemErrorCode(error),
      });
    }
    const message = error instanceof AdifFileCommitError && error.rolledBack
      ? 'The ADIF write failed and was rolled back without changing the logbook'
      : error instanceof Error
        ? error.message
        : 'The ADIF write failed';
    return new LogbookOperationError('LOGBOOK_WRITE_FAILED', message, {
      cause: error,
      systemCode: systemErrorCode(error),
    });
  }

  private assertReadable(): void {
    if (this.health.state === 'loading') {
      throw new LogbookOperationError('LOGBOOK_LOADING', 'The logbook is still loading');
    }
    if (!this.health.readable) {
      throw new LogbookOperationError(
        'LOGBOOK_UNAVAILABLE',
        'The logbook is unavailable; inspect its recovery status and retry opening it',
      );
    }
  }

  private assertWritable(): void {
    if (this.health.state === 'loading') {
      throw new LogbookOperationError('LOGBOOK_LOADING', 'The logbook is still loading');
    }
    if (this.health.state === 'read_only') {
      throw new LogbookOperationError('LOGBOOK_READ_ONLY', 'The logbook is read-only until it is reopened');
    }
    if (this.restoreQueued || this.backup?.maintenanceActive) {
      throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'The logbook is temporarily paused for restore');
    }
    if (!this.health.writable) {
      throw new LogbookOperationError(
        'LOGBOOK_UNAVAILABLE',
        'The logbook is unavailable; the QSO was not saved',
      );
    }
  }

  private requireBackup(): AdifBackupService {
    if (!this.backup) {
      throw new LogbookOperationError(
        'LOGBOOK_BACKUP_UNAVAILABLE',
        'The logbook backup service is not ready',
      );
    }
    return this.backup;
  }
}
