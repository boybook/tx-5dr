import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  NodeLegacyLogbookFileStore,
  type LegacyFileStat,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';
import {
  LegacyLogbookRecoveryManager,
  legacyLogbookPathHash,
  type LegacyRecoveryIssue,
  type LegacyRetentionProof,
  type LegacyRetentionResult,
} from './LegacyLogbookRecovery.js';
import {
  inventoryLegacyLogbookArtifacts,
  type LegacyLogbookArtifact,
} from './legacyLogbookArtifacts.js';
import {
  readLegacyJournalTransactions,
  type LegacyJournalIssue,
  type LegacyJournalTransaction,
} from './legacyLogbookJournal.js';
import {
  nodeAdifFileSystem,
  type AdifFileSystem,
} from './FileSystemAdapter.js';
import { PathFileLock, type PathFileLockOptions } from './PathFileLock.js';
import { globalLogbookPathQueue, type PerPathSerialQueue } from './PerPathSerialQueue.js';

export type LegacySnapshotHealth = 'healthy' | 'salvageable' | 'invalid';

export interface LegacyDecodedSnapshot<DocumentType> {
  health: LegacySnapshotHealth;
  document: DocumentType;
  recordCount: number;
  trailingPartial?: boolean;
  reason?: string;
}

export interface LegacyCandidateValidation {
  valid: boolean;
  reason?: string;
}

export type LegacyRecordMatch = 'missing' | 'unique' | 'ambiguous';

/**
 * The codec owns ADIF framing and raw-byte preservation. Mutation methods must
 * retain all untouched segments and their physical order.
 */
export interface LegacyLogbookMigrationCodec<
  DocumentType,
  RecordType extends { id: string },
> {
  decodeSnapshot(data: Buffer, sourcePath: string): Promise<LegacyDecodedSnapshot<DocumentType>>;
  createEmptyDocument(): DocumentType;
  cloneDocument(document: DocumentType): DocumentType;
  /** Return unique only when a durable record identity proves the association. */
  getRecordMatch(document: DocumentType, id: string): LegacyRecordMatch;
  /**
   * Migration-only recovery for old imported records whose journal id was not
   * written into their preserved external ADIF bytes. A unique byte-for-byte
   * raw match may bind that old id for later operations in the same replay.
   */
  associateRecordByRaw(
    document: DocumentType,
    id: string,
    rawLine: string,
  ): LegacyRecordMatch;
  /** Used to prove that replaying an add would be an idempotent no-op. */
  isRecordEquivalent(document: DocumentType, id: string, record: RecordType): boolean;
  replaceRecordInPlace(
    document: DocumentType,
    id: string,
    record: RecordType,
    rawLine?: string,
  ): boolean;
  appendRecord(document: DocumentType, record: RecordType, rawLine?: string): void;
  removeRecord(document: DocumentType, id: string): number;
  containsRaw(document: DocumentType, rawLine: string): boolean;
  appendRaw(document: DocumentType, rawLine: string): void;
  encodeDocument(document: DocumentType): Promise<Buffer>;
  validateCandidate(
    data: Buffer,
    expectedDocument: DocumentType,
  ): Promise<LegacyCandidateValidation>;
}

export type LegacyMigrationStatus =
  | 'NOT_NEEDED'
  | 'MIGRATED'
  | 'RECOVERED'
  | 'CLEANUP_PENDING'
  | 'FAILED';

export interface LegacyMigrationIssue {
  code: string;
  path?: string;
  line?: number;
  message: string;
}

export interface LegacyMigrationResult {
  status: LegacyMigrationStatus;
  mainPath: string;
  committed: boolean;
  baselinePath?: string;
  appliedTransactions: number;
  skippedTransactions: number;
  unappliedOperations: number;
  recoveryPath?: string;
  issues: LegacyMigrationIssue[];
}

export interface LegacyLogbookMigratorCoordinationOptions {
  queue?: PerPathSerialQueue;
  lockFileSystem?: AdifFileSystem;
  lockOptions?: PathFileLockOptions;
}

interface DecodedSource<DocumentType> {
  path: string;
  data: Buffer;
  sha256: string;
  stat: LegacyFileStat;
  decoded: LegacyDecodedSnapshot<DocumentType>;
  isMain: boolean;
}

interface SelectedBaseline<DocumentType> {
  source?: DecodedSource<DocumentType>;
  document: DocumentType;
  authoritativeMain: boolean;
  recovered: boolean;
}

interface ApplyResult {
  appliedTransactions: number;
  unappliedOperations: number;
  issues: LegacyMigrationIssue[];
}

interface FilteredTransactions<RecordType extends { id: string }> {
  transactions: LegacyJournalTransaction<RecordType>[];
  skippedTransactions: number;
  issues: LegacyMigrationIssue[];
}

const SNAPSHOT_KINDS = new Set<LegacyLogbookArtifact['kind']>([
  'snapshot-backup',
  'snapshot-temp',
  'snapshot-corrupt',
]);

const JOURNAL_KINDS = new Set<LegacyLogbookArtifact['kind']>([
  'journal-current',
  'journal-current-copy',
  'journal-archive',
  'journal-archive-copy',
]);

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface LegacyMigrationPaths {
  recoveryRoot: string;
  candidatePath: string;
  lastGoodPath: string;
  lastGoodTempPath: string;
  unrecoverableOriginalPath: string;
  lockPath: string;
}

export function legacyMigrationPaths(mainPath: string): LegacyMigrationPaths {
  const recoveryRoot = path.join(
    path.dirname(mainPath),
    '.tx5dr-recovery',
    legacyLogbookPathHash(mainPath),
  );
  return {
    recoveryRoot,
    candidatePath: path.join(recoveryRoot, 'rewrite.tmp'),
    lastGoodPath: path.join(recoveryRoot, 'last-good.adi'),
    lastGoodTempPath: path.join(recoveryRoot, 'last-good.tmp'),
    unrecoverableOriginalPath: path.join(recoveryRoot, 'unrecoverable-original.adi'),
    lockPath: path.join(recoveryRoot, 'operation.lock'),
  };
}

function toMigrationIssue(issue: LegacyJournalIssue | LegacyRecoveryIssue): LegacyMigrationIssue {
  return { code: issue.code, path: issue.path, line: 'line' in issue ? issue.line : undefined, message: issue.message };
}

function recordFrom(value: unknown): (Record<string, unknown> & { id: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0
    ? record as Record<string, unknown> & { id: string }
    : null;
}

export class LegacyLogbookMigrator<
  DocumentType,
  RecordType extends { id: string },
> {
  private readonly inFlight = new Map<string, Promise<LegacyMigrationResult>>();
  private readonly recovery: LegacyLogbookRecoveryManager;
  private readonly queue: PerPathSerialQueue;
  private readonly lockFileSystem: AdifFileSystem;
  private readonly lockOptions?: PathFileLockOptions;

  constructor(
    private readonly codec: LegacyLogbookMigrationCodec<DocumentType, RecordType>,
    private readonly fileStore: LegacyLogbookFileStore = new NodeLegacyLogbookFileStore(),
    recovery?: LegacyLogbookRecoveryManager,
    coordination: LegacyLogbookMigratorCoordinationOptions = {},
  ) {
    this.recovery = recovery ?? new LegacyLogbookRecoveryManager(fileStore);
    this.queue = coordination.queue ?? globalLogbookPathQueue;
    this.lockFileSystem = coordination.lockFileSystem ?? nodeAdifFileSystem;
    this.lockOptions = coordination.lockOptions;
  }

  migrate(mainPath: string): Promise<LegacyMigrationResult> {
    const normalizedPath = path.resolve(mainPath);
    const existing = this.inFlight.get(normalizedPath);
    if (existing) return existing;

    const migration: Promise<LegacyMigrationResult> = this.queue.run(normalizedPath, async () => {
      const paths = legacyMigrationPaths(normalizedPath);
      try {
        await this.fileStore.makeDirectory(paths.recoveryRoot);
        const lock = new PathFileLock(this.lockFileSystem, paths.lockPath, this.lockOptions);
        return await lock.run(() => this.migrateUnlocked(normalizedPath));
      } catch (error) {
        return {
          status: 'FAILED',
          mainPath: normalizedPath,
          committed: false,
          appliedTransactions: 0,
          skippedTransactions: 0,
          unappliedOperations: 0,
          issues: [{ code: 'MIGRATION_LOCK_FAILED', path: paths.lockPath, message: (error as Error).message }],
        } satisfies LegacyMigrationResult;
      } finally {
        await this.removeEmptyCoordinationDirectories(paths.recoveryRoot).catch(() => undefined);
      }
    }).finally(() => {
      this.inFlight.delete(normalizedPath);
    });
    this.inFlight.set(normalizedPath, migration);
    return migration;
  }

  async cleanupExpired(
    mainPath: string,
    proof: LegacyRetentionProof,
  ): Promise<LegacyRetentionResult> {
    const normalizedPath = path.resolve(mainPath);
    const paths = legacyMigrationPaths(normalizedPath);
    const manifestPath = path.join(paths.recoveryRoot, 'manifest.json');
    if (!await this.fileStore.exists(manifestPath)) {
      return { removedRecoverySets: 0, issues: [] };
    }

    return this.queue.run(normalizedPath, async () => {
      try {
        await this.fileStore.makeDirectory(paths.recoveryRoot);
        const lock = new PathFileLock(this.lockFileSystem, paths.lockPath, this.lockOptions);
        return await lock.run(() => this.recovery.cleanupExpiredFor(normalizedPath, proof));
      } catch (error) {
        return {
          removedRecoverySets: 0,
          issues: [{
            code: 'RECOVERY_RETENTION_FAILED',
            path: paths.recoveryRoot,
            message: (error as Error).message,
          }],
        };
      } finally {
        await this.removeEmptyCoordinationDirectories(paths.recoveryRoot).catch(() => undefined);
      }
    });
  }

  private async removeEmptyCoordinationDirectories(recoveryRoot: string): Promise<void> {
    const recoveryBase = path.dirname(recoveryRoot);
    await this.fileStore.removeDirectory(recoveryRoot).catch(() => undefined);
    await this.fileStore.removeDirectory(recoveryBase).catch(() => undefined);
    await this.fileStore.syncDirectory(path.dirname(recoveryBase));
  }

  private async decodeSource(
    sourcePath: string,
    stat: LegacyFileStat,
    isMain: boolean,
    issues: LegacyMigrationIssue[],
  ): Promise<DecodedSource<DocumentType> | null> {
    try {
      const data = await this.fileStore.readFile(sourcePath);
      let decoded: LegacyDecodedSnapshot<DocumentType>;
      try {
        decoded = await this.codec.decodeSnapshot(data, sourcePath);
      } catch (error) {
        issues.push({ code: 'SNAPSHOT_DECODE_FAILED', path: sourcePath, message: (error as Error).message });
        decoded = {
          health: 'invalid',
          document: this.codec.createEmptyDocument(),
          recordCount: 0,
          reason: (error as Error).message,
        };
      }
      return { path: sourcePath, data, sha256: sha256(data), stat, decoded, isMain };
    } catch (error) {
      issues.push({ code: 'SNAPSHOT_READ_FAILED', path: sourcePath, message: (error as Error).message });
      return null;
    }
  }

  private selectBaseline(
    main: DecodedSource<DocumentType> | null,
    fallbackSources: DecodedSource<DocumentType>[],
  ): SelectedBaseline<DocumentType> {
    const usableFallbacks = fallbackSources
      .filter(source => source.decoded.health !== 'invalid')
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || left.path.localeCompare(right.path));
    const newestValidFallback = usableFallbacks[0];

    // A tolerantly scannable formal ADIF is authoritative even when it is empty
    // or has a repairable tail. Picking a larger backup here can resurrect QSOs
    // that the user intentionally deleted from the newer formal file.
    if (main && main.decoded.health !== 'invalid') {
      return {
        source: main,
        document: this.codec.cloneDocument(main.decoded.document),
        authoritativeMain: true,
        recovered: main.decoded.health === 'salvageable',
      };
    }

    if (newestValidFallback) {
      return {
        source: newestValidFallback,
        document: this.codec.cloneDocument(newestValidFallback.decoded.document),
        authoritativeMain: false,
        recovered: true,
      };
    }

    return {
      document: this.codec.createEmptyDocument(),
      authoritativeMain: false,
      recovered: true,
    };
  }

  private selectJournalArtifacts(
    artifacts: LegacyLogbookArtifact[],
    baseline: SelectedBaseline<DocumentType>,
  ): LegacyLogbookArtifact[] {
    const journals = artifacts.filter(artifact => JOURNAL_KINDS.has(artifact.kind));
    if (baseline.authoritativeMain) {
      // A rotated archive exists only after its transactions were checkpointed
      // into the healthy main file. Replaying it can resurrect later deletions.
      // Both naming generations can leave an unrotated current stream. Their
      // entries are considered later only by the strict timestamp gate below.
      return journals.filter(artifact => artifact.journalStream === 'current');
    }

    if (!baseline.source) return journals;
    // Backup mtime is set immediately before the matching checkpoint archive is
    // rotated. Floor to one second for filesystems with coarse mtime precision.
    const archiveCutoff = Math.floor(baseline.source.stat.mtimeMs / 1000) * 1000;
    return journals.filter(artifact => (
      artifact.journalStream === 'current'
      || (artifact.archiveAtMs !== undefined && artifact.archiveAtMs >= archiveCutoff)
    ));
  }

  private filterTransactionsAfterBaseline(
    transactions: LegacyJournalTransaction<RecordType>[],
    selectedArtifacts: LegacyLogbookArtifact[],
    baseline: SelectedBaseline<DocumentType>,
  ): FilteredTransactions<RecordType> {
    if (!baseline.source) return { transactions, skippedTransactions: 0, issues: [] };

    const artifactsByPath = new Map(selectedArtifacts.map(artifact => [artifact.path, artifact]));
    const accepted: LegacyJournalTransaction<RecordType>[] = [];
    const issues: LegacyMigrationIssue[] = [];
    let skippedTransactions = 0;
    for (const transaction of transactions) {
      const artifact = artifactsByPath.get(transaction.sourcePath);
      if (artifact?.journalStream === 'archive') {
        accepted.push(transaction);
        continue;
      }
      if (
        baseline.authoritativeMain
        && artifact?.kind === 'journal-current'
        && artifact.journalFamily === 'current'
      ) {
        // The unrotated journal from the final legacy generation is precisely
        // the set that may not have reached the formal ADIF. Replaying it in
        // file order is idempotent and must not depend on a wall-clock value.
        accepted.push(transaction);
        continue;
      }
      if (transaction.entry.timestamp > baseline.source.stat.mtimeMs) {
        accepted.push(transaction);
        continue;
      }

      skippedTransactions += 1;
      issues.push({
        code: 'JOURNAL_TX_NOT_NEWER_THAN_BASELINE_SKIPPED',
        path: transaction.sourcePath,
        line: transaction.line,
        message: `Transaction ${transaction.entry.txId} is not strictly newer than the selected snapshot`,
      });
    }
    return { transactions: accepted, skippedTransactions, issues };
  }

  private applyRecordOperation(
    document: DocumentType,
    operation: 'add' | 'update',
    recordValue: unknown,
    rawLine: unknown,
    issues: LegacyMigrationIssue[],
  ): number {
    const record = recordFrom(recordValue);
    if (!record) {
      issues.push({ code: 'JOURNAL_RECORD_UNAPPLIED', message: 'Journal record has no stable id' });
      return 1;
    }
    const typedRecord = record as RecordType;
    const typedRawLine = typeof rawLine === 'string' ? rawLine : undefined;

    const match = this.codec.getRecordMatch(document, record.id);
    if (operation === 'add') {
      if (match === 'missing' && typedRawLine) {
        const rawMatch = this.codec.associateRecordByRaw(
          document,
          record.id,
          typedRawLine,
        );
        if (rawMatch === 'unique') {
          issues.push({
            code: 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED',
            message: `Add transaction for ${record.id} is already represented by the baseline raw record`,
          });
          return 0;
        }
        if (rawMatch === 'ambiguous') {
          issues.push({
            code: 'JOURNAL_ADD_TARGET_AMBIGUOUS',
            message: `Add transaction for ${record.id} matches multiple baseline raw records and was not applied`,
          });
          return 1;
        }
      }
      if (match === 'missing') {
        this.codec.appendRecord(document, typedRecord, typedRawLine);
        return 0;
      }
      if (match === 'unique' && this.codec.isRecordEquivalent(document, record.id, typedRecord)) {
        issues.push({
          code: 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED',
          message: `Add transaction for ${record.id} is already represented by the baseline`,
        });
        return 0;
      }
      issues.push({
        code: match === 'ambiguous' ? 'JOURNAL_ADD_TARGET_AMBIGUOUS' : 'JOURNAL_ADD_ID_CONFLICT',
        message: `Add transaction for ${record.id} cannot be associated safely and was not applied`,
      });
      return 1;
    }

    if (match !== 'unique') {
      issues.push({
        code: match === 'ambiguous' ? 'JOURNAL_UPDATE_TARGET_AMBIGUOUS' : 'JOURNAL_UPDATE_TARGET_MISSING',
        message: `Update transaction for ${record.id} cannot be associated safely and was not applied`,
      });
      return 1;
    }
    if (!this.codec.replaceRecordInPlace(document, record.id, typedRecord, typedRawLine)) {
      issues.push({
        code: 'JOURNAL_UPDATE_TARGET_CHANGED',
        message: `Update target ${record.id} changed during migration and was not applied`,
      });
      return 1;
    }
    return 0;
  }

  private applyDeleteOperation(
    document: DocumentType,
    id: string,
    issues: LegacyMigrationIssue[],
  ): number {
    const match = this.codec.getRecordMatch(document, id);
    if (match !== 'unique') {
      issues.push({
        code: match === 'ambiguous' ? 'JOURNAL_DELETE_TARGET_AMBIGUOUS' : 'JOURNAL_DELETE_TARGET_MISSING',
        message: `Delete transaction for ${id} cannot be associated safely and was not applied`,
      });
      return 1;
    }
    if (this.codec.removeRecord(document, id) !== 1) {
      issues.push({
        code: 'JOURNAL_DELETE_TARGET_CHANGED',
        message: `Delete target ${id} changed during migration and was not applied`,
      });
      return 1;
    }
    return 0;
  }

  private applyTransactions(
    document: DocumentType,
    transactions: LegacyJournalTransaction<RecordType>[],
  ): ApplyResult {
    const issues: LegacyMigrationIssue[] = [];
    let unappliedOperations = 0;
    for (const transaction of transactions) {
      const { operation, payload } = transaction.entry;
      if (operation === 'add' || operation === 'update') {
        unappliedOperations += this.applyRecordOperation(
          document,
          operation,
          payload.record,
          payload.rawLine,
          issues,
        );
      } else if (operation === 'delete') {
        unappliedOperations += this.applyDeleteOperation(document, payload.id as string, issues);
      } else {
        const operations = payload.operations as Array<Record<string, unknown>>;
        for (const imported of operations) {
          if (imported.type === 'add' || imported.type === 'update') {
            unappliedOperations += this.applyRecordOperation(
              document,
              imported.type,
              imported.record,
              imported.rawLine,
              issues,
            );
          } else if (imported.type === 'delete') {
            unappliedOperations += this.applyDeleteOperation(document, imported.id as string, issues);
          } else if (imported.type === 'raw' && typeof imported.rawLine === 'string') {
            if (!this.codec.containsRaw(document, imported.rawLine)) {
              this.codec.appendRaw(document, imported.rawLine);
            }
          }
        }
      }
    }
    return { appliedTransactions: transactions.length, unappliedOperations, issues };
  }

  private async validateEncodedCandidate(
    data: Buffer,
    expectedDocument: DocumentType,
    candidatePath: string,
  ): Promise<LegacyMigrationIssue | null> {
    const validation = await this.codec.validateCandidate(data, expectedDocument);
    return validation.valid
      ? null
      : {
          code: 'CANDIDATE_VALIDATION_FAILED',
          path: candidatePath,
          message: validation.reason ?? 'Candidate validation failed',
        };
  }

  private async sourcesUnchanged(
    mainPath: string,
    expectedMainHash: string | undefined,
    journalHashes: Map<string, string>,
  ): Promise<LegacyMigrationIssue | null> {
    const mainExists = await this.fileStore.exists(mainPath);
    if (expectedMainHash === undefined ? mainExists : !mainExists) {
      return { code: 'MIGRATION_SOURCE_CHANGED', path: mainPath, message: 'Main logbook changed during migration' };
    }
    if (expectedMainHash !== undefined && sha256(await this.fileStore.readFile(mainPath)) !== expectedMainHash) {
      return { code: 'MIGRATION_SOURCE_CHANGED', path: mainPath, message: 'Main logbook changed during migration' };
    }
    for (const [sourcePath, expectedHash] of journalHashes) {
      if (!await this.fileStore.exists(sourcePath)
        || sha256(await this.fileStore.readFile(sourcePath)) !== expectedHash) {
        return { code: 'MIGRATION_SOURCE_CHANGED', path: sourcePath, message: 'Journal changed during migration' };
      }
    }
    return null;
  }

  private async commitCandidate(
    mainPath: string,
    candidate: Buffer,
    expectedDocument: DocumentType,
    expectedMainHash: string | undefined,
    expectedMainHealth: LegacySnapshotHealth | undefined,
    journalHashes: Map<string, string>,
    targetMode: number | undefined,
    issues: LegacyMigrationIssue[],
  ): Promise<boolean> {
    const paths = legacyMigrationPaths(mainPath);
    const candidatePath = paths.candidatePath;
    const backupPath = paths.lastGoodPath;
    await this.fileStore.writeFileDurable(
      candidatePath,
      candidate,
      targetMode === undefined ? undefined : targetMode & 0o7777,
    );
    const written = await this.fileStore.readFile(candidatePath);
    if (sha256(written) !== sha256(candidate)) {
      issues.push({ code: 'CANDIDATE_HASH_MISMATCH', path: candidatePath, message: 'Candidate changed after durable write' });
      return false;
    }
    const candidateIssue = await this.validateEncodedCandidate(written, expectedDocument, candidatePath);
    if (candidateIssue) {
      issues.push(candidateIssue);
      return false;
    }

    const changed = await this.sourcesUnchanged(mainPath, expectedMainHash, journalHashes);
    if (changed) {
      issues.push(changed);
      return false;
    }

    let rollbackPath: string | undefined;
    if (expectedMainHash !== undefined && expectedMainHealth === 'healthy') {
      await this.fileStore.copyFileDurable(mainPath, paths.lastGoodTempPath);
      const copied = await this.fileStore.readFile(paths.lastGoodTempPath);
      if (sha256(copied) !== expectedMainHash) {
        issues.push({
          code: 'LAST_GOOD_HASH_MISMATCH',
          path: paths.lastGoodTempPath,
          message: 'The durable last-good candidate differs from the healthy main logbook',
        });
        return false;
      }
      await this.fileStore.rename(paths.lastGoodTempPath, backupPath);
      await this.fileStore.syncDirectory(paths.recoveryRoot);
      rollbackPath = backupPath;
    } else if (expectedMainHash !== undefined) {
      const existingOriginal = await this.fileStore.exists(paths.unrecoverableOriginalPath);
      if (existingOriginal) {
        const existingHash = sha256(await this.fileStore.readFile(paths.unrecoverableOriginalPath));
        if (existingHash !== expectedMainHash) {
          issues.push({
            code: 'UNRECOVERABLE_ORIGINAL_CONFLICT',
            path: paths.unrecoverableOriginalPath,
            message: 'The fixed unrecoverable original already contains a different logbook and was not overwritten',
          });
          return false;
        }
      } else {
        await this.fileStore.copyFileDurable(mainPath, paths.unrecoverableOriginalPath);
        await this.fileStore.syncDirectory(paths.recoveryRoot);
      }
      rollbackPath = paths.unrecoverableOriginalPath;
    }

    await this.fileStore.rename(candidatePath, mainPath);
    await this.fileStore.syncDirectory(path.dirname(mainPath));
    const committed = await this.fileStore.readFile(mainPath);
    const committedIssue = sha256(committed) === sha256(candidate)
      ? await this.validateEncodedCandidate(committed, expectedDocument, mainPath)
      : { code: 'COMMITTED_HASH_MISMATCH', path: mainPath, message: 'Committed file differs from candidate' };
    if (!committedIssue) return true;

    issues.push(committedIssue);
    if (rollbackPath) {
      try {
        await this.fileStore.copyFileDurable(rollbackPath, candidatePath);
        await this.fileStore.rename(candidatePath, mainPath);
        await this.fileStore.syncDirectory(path.dirname(mainPath));
      } catch (error) {
        issues.push({ code: 'MIGRATION_ROLLBACK_FAILED', path: rollbackPath, message: (error as Error).message });
      }
    }
    return false;
  }

  private async ensureVerifiedLastGood(
    mainPath: string,
    expectedHash: string,
    issues: LegacyMigrationIssue[],
  ): Promise<boolean> {
    const paths = legacyMigrationPaths(mainPath);
    try {
      const main = await this.fileStore.readFile(mainPath);
      if (sha256(main) !== expectedHash) {
        issues.push({
          code: 'COMMITTED_HASH_MISMATCH',
          path: mainPath,
          message: 'The formal ADIF changed before its final recovery point was verified',
        });
        return false;
      }

      if (await this.fileStore.exists(paths.lastGoodPath)) {
        const existing = await this.fileStore.readFile(paths.lastGoodPath);
        if (sha256(existing) === expectedHash) return true;
      }

      await this.fileStore.copyFileDurable(mainPath, paths.lastGoodTempPath);
      const copied = await this.fileStore.readFile(paths.lastGoodTempPath);
      if (sha256(copied) !== expectedHash) {
        issues.push({
          code: 'LAST_GOOD_HASH_MISMATCH',
          path: paths.lastGoodTempPath,
          message: 'The post-migration last-good copy differs from the verified formal ADIF',
        });
        return false;
      }
      await this.fileStore.rename(paths.lastGoodTempPath, paths.lastGoodPath);
      await this.fileStore.syncDirectory(paths.recoveryRoot);
      return true;
    } catch (error) {
      issues.push({
        code: 'LAST_GOOD_REFRESH_FAILED',
        path: paths.lastGoodPath,
        message: (error as Error).message,
      });
      return false;
    }
  }

  private async migrateUnlocked(mainPath: string): Promise<LegacyMigrationResult> {
    const issues: LegacyMigrationIssue[] = [];
    let appliedTransactions = 0;
    let skippedTransactions = 0;
    let unappliedOperations = 0;
    let committed = false;
    let baselinePath: string | undefined;

    try {
      const resumed = await this.recovery.resumePending(mainPath);
      issues.push(...resumed.issues.map(toMigrationIssue));
      if (resumed.state === 'CLEANUP_PENDING' && resumed.legacyStateCommitted) {
        // The manifest identifies the exact artifacts already represented by
        // the formal ADIF. Replaying them after user mutations would roll the
        // logbook back; only the remaining quarantine moves may be retried.
        return {
          status: 'CLEANUP_PENDING',
          mainPath,
          committed: false,
          appliedTransactions,
          skippedTransactions,
          unappliedOperations,
          recoveryPath: resumed.recoveryPath,
          issues,
        };
      }
      const inventory = await inventoryLegacyLogbookArtifacts(mainPath, this.fileStore);
      if (inventory.artifacts.length === 0) {
        return {
          status: resumed.state === 'CLEANUP_PENDING' ? 'CLEANUP_PENDING' : 'NOT_NEEDED',
          mainPath,
          committed: false,
          appliedTransactions,
          skippedTransactions,
          unappliedOperations,
          recoveryPath: resumed.recoveryPath,
          issues,
        };
      }

      const main = inventory.mainExists && inventory.mainStat
        ? await this.decodeSource(mainPath, inventory.mainStat, true, issues)
        : null;
      const fallbackSources: DecodedSource<DocumentType>[] = [];
      for (const artifact of inventory.artifacts.filter(candidate => SNAPSHOT_KINDS.has(candidate.kind))) {
        const decoded = await this.decodeSource(artifact.path, artifact, false, issues);
        if (decoded) fallbackSources.push(decoded);
      }

      const baseline = this.selectBaseline(main, fallbackSources);
      baselinePath = baseline.source?.path;
      if (!baseline.source) {
        issues.push({
          code: 'UNRECOVERABLE_SOURCE_REPLACED',
          path: mainPath,
          message: 'No usable snapshot was found; the original artifacts will be retained and a new empty logbook created',
        });
      }

      const selectedJournals = this.selectJournalArtifacts(inventory.artifacts, baseline);
      const journalResult = await readLegacyJournalTransactions<RecordType>(selectedJournals, this.fileStore);
      issues.push(...journalResult.issues.map(toMigrationIssue));
      const selectedJournalPaths = new Set(selectedJournals.map(artifact => artifact.path));
      const nonReplayJournals = inventory.artifacts.filter(artifact => (
        JOURNAL_KINDS.has(artifact.kind) && !selectedJournalPaths.has(artifact.path)
      ));
      const nonReplayJournalResult = journalResult.verifiedTransactionCount > 0 || nonReplayJournals.length === 0
        ? undefined
        : await readLegacyJournalTransactions<RecordType>(nonReplayJournals, this.fileStore);
      const hasVerifiedLegacyTransaction = journalResult.verifiedTransactionCount > 0
        || (nonReplayJournalResult?.verifiedTransactionCount ?? 0) > 0;
      const filtered = this.filterTransactionsAfterBaseline(
        journalResult.transactions,
        selectedJournals,
        baseline,
      );
      skippedTransactions = filtered.skippedTransactions;
      issues.push(...filtered.issues);
      const document = this.codec.cloneDocument(baseline.document);
      const applied = this.applyTransactions(document, filtered.transactions);
      appliedTransactions = applied.appliedTransactions;
      unappliedOperations = applied.unappliedOperations;
      issues.push(...applied.issues);

      const encoded = await this.codec.encodeDocument(document);
      const encodedSnapshot = await this.codec.decodeSnapshot(
        encoded,
        legacyMigrationPaths(mainPath).candidatePath,
      );
      const preflightIssue = await this.validateEncodedCandidate(
        encoded,
        document,
        legacyMigrationPaths(mainPath).candidatePath,
      );
      if (preflightIssue) {
        issues.push(preflightIssue);
        return {
          status: 'FAILED',
          mainPath,
          committed: false,
          baselinePath,
          appliedTransactions,
          skippedTransactions,
          unappliedOperations,
          issues,
        };
      }

      const mainHash = main?.sha256;
      const candidateHash = sha256(encoded);
      if (mainHash !== candidateHash || !inventory.mainExists) {
        committed = await this.commitCandidate(
          mainPath,
          encoded,
          document,
          mainHash,
          main?.decoded.health,
          journalResult.sourceSha256,
          main?.stat.mode ?? baseline.source?.stat.mode,
          issues,
        );
        if (!committed) {
          return {
            status: 'FAILED',
            mainPath,
            committed: false,
            baselinePath,
            appliedTransactions,
            skippedTransactions,
            unappliedOperations,
            issues,
          };
        }
      }

      // A retry can observe candidate === main after a crash between the main
      // rename and the final last-good refresh. Inspect every journal that is
      // about to be quarantined, including streams excluded from replay, so
      // cleanup cannot retain only the pre-migration recovery point. Pure
      // metadata/snapshot cleanup remains artifact-free when no rewrite ran.
      const requiresFinalLastGood = committed || hasVerifiedLegacyTransaction;
      if (requiresFinalLastGood
        && !await this.ensureVerifiedLastGood(mainPath, candidateHash, issues)) {
        return {
          status: 'FAILED',
          mainPath,
          committed,
          baselinePath,
          appliedTransactions,
          skippedTransactions,
          unappliedOperations,
          issues,
        };
      }

      const cleanupInventory = await inventoryLegacyLogbookArtifacts(mainPath, this.fileStore);
      const cleanupArtifacts = cleanupInventory.artifacts;
      let recoveryPath = resumed.recoveryPath;
      if (cleanupArtifacts.length > 0) {
        const cleanup = await this.recovery.quarantine(
          mainPath,
          candidateHash,
          encodedSnapshot.recordCount,
          cleanupArtifacts,
        );
        recoveryPath = cleanup.recoveryPath;
        issues.push(...cleanup.issues.map(toMigrationIssue));
        if (cleanup.state === 'CLEANUP_PENDING') {
          if (!cleanup.legacyStateCommitted) {
            issues.push({
              code: 'RECOVERY_COMMIT_PROOF_MISSING',
              path: cleanup.recoveryPath,
              message: 'Legacy artifacts remain beside the logbook without a durable manifest; writes are blocked until migration retry succeeds',
            });
          }
          return {
            status: cleanup.legacyStateCommitted ? 'CLEANUP_PENDING' : 'FAILED',
            mainPath,
            committed,
            baselinePath,
            appliedTransactions,
            skippedTransactions,
            unappliedOperations,
            recoveryPath,
            issues,
          };
        }
      } else if (resumed.state === 'CLEANUP_PENDING') {
        return {
          status: 'CLEANUP_PENDING',
          mainPath,
          committed,
          baselinePath,
          appliedTransactions,
          skippedTransactions,
          unappliedOperations,
          recoveryPath,
          issues,
        };
      }

      return {
        status: baseline.recovered
          || journalResult.issues.length > 0
          || skippedTransactions > 0
          || unappliedOperations > 0
          ? 'RECOVERED'
          : 'MIGRATED',
        mainPath,
        committed,
        baselinePath,
        appliedTransactions,
        skippedTransactions,
        unappliedOperations,
        recoveryPath,
        issues,
      };
    } catch (error) {
      issues.push({ code: 'MIGRATION_FAILED', path: mainPath, message: (error as Error).message });
      return {
        status: 'FAILED',
        mainPath,
        committed,
        baselinePath,
        appliedTransactions,
        skippedTransactions,
        unappliedOperations,
        issues,
      };
    }
  }
}
