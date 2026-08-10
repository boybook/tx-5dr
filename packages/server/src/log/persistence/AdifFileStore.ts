import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  encodeAdifHeader,
  scanAdifBuffer,
  type AdifByteRange,
  type AdifScanIssue,
  type AdifScanResult,
  type ScannedAdifRecord,
} from './AdifCodec.js';
import {
  ADIF_APPEND_FLAGS,
  ADIF_EXCLUSIVE_CREATE_FLAGS,
  ADIF_REWRITE_FLAGS,
  errorCode,
  fsyncDirectory,
  fsyncFile,
  nodeAdifFileSystem,
  pathExists,
  writeAll,
  type AdifFileHandle,
  type AdifFileSystem,
} from './FileSystemAdapter.js';
import { LogbookScanWorker } from './LogbookScanWorker.js';
import type {
  GenerationToken,
  LogbookFileScanResult,
  LogbookScanner,
  LogbookScanProgress,
} from './LogbookScanTypes.js';
import { buildGenerationToken, hashStructuralScan } from './LogbookScanCore.js';
import { PathFileLock, type PathFileLockOptions } from './PathFileLock.js';
import { globalLogbookPathQueue, type PerPathSerialQueue } from './PerPathSerialQueue.js';
import { legacyLogbookPathHash } from './LegacyLogbookRecovery.js';
import {
  LogbookRecordProjector,
  type LogbookRecordProjection,
} from './LogbookDocument.js';

export const LOGBOOK_TAIL_FRAGMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type AdifFileStoreHealth =
  | 'ready'
  | 'degraded'
  | 'read-only'
  | 'unavailable'
  | 'uncertain'
  | 'closed';

export interface AdifFileStoreIssue {
  code: string;
  message: string;
  path?: string;
  cause?: string;
}

export interface OpenResult {
  status: AdifFileStoreHealth;
  issues: readonly AdifFileStoreIssue[];
  generation?: GenerationToken;
  scan?: AdifScanResult;
  recordProjections?: readonly LogbookRecordProjection[];
  recoveredFrom?: 'rewrite.tmp' | 'last-good.adi' | 'safe-prefix' | 'standard-empty';
}

export interface RewriteValidationExpectations {
  recordCount?: number;
  minimumRecordCount?: number;
  contentHash?: string;
  scanHash?: string;
  requireSyntacticallyValidRecords?: boolean;
  validate?: (
    scan: AdifScanResult,
    generation: GenerationToken,
    recordProjections: readonly LogbookRecordProjection[],
  ) => void | Promise<void>;
}

export interface AdifMainFileRangeChunk {
  kind: 'source';
  range: AdifByteRange;
}

export interface AdifLiteralRewriteChunk {
  kind: 'bytes';
  bytes: Uint8Array;
}

export type AdifRewriteChunk = Uint8Array | AdifMainFileRangeChunk | AdifLiteralRewriteChunk;

export function mainFileRange(start: number, end: number): AdifMainFileRangeChunk {
  return { kind: 'source', range: { start, end } };
}

export function literalAdifBytes(bytes: Uint8Array): AdifLiteralRewriteChunk {
  return { kind: 'bytes', bytes };
}

export type AdifFileStoreFaultPoint =
  | 'append-before-open'
  | 'append-after-write'
  | 'append-after-fsync'
  | 'append-before-rollback'
  | 'append-after-rollback'
  | 'rewrite-after-temp-write'
  | 'rewrite-after-temp-fsync'
  | 'rewrite-after-temp-validated'
  | 'rewrite-after-last-good-copy'
  | 'rewrite-after-last-good-fsync'
  | 'rewrite-after-last-good-rename'
  | 'rewrite-after-main-rename'
  | 'rewrite-after-directory-fsync'
  | 'recovery-after-unrecoverable-preserved'
  | 'recovery-after-main-rename';

export interface AdifFileStoreFaultContext {
  filePath: string;
  point: AdifFileStoreFaultPoint;
  oldEof?: number;
}

export interface AdifFileStoreOptions {
  fileSystem?: AdifFileSystem;
  scanner?: LogbookScanner;
  queue?: PerPathSerialQueue;
  lockOptions?: PathFileLockOptions;
  onStateChanged?: (state: AdifFileStoreHealth, issues: readonly AdifFileStoreIssue[]) => void;
  onStateUncertain?: (issue: AdifFileStoreIssue) => void;
  onScanProgress?: (progress: LogbookScanProgress) => void;
  faultHook?: (context: AdifFileStoreFaultContext) => void | Promise<void>;
  now?: () => number;
  createIfMissing?: boolean;
  /** Disable every recovery mutation while unresolved legacy artifacts remain. */
  recoveryWritesEnabled?: boolean;
}

export class AdifFileStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.name = 'AdifFileStoreError';
  }
}

export class AdifGenerationConflictError extends AdifFileStoreError {
  constructor(
    public readonly expected: GenerationToken,
    public readonly actual: GenerationToken,
  ) {
    super('The ADIF file changed before the pending mutation could commit', 'ADIF_GENERATION_CONFLICT');
    this.name = 'AdifGenerationConflictError';
  }
}

export class AdifFileCommitError extends AdifFileStoreError {
  constructor(
    public readonly operation: 'append' | 'rewrite',
    message: string,
    public readonly rolledBack: boolean,
    public readonly generation?: GenerationToken,
    options?: { cause?: unknown },
  ) {
    super(message, 'ADIF_COMMIT_FAILED', options);
    this.name = 'AdifFileCommitError';
  }
}

export class AdifFileStateUncertainError extends AdifFileStoreError {
  constructor(
    public readonly operation: 'append' | 'rewrite',
    message: string,
    public readonly rollbackError?: Error,
    options?: { cause?: unknown },
  ) {
    super(message, 'ADIF_STATE_UNCERTAIN', options);
    this.name = 'AdifFileStateUncertainError';
  }
}

export class AdifRewriteValidationError extends AdifFileStoreError {
  constructor(public readonly validationIssues: readonly string[]) {
    super(`ADIF rewrite candidate failed validation: ${validationIssues.join('; ')}`, 'ADIF_REWRITE_INVALID');
    this.name = 'AdifRewriteValidationError';
  }
}

export class AdifFileStoreReadOnlyError extends AdifFileStoreError {
  constructor(
    state: AdifFileStoreHealth,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ?? `ADIF file store cannot mutate while it is ${state}`,
      'ADIF_STORE_READ_ONLY',
      options && 'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = 'AdifFileStoreReadOnlyError';
  }
}

interface CandidateScan {
  kind: 'missing' | 'scanned' | 'error';
  result?: LogbookFileScanResult;
  error?: Error;
}

interface PreparedAppendScan {
  scan: AdifScanResult;
  recordProjections: readonly LogbookRecordProjection[];
  warnings: readonly string[];
  appendHash: string;
}

export class AdifFileStore {
  readonly filePath: string;
  readonly recoveryBaseDirectory: string;
  readonly recoveryDirectory: string;
  readonly rewriteTempPath: string;
  readonly lastGoodPath: string;
  readonly lastGoodTempPath: string;
  readonly tailFragmentPath: string;
  readonly unrecoverableOriginalPath: string;
  readonly lockPath: string;

  private readonly fileSystem: AdifFileSystem;
  private readonly scanner: LogbookScanner;
  private readonly queue: PerPathSerialQueue;
  private readonly lock: PathFileLock;
  private readonly onStateChanged?: AdifFileStoreOptions['onStateChanged'];
  private readonly onStateUncertain?: AdifFileStoreOptions['onStateUncertain'];
  private readonly onScanProgress?: AdifFileStoreOptions['onScanProgress'];
  private readonly faultHook?: AdifFileStoreOptions['faultHook'];
  private readonly now: () => number;
  private readonly createIfMissing: boolean;
  private readonly recoveryWritesEnabled: boolean;
  private readonly stateListeners = new Set<(
    state: AdifFileStoreHealth,
    issues: readonly AdifFileStoreIssue[],
  ) => void>();
  private state: AdifFileStoreHealth = 'unavailable';
  private issues: readonly AdifFileStoreIssue[] = [];
  private currentScanResult?: LogbookFileScanResult;
  private closing = false;

  constructor(filePath: string, options: AdifFileStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.recoveryBaseDirectory = path.join(path.dirname(this.filePath), '.tx5dr-recovery');
    this.recoveryDirectory = path.join(
      this.recoveryBaseDirectory,
      legacyLogbookPathHash(this.filePath),
    );
    this.rewriteTempPath = path.join(this.recoveryDirectory, 'rewrite.tmp');
    this.lastGoodPath = path.join(this.recoveryDirectory, 'last-good.adi');
    this.lastGoodTempPath = path.join(this.recoveryDirectory, 'last-good.tmp');
    this.tailFragmentPath = path.join(this.recoveryDirectory, 'tail-fragment.bin');
    this.unrecoverableOriginalPath = path.join(this.recoveryDirectory, 'unrecoverable-original.adi');
    this.lockPath = path.join(this.recoveryDirectory, 'operation.lock');
    this.fileSystem = options.fileSystem ?? nodeAdifFileSystem;
    this.scanner = options.scanner ?? new LogbookScanWorker();
    this.queue = options.queue ?? globalLogbookPathQueue;
    this.lock = new PathFileLock(this.fileSystem, this.lockPath, options.lockOptions);
    this.onStateChanged = options.onStateChanged;
    this.onStateUncertain = options.onStateUncertain;
    this.onScanProgress = options.onScanProgress;
    this.faultHook = options.faultHook;
    this.now = options.now ?? Date.now;
    this.createIfMissing = options.createIfMissing ?? true;
    this.recoveryWritesEnabled = options.recoveryWritesEnabled ?? true;
  }

  getState(): { status: AdifFileStoreHealth; issues: readonly AdifFileStoreIssue[] } {
    return { status: this.state, issues: this.issues };
  }

  subscribeState(
    listener: (state: AdifFileStoreHealth, issues: readonly AdifFileStoreIssue[]) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  open(): Promise<OpenResult> {
    return this.recoverOnOpen();
  }

  async recoverOnOpen(): Promise<OpenResult> {
    if (this.state === 'closed' || this.closing) {
      return this.publishOpenResult({
        status: 'closed',
        issues: [{ code: 'STORE_CLOSED', message: 'ADIF file store is closed', path: this.filePath }],
      });
    }

    try {
      await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true });
      return await this.queue.run(this.filePath, () => this.runLocked(() => this.recoverLocked()));
    } catch (error) {
      if (error instanceof AdifFileStateUncertainError) {
        return {
          status: 'uncertain',
          issues: this.issues.length > 0
            ? this.issues
            : [toIssue('STATE_UNCERTAIN', this.filePath, error)],
        };
      }
      return this.publishOpenResult({
        status: 'unavailable',
        issues: [toIssue('OPEN_FAILED', this.filePath, error)],
      });
    }
  }

  async commitAppend(
    buffers: readonly Uint8Array[],
    expectedGeneration?: GenerationToken,
    expectations: RewriteValidationExpectations = {},
  ): Promise<{
    generation: GenerationToken;
    scan: AdifScanResult;
    recordProjections: readonly LogbookRecordProjection[];
  }> {
    this.assertMutationAllowed();
    return this.queue.run(this.filePath, () => this.runLocked(async () => {
      this.assertMutationAllowed();
      const before = await this.scanMutationBaseline(expectedGeneration);
      this.assertExpectedGeneration(expectedGeneration, before.generation);
      if (!isCompleteScan(before.scan)) {
        throw new AdifFileCommitError(
          'append',
          'Cannot append after an incomplete ADIF tail; a validated rewrite is required first',
          false,
          before.generation,
        );
      }

      if (buffers.every(buffer => buffer.byteLength === 0)) {
        return {
          generation: before.generation,
          scan: before.scan,
          recordProjections: before.recordProjections,
        };
      }

      const appendBytes = Buffer.concat(buffers.map(buffer => Buffer.from(buffer)));
      const preparedAppend = this.prepareAppendScan(before, appendBytes);
      const oldEof = before.generation.size;
      let handle: AdifFileHandle | undefined;
      try {
        await this.injectFault('append-before-open', oldEof);
        handle = await this.fileSystem.open(this.filePath, ADIF_APPEND_FLAGS);
        await writeAll(handle, appendBytes);
        await this.injectFault('append-after-write', oldEof);
        await handle.sync();
        await this.injectFault('append-after-fsync', oldEof);
        await handle.close();
        handle = undefined;
      } catch (error) {
        const appendError = asError(error);
        const appendHandleWasOpened = handle !== undefined;
        await handle?.close().catch(() => undefined);
        handle = undefined;

        // An open failure cannot have changed the file. Likewise, a rejected
        // first write often leaves the exact content generation untouched; in
        // either case truncating would add risk without rolling anything back.
        if (!appendHandleWasOpened) {
          throw new AdifFileCommitError(
            'append',
            'ADIF append failed before the file was opened; the previous generation is unchanged',
            true,
            before.generation,
            { cause: appendError },
          );
        }
        const unchanged = await this.tryScan(this.filePath);
        if (
          unchanged.kind === 'scanned'
          && sameContentGeneration(before.generation, unchanged.result!.generation)
        ) {
          this.publishScanState(unchanged.result!);
          throw new AdifFileCommitError(
            'append',
            'ADIF append failed before changing file content',
            true,
            unchanged.result!.generation,
            { cause: appendError },
          );
        }

        const rollback = await this.rollbackAppend(handle, oldEof);
        if (!rollback.ok) {
          throw this.markUncertain(
            'append',
            appendError,
            rollback.error,
            'Append failed and the previous EOF could not be durably restored',
          );
        }
        const restored = await this.tryScan(this.filePath);
        if (restored.kind !== 'scanned') {
          throw this.markUncertain(
            'append',
            appendError,
            restored.error,
            'Append rollback completed, but the resulting ADIF file could not be verified',
          );
        }
        this.publishScanState(restored.result!);
        throw new AdifFileCommitError(
          'append',
          'ADIF append failed; the file was restored to its previous EOF',
          true,
          restored.result!.generation,
          { cause: appendError },
        );
      } finally {
        await handle?.close().catch(() => undefined);
      }

      const expectedSize = oldEof + appendBytes.byteLength;
      let committed: LogbookFileScanResult;
      try {
        committed = await this.materializeAppendResult(before, preparedAppend, expectedSize);
      } catch (error) {
        if (error instanceof AdifGenerationConflictError || error instanceof AdifFileStateUncertainError) {
          throw error;
        }
        throw this.markUncertain(
          'append',
          asError(error),
          undefined,
          'Append was fsynced, but the committed ADIF file could not be verified',
        );
      }
      if (!isCompleteScan(committed.scan)) {
        const rollback = await this.rollbackAppend(undefined, oldEof);
        if (!rollback.ok) {
          throw this.markUncertain(
            'append',
            new Error('The append produced an incomplete ADIF tail'),
            rollback.error,
            'Invalid append content could not be rolled back to the previous EOF',
          );
        }
        const restored = await this.tryScan(this.filePath);
        if (restored.kind !== 'scanned') {
          throw this.markUncertain(
            'append',
            restored.error ?? new Error('Rolled-back ADIF file is missing'),
            undefined,
            'Invalid append was rolled back, but the previous generation could not be verified',
          );
        }
        this.publishScanState(restored.result!);
        throw new AdifFileCommitError(
          'append',
          'The append produced an incomplete ADIF tail and was rolled back',
          true,
          restored.result!.generation,
        );
      }
      try {
        await this.validateRewriteCandidate(committed, expectations);
      } catch (error) {
        const rollback = await this.rollbackAppend(undefined, oldEof);
        if (!rollback.ok) {
          throw this.markUncertain(
            'append',
            asError(error),
            rollback.error,
            'The fsynced append failed projection validation and could not be rolled back',
          );
        }
        const restored = await this.tryScan(this.filePath);
        if (
          restored.kind !== 'scanned'
          || !sameContentGeneration(before.generation, restored.result!.generation)
        ) {
          throw this.markUncertain(
            'append',
            asError(error),
            restored.error,
            'The invalid append was rolled back, but the previous content generation could not be verified',
          );
        }
        this.publishScanState(restored.result!);
        throw new AdifFileCommitError(
          'append',
          'The append did not match the prepared logbook mutation and was rolled back',
          true,
          restored.result!.generation,
          { cause: error },
        );
      }
      this.publishScanState(committed);
      return {
        generation: committed.generation,
        scan: committed.scan,
        recordProjections: committed.recordProjections,
      };
    }));
  }

  async commitRewrite(
    source: Iterable<AdifRewriteChunk> | AsyncIterable<AdifRewriteChunk>,
    expectedGeneration?: GenerationToken,
    expectations: RewriteValidationExpectations = {},
  ): Promise<{
    generation: GenerationToken;
    scan: AdifScanResult;
    recordProjections: readonly LogbookRecordProjection[];
  }> {
    this.assertMutationAllowed();
    return this.queue.run(this.filePath, () => this.runLocked(async () => {
      this.assertMutationAllowed();
      const before = await this.scanMutationBaseline(expectedGeneration);
      this.assertExpectedGeneration(expectedGeneration, before.generation);
      await this.ensureRecoveryDirectory();

      const handle = await this.openRewriteTemp(await this.fileMode(this.filePath));
      try {
        await this.writeRewriteSource(handle, source, before.generation.size);
        await this.injectFault('rewrite-after-temp-write');
        await handle.sync();
        await this.injectFault('rewrite-after-temp-fsync');
      } finally {
        await handle.close().catch(() => undefined);
      }
      await fsyncDirectory(this.fileSystem, this.recoveryDirectory);

      const candidate = await this.scanRequired(this.rewriteTempPath);
      await this.validateRewriteCandidate(candidate, expectations);
      await this.injectFault('rewrite-after-temp-validated');

      const immediatelyBeforeCommit = await this.scanRequired(this.filePath);
      if (!sameGeneration(before.generation, immediatelyBeforeCommit.generation)) {
        this.throwGenerationConflict(before.generation, immediatelyBeforeCommit.generation);
      }

      if (isCompleteScan(immediatelyBeforeCommit.scan)) {
        await this.fileSystem.copyFile(this.filePath, this.lastGoodTempPath);
        await this.injectFault('rewrite-after-last-good-copy');
        await fsyncFile(this.fileSystem, this.lastGoodTempPath);
        await this.injectFault('rewrite-after-last-good-fsync');
        const backup = await this.scanRequired(this.lastGoodTempPath);
        if (backup.generation.contentHash !== immediatelyBeforeCommit.generation.contentHash) {
          throw new AdifFileCommitError(
            'rewrite',
            'The fixed last-good copy does not match the pre-rewrite ADIF file',
            false,
            immediatelyBeforeCommit.generation,
          );
        }
        await this.fileSystem.rename(this.lastGoodTempPath, this.lastGoodPath);
        await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
        await this.injectFault('rewrite-after-last-good-rename');
      }

      let mainRenamed = false;
      try {
        await this.fileSystem.rename(this.rewriteTempPath, this.filePath);
        mainRenamed = true;
        await this.injectFault('rewrite-after-main-rename');
        await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
        await this.injectFault('rewrite-after-directory-fsync');

        const committed = await this.scanRequired(this.filePath);
        if (committed.generation.contentHash !== candidate.generation.contentHash) {
          throw new Error('Post-rename ADIF content hash differs from the validated rewrite candidate');
        }
        this.publishScanState(committed);
        return {
          generation: committed.generation,
          scan: committed.scan,
          recordProjections: committed.recordProjections,
        };
      } catch (error) {
        if (!mainRenamed || error instanceof AdifFileStateUncertainError) throw error;
        throw this.markUncertain(
          'rewrite',
          asError(error),
          undefined,
          'The rewrite rename started, but final namespace durability could not be verified',
        );
      }
    }));
  }

  async readAll(expectedGeneration?: GenerationToken): Promise<{
    data: Buffer;
    generation: GenerationToken;
    scan: AdifScanResult;
  }> {
    return this.readConsistent(async () => {
      const data = await this.fileSystem.readFile(this.filePath);
      return Buffer.isBuffer(data) ? data : Buffer.from(data);
    }, expectedGeneration).then(({ value, generation, scan }) => ({ data: value, generation, scan }));
  }

  async readRange(
    range: AdifByteRange,
    expectedGeneration?: GenerationToken,
  ): Promise<{ data: Buffer; generation: GenerationToken }> {
    return this.readConsistent(async (before) => {
      this.assertValidMainRange(range, before.generation.size);
      const chunks: Buffer[] = [];
      const collector: AdifFileHandle = {
        read: async () => ({ bytesRead: 0 }),
        write: async (buffer, offset = 0, length = buffer.byteLength) => {
          chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
          return { bytesWritten: length };
        },
        sync: async () => undefined,
        truncate: async () => undefined,
        close: async () => undefined,
      };
      await this.copyMainRangeToHandle(range, collector);
      return Buffer.concat(chunks, range.end - range.start);
    }, expectedGeneration).then(({ value, generation }) => ({ data: value, generation }));
  }

  drain(): Promise<void> {
    return this.queue.drain(this.filePath);
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.closing = true;
    await this.drain();
    this.currentScanResult = undefined;
    this.publishState('closed', []);
  }

  private async recoverLocked(): Promise<OpenResult> {
    const main = await this.tryScan(this.filePath);

    if (main.kind === 'scanned' && isCompleteScan(main.result!.scan)) {
      const cleanupIssues = this.recoveryWritesEnabled
        ? await this.cleanupHealthyRecoveryArtifacts()
        : [];
      const opened = await this.resultWithPersistentRecoveryIssues(main.result!);
      return this.publishOpenResult(this.withAdditionalOpenIssues(opened, cleanupIssues));
    }

    // A scanner, permission, or main-file read failure is not evidence that
    // the formal ADIF is corrupt. Replacing it with an older fixed candidate
    // could discard valid appends, so preserve every file and require retry.
    if (main.kind === 'error') {
      return this.publishOpenResult({
        status: 'unavailable',
        issues: [toIssue('MAIN_SCAN_FAILED', this.filePath, main.error)],
      });
    }

    if (!this.recoveryWritesEnabled) {
      if (main.kind === 'scanned' && isSalvageableUnsafeTail(main.result!.scan)) {
        return this.publishOpenResult({
          ...resultFromScan(main.result!),
          status: 'read-only',
          issues: [
            ...resultFromScan(main.result!).issues,
            {
              code: 'RECOVERY_WRITE_BLOCKED',
              message: 'The complete ADIF prefix is readable, but recovery is blocked until legacy migration succeeds',
              path: this.filePath,
            },
          ],
        });
      }
      return this.publishOpenResult({
        status: 'unavailable',
        issues: [{
          code: 'RECOVERY_WRITE_BLOCKED',
          message: 'The formal ADIF cannot be safely opened without recovery, which is blocked until legacy migration succeeds',
          path: this.filePath,
        }],
      });
    }

    const retentionIssues = await this.refreshTailFragmentRetention();
    const finish = (result: OpenResult): OpenResult => this.publishOpenResult(
      this.withAdditionalOpenIssues(result, retentionIssues),
    );

    if (main.kind === 'scanned' && isSalvageableUnsafeTail(main.result!.scan)) {
      return finish(await this.salvageUnsafeTail(main.result!));
    }

    const rewrite = await this.tryScan(this.rewriteTempPath);
    const lastGood = await this.tryScan(this.lastGoodPath);

    if (rewrite.kind === 'scanned' && isCompleteScan(rewrite.result!.scan)) {
      const recovered = await this.finalizeRecoveryCandidate(this.rewriteTempPath);
      return finish({
        ...resultFromScan(recovered),
        status: 'degraded',
        issues: [
          ...resultFromScan(recovered).issues,
          { code: 'RECOVERED_REWRITE_TEMP', message: 'Finalized a validated interrupted rewrite', path: this.filePath },
        ],
        recoveredFrom: 'rewrite.tmp',
      });
    }

    if (lastGood.kind === 'scanned' && isCompleteScan(lastGood.result!.scan)) {
      await this.fileSystem.copyFile(this.lastGoodPath, this.rewriteTempPath);
      await fsyncFile(this.fileSystem, this.rewriteTempPath);
      await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
      const restoredCandidate = await this.scanRequired(this.rewriteTempPath);
      if (restoredCandidate.generation.contentHash !== lastGood.result!.generation.contentHash) {
        throw new Error('Restored rewrite candidate differs from last-good.adi');
      }
      const recovered = await this.finalizeRecoveryCandidate(this.rewriteTempPath);
      return finish({
        ...resultFromScan(recovered),
        status: 'degraded',
        issues: [
          ...resultFromScan(recovered).issues,
          { code: 'RESTORED_LAST_GOOD', message: 'Restored the fixed last-good ADIF snapshot', path: this.filePath },
        ],
        recoveredFrom: 'last-good.adi',
      });
    }

    if (main.kind === 'missing' && rewrite.kind === 'missing' && lastGood.kind === 'missing') {
      if (!this.createIfMissing) {
        return finish({
          status: 'unavailable',
          issues: [{
            code: 'MAIN_CREATION_DEFERRED',
            message: 'The formal ADIF file is missing and automatic creation was deferred to preserve legacy recovery data',
            path: this.filePath,
          }],
        });
      }
      await this.createEmptyMain();
      const created = await this.scanRequired(this.filePath);
      return finish(resultFromScan(created));
    }

    if (rewrite.kind === 'error' || lastGood.kind === 'error') {
      const issues = [
        rewrite.kind === 'error' ? toIssue('REWRITE_TEMP_SCAN_FAILED', this.rewriteTempPath, rewrite.error) : undefined,
        lastGood.kind === 'error' ? toIssue('LAST_GOOD_SCAN_FAILED', this.lastGoodPath, lastGood.error) : undefined,
      ].filter((issue): issue is AdifFileStoreIssue => issue !== undefined);
      return finish({ status: 'unavailable', issues });
    }

    const unrecoverableSource = main.kind === 'scanned'
      ? { path: this.filePath, result: main.result! }
      : rewrite.kind === 'scanned'
        ? { path: this.rewriteTempPath, result: rewrite.result! }
        : lastGood.kind === 'scanned'
          ? { path: this.lastGoodPath, result: lastGood.result! }
          : undefined;

    if (unrecoverableSource) {
      return finish(await this.resetUnrecoverableSource(
        unrecoverableSource.path,
        unrecoverableSource.result,
      ));
    }

    return finish({
      status: 'unavailable',
      issues: [{ code: 'NO_USABLE_LOGBOOK', message: 'No ADIF recovery source is available', path: this.filePath }],
    });
  }

  private withAdditionalOpenIssues(
    result: OpenResult,
    issues: readonly AdifFileStoreIssue[],
  ): OpenResult {
    if (issues.length === 0) return result;
    return {
      ...result,
      status: result.status === 'ready' ? 'degraded' : result.status,
      issues: [...result.issues, ...issues],
    };
  }

  private async cleanupHealthyRecoveryArtifacts(): Promise<AdifFileStoreIssue[]> {
    const issues: AdifFileStoreIssue[] = [];
    for (const artifactPath of [this.rewriteTempPath, this.lastGoodTempPath]) {
      try {
        await this.removeRecoveryArtifact(artifactPath);
      } catch (error) {
        issues.push(toIssue('CLEANUP_PENDING', artifactPath, error));
      }
    }
    try {
      await this.removeExpiredTailFragment();
    } catch (error) {
      issues.push(toIssue('CLEANUP_PENDING', this.tailFragmentPath, error));
    }
    return issues;
  }

  private async refreshTailFragmentRetention(): Promise<AdifFileStoreIssue[]> {
    try {
      const observedAt = new Date(this.now());
      await this.fileSystem.utimes(this.tailFragmentPath, observedAt, observedAt);
      return [];
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      return [toIssue('CLEANUP_PENDING', this.tailFragmentPath, error)];
    }
  }

  private async createEmptyMain(): Promise<void> {
    const handle = await this.fileSystem.open(this.filePath, ADIF_EXCLUSIVE_CREATE_FLAGS, 0o600);
    try {
      await writeAll(handle, encodeAdifHeader());
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
  }

  private async resultWithPersistentRecoveryIssues(result: LogbookFileScanResult): Promise<OpenResult> {
    const base = resultFromScan(result);
    const persistentIssues: AdifFileStoreIssue[] = [];
    if (await pathExists(this.fileSystem, this.tailFragmentPath)) {
      persistentIssues.push({
        code: 'TAIL_FRAGMENT_PRESERVED',
        message: 'An unsafe trailing fragment is preserved for manual inspection',
        path: this.tailFragmentPath,
      });
    }
    if (await pathExists(this.fileSystem, this.unrecoverableOriginalPath)) {
      persistentIssues.push({
        code: 'UNRECOVERABLE_ORIGINAL_PRESERVED',
        message: 'An unrecoverable original ADIF file is preserved for manual inspection',
        path: this.unrecoverableOriginalPath,
      });
    }
    return persistentIssues.length === 0
      ? base
      : { ...base, status: 'degraded', issues: [...base.issues, ...persistentIssues] };
  }

  private async removeExpiredTailFragment(): Promise<void> {
    try {
      const stat = await this.fileSystem.stat(this.tailFragmentPath);
      if (this.now() - stat.mtimeMs < LOGBOOK_TAIL_FRAGMENT_RETENTION_MS) return;
      await this.removeRecoveryArtifact(this.tailFragmentPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async salvageUnsafeTail(main: LogbookFileScanResult): Promise<OpenResult> {
    const tailRange = main.scan.incompleteTailRange!;
    const preserved = await this.preserveFileRangeExclusive(
      this.filePath,
      tailRange,
      this.tailFragmentPath,
    );
    if (!preserved) {
      const [existingHash, currentHash] = await Promise.all([
        this.hashFileRange(this.tailFragmentPath, {
          start: 0,
          end: (await this.fileSystem.stat(this.tailFragmentPath)).size,
        }),
        this.hashFileRange(this.filePath, tailRange),
      ]);
      if (existingHash !== currentHash) {
        return {
          ...resultFromScan(main),
          status: 'read-only',
          issues: [
            ...resultFromScan(main).issues,
            {
              code: 'TAIL_FRAGMENT_CONFLICT',
              message: 'A different fixed tail fragment already exists; the current unsafe tail was left untouched',
              path: this.tailFragmentPath,
            },
          ],
        };
      }
    }

    await this.writeRecoveryCandidate(
      [mainFileRange(0, main.scan.safeEnd)],
      main.generation.size,
    );
    const candidate = await this.scanRequired(this.rewriteTempPath);
    await this.validateRewriteCandidate(candidate, {});
    const recovered = await this.finalizeRecoveryCandidate(this.rewriteTempPath);
    return {
      ...resultFromScan(recovered),
      status: 'degraded',
      issues: [
        ...resultFromScan(recovered).issues,
        {
          code: 'TRUNCATED_UNSAFE_TAIL',
          message: 'Preserved an unsafe trailing fragment and committed the complete ADIF prefix',
          path: this.tailFragmentPath,
        },
      ],
      recoveredFrom: 'safe-prefix',
    };
  }

  private async resetUnrecoverableSource(
    sourcePath: string,
    source: LogbookFileScanResult,
  ): Promise<OpenResult> {
    const existingOriginal = await this.tryScan(this.unrecoverableOriginalPath);
    if (
      existingOriginal.kind === 'scanned'
      && existingOriginal.result!.generation.contentHash !== source.generation.contentHash
    ) {
      return {
        status: 'unavailable',
        generation: sourcePath === this.filePath ? source.generation : undefined,
        scan: sourcePath === this.filePath ? source.scan : undefined,
        issues: [{
          code: 'UNRECOVERABLE_ORIGINAL_CONFLICT',
          message: 'The fixed unrecoverable-original.adi already exists and will not be overwritten',
          path: this.unrecoverableOriginalPath,
        }],
      };
    }
    if (existingOriginal.kind === 'error') {
      return {
        status: 'unavailable',
        generation: sourcePath === this.filePath ? source.generation : undefined,
        scan: sourcePath === this.filePath ? source.scan : undefined,
        issues: [toIssue(
          'UNRECOVERABLE_ORIGINAL_SCAN_FAILED',
          this.unrecoverableOriginalPath,
          existingOriginal.error,
        )],
      };
    }

    if (existingOriginal.kind === 'missing') {
      const preserved = await this.preserveFileRangeExclusive(
        sourcePath,
        { start: 0, end: source.generation.size },
        this.unrecoverableOriginalPath,
      );
      if (!preserved) {
        const racedOriginal = await this.scanRequired(this.unrecoverableOriginalPath);
        if (racedOriginal.generation.contentHash !== source.generation.contentHash) {
          return {
            status: 'unavailable',
            generation: sourcePath === this.filePath ? source.generation : undefined,
            scan: sourcePath === this.filePath ? source.scan : undefined,
            issues: [{
              code: 'UNRECOVERABLE_ORIGINAL_CONFLICT',
              message: 'A different fixed unrecoverable-original.adi appeared during recovery',
              path: this.unrecoverableOriginalPath,
            }],
          };
        }
      }
    }
    await this.injectFault('recovery-after-unrecoverable-preserved');
    await this.writeRecoveryCandidate(
      [literalAdifBytes(encodeAdifHeader())],
      source.generation.size,
      sourcePath,
    );
    const candidate = await this.scanRequired(this.rewriteTempPath);
    await this.validateRewriteCandidate(candidate, { recordCount: 0 });
    const recovered = await this.finalizeRecoveryCandidate(this.rewriteTempPath);
    return {
      ...resultFromScan(recovered),
      status: 'degraded',
      issues: [{
        code: 'RESET_UNRECOVERABLE_MAIN',
        message: 'Preserved the unrecoverable source and created a standard empty ADIF logbook',
        path: this.unrecoverableOriginalPath,
      }],
      recoveredFrom: 'standard-empty',
    };
  }

  private async writeRecoveryCandidate(
    source: Iterable<AdifRewriteChunk> | AsyncIterable<AdifRewriteChunk>,
    mainSize: number,
    modeSourcePath = this.filePath,
  ): Promise<void> {
    const handle = await this.openRewriteTemp(await this.fileMode(modeSourcePath));
    try {
      await this.writeRewriteSource(handle, source, mainSize);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
  }

  private async fileMode(filePath: string): Promise<number | undefined> {
    try {
      const mode = (await this.fileSystem.stat(filePath)).mode;
      return mode === undefined ? undefined : mode & 0o7777;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async openRewriteTemp(mode: number | undefined): Promise<AdifFileHandle> {
    const handle = await this.fileSystem.open(
      this.rewriteTempPath,
      ADIF_REWRITE_FLAGS,
      mode ?? 0o600,
    );
    try {
      if (mode !== undefined) await this.fileSystem.chmod(this.rewriteTempPath, mode);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async finalizeRecoveryCandidate(candidatePath: string): Promise<LogbookFileScanResult> {
    let renamed = false;
    try {
      await this.fileSystem.rename(candidatePath, this.filePath);
      renamed = true;
      await this.injectFault('recovery-after-main-rename');
      await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
      await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
      const committed = await this.scanRequired(this.filePath);
      if (!isCompleteScan(committed.scan)) {
        throw new Error('The finalized recovery candidate is not a complete ADIF file');
      }
      return committed;
    } catch (error) {
      if (!renamed) throw error;
      throw this.markUncertain(
        'rewrite',
        asError(error),
        undefined,
        'Recovery renamed the main ADIF file, but final durability could not be verified',
      );
    }
  }

  private async preserveFileRangeExclusive(
    sourcePath: string,
    range: AdifByteRange,
    targetPath: string,
  ): Promise<boolean> {
    let handle: AdifFileHandle | undefined;
    try {
      handle = await this.fileSystem.open(targetPath, ADIF_EXCLUSIVE_CREATE_FLAGS, 0o600);
      await this.copyFileRangeToHandle(sourcePath, range, handle);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
      return true;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
  }

  private async writeRewriteSource(
    handle: AdifFileHandle,
    source: Iterable<AdifRewriteChunk> | AsyncIterable<AdifRewriteChunk>,
    mainSize: number,
  ): Promise<void> {
    let sourceHandle: AdifFileHandle | undefined;
    let copyBuffer: Buffer | undefined;
    let pendingRange: AdifByteRange | undefined;
    const flushPendingRange = async () => {
      if (!pendingRange || pendingRange.end === pendingRange.start) {
        pendingRange = undefined;
        return;
      }
      sourceHandle ??= await this.fileSystem.open(this.filePath, 'r');
      copyBuffer ??= Buffer.allocUnsafe(1024 * 1024);
      await this.copyRangeFromHandle(sourceHandle, pendingRange, handle, copyBuffer);
      pendingRange = undefined;
    };

    try {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array) && chunk.kind === 'source') {
          this.assertValidMainRange(chunk.range, mainSize);
          if (pendingRange?.end === chunk.range.start) {
            pendingRange = { start: pendingRange.start, end: chunk.range.end };
          } else {
            await flushPendingRange();
            pendingRange = { ...chunk.range };
          }
          continue;
        }

        await flushPendingRange();
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.bytes;
        if (bytes.byteLength > 0) await writeAll(handle, bytes);
      }
      await flushPendingRange();
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
  }

  private copyMainRangeToHandle(range: AdifByteRange, target: AdifFileHandle): Promise<void> {
    return this.copyFileRangeToHandle(this.filePath, range, target);
  }

  private async copyFileRangeToHandle(
    sourcePath: string,
    range: AdifByteRange,
    target: AdifFileHandle,
  ): Promise<void> {
    const source = await this.fileSystem.open(sourcePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      await this.copyRangeFromHandle(source, range, target, buffer);
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  private async copyRangeFromHandle(
    source: AdifFileHandle,
    range: AdifByteRange,
    target: AdifFileHandle,
    buffer: Buffer,
  ): Promise<void> {
    let position = range.start;
    while (position < range.end) {
      const requested = Math.min(buffer.byteLength, range.end - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0) {
        throw new Error(`File read made no forward progress at byte ${position}`);
      }
      await writeAll(target, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  }

  private async hashFileRange(filePath: string, range: AdifByteRange): Promise<string> {
    const hasher = createHash('sha256');
    const sink: AdifFileHandle = {
      read: async () => ({ bytesRead: 0 }),
      write: async (buffer, offset = 0, length = buffer.byteLength) => {
        hasher.update(buffer.subarray(offset, offset + length));
        return { bytesWritten: length };
      },
      sync: async () => undefined,
      truncate: async () => undefined,
      close: async () => undefined,
    };
    await this.copyFileRangeToHandle(filePath, range, sink);
    return hasher.digest('hex');
  }

  private prepareAppendScan(
    before: LogbookFileScanResult,
    appendBytes: Buffer,
  ): PreparedAppendScan {
    const appended = scanAdifBuffer(appendBytes);
    if (!isCompleteScan(appended)) {
      throw new AdifFileCommitError(
        'append',
        'The prepared append contains an incomplete ADIF tail',
        true,
        before.generation,
      );
    }
    if (appended.headerRange) {
      throw new AdifFileCommitError(
        'append',
        'An ADIF header cannot be appended after the current physical EOF',
        true,
        before.generation,
      );
    }

    const projector = new LogbookRecordProjector(
      before.scan.records,
      before.recordProjections,
    );
    const appendedProjections = appended.records.map(record => projector.project(record));
    const scan = mergeAppendedScan(before.scan, appended, appendBytes);
    return {
      scan,
      recordProjections: Object.freeze([
        ...before.recordProjections,
        ...appendedProjections,
      ]),
      warnings: Object.freeze([
        ...before.warnings,
        ...scan.issues
          .slice(before.scan.issues.length)
          .map(issue => issue.message),
      ]),
      appendHash: createHash('sha256').update(appendBytes).digest('hex'),
    };
  }

  private async materializeAppendResult(
    before: LogbookFileScanResult,
    prepared: PreparedAppendScan,
    expectedSize: number,
  ): Promise<LogbookFileScanResult> {
    const statBeforeHash = await this.fileSystem.stat(this.filePath);
    if (!statBeforeHash.isFile() || statBeforeHash.size !== expectedSize) {
      throw this.markUncertain(
        'append',
        new Error(`Expected ${expectedSize} bytes after append, found ${statBeforeHash.size}`),
        undefined,
        'Append was fsynced, but the resulting EOF was not the expected generation',
      );
    }

    // Revalidate the old prefix separately. This detects an in-place external
    // replacement even when inode, size, and mtime were deliberately restored.
    const prefixHash = await this.hashFileRange(this.filePath, {
      start: 0,
      end: before.generation.size,
    });
    if (prefixHash !== before.generation.contentHash) {
      const actual = await this.scanRequired(this.filePath).catch(() => undefined);
      if (actual) this.throwGenerationConflict(before.generation, actual.generation);
      throw this.markUncertain(
        'append',
        new Error('The pre-append ADIF prefix changed during the mutation'),
        undefined,
        'Append reached EOF, but the preceding ADIF generation could not be verified',
      );
    }

    const appendHash = await this.hashFileRange(this.filePath, {
      start: before.generation.size,
      end: expectedSize,
    });
    if (appendHash !== prepared.appendHash) {
      throw this.markUncertain(
        'append',
        new Error('The committed ADIF suffix differs from the prepared append bytes'),
        undefined,
        'Append reached the expected EOF, but the committed bytes could not be verified',
      );
    }

    const contentHash = await this.hashFileRange(this.filePath, { start: 0, end: expectedSize });
    const statAfterHash = await this.fileSystem.stat(this.filePath);
    if (!sameFileStat(statBeforeHash, statAfterHash)) {
      throw this.markUncertain(
        'append',
        new Error('The ADIF file changed while its committed generation was being hashed'),
        undefined,
        'Append was fsynced, but the resulting generation did not remain stable',
      );
    }

    const scanHash = hashStructuralScan(prepared.scan);
    return {
      scan: prepared.scan,
      recordProjections: prepared.recordProjections,
      warnings: prepared.warnings,
      generation: buildGenerationToken(
        statAfterHash.size,
        statAfterHash.mtimeMs,
        contentHash,
        scanHash,
        statAfterHash.dev,
        statAfterHash.ino,
      ),
    };
  }

  private assertValidMainRange(range: AdifByteRange, mainSize: number): void {
    if (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.end)
      || range.start < 0
      || range.end < range.start
      || range.end > mainSize
    ) {
      throw new RangeError(`ADIF source range ${range.start}:${range.end} is outside 0:${mainSize}`);
    }
  }

  private async rollbackAppend(
    handle: AdifFileHandle | undefined,
    oldEof: number,
  ): Promise<{ ok: true } | { ok: false; error: Error }> {
    try {
      await this.injectFault('append-before-rollback', oldEof);
      await handle?.close().catch(() => undefined);
      const rollbackHandle = await this.fileSystem.open(this.filePath, 'r+');
      try {
        await rollbackHandle.truncate(oldEof);
        await rollbackHandle.sync();
        await this.injectFault('append-after-rollback', oldEof);
      } finally {
        await rollbackHandle.close().catch(() => undefined);
      }
      return { ok: true };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      return { ok: false, error: asError(error) };
    }
  }

  private async validateRewriteCandidate(
    candidate: LogbookFileScanResult,
    expectations: RewriteValidationExpectations,
  ): Promise<void> {
    const failures: string[] = [];
    if (!isCompleteScan(candidate.scan)) failures.push('candidate has an incomplete tail');
    if (
      expectations.requireSyntacticallyValidRecords
      && candidate.scan.records.some(record => !record.syntacticallyValid)
    ) {
      failures.push('candidate contains syntactically invalid records');
    }
    if (
      expectations.recordCount !== undefined
      && candidate.scan.records.length !== expectations.recordCount
    ) {
      failures.push(`expected ${expectations.recordCount} records, found ${candidate.scan.records.length}`);
    }
    if (
      expectations.minimumRecordCount !== undefined
      && candidate.scan.records.length < expectations.minimumRecordCount
    ) {
      failures.push(`expected at least ${expectations.minimumRecordCount} records, found ${candidate.scan.records.length}`);
    }
    if (
      expectations.contentHash !== undefined
      && candidate.generation.contentHash !== expectations.contentHash
    ) {
      failures.push('candidate content hash differs from the expected hash');
    }
    if (expectations.scanHash !== undefined && candidate.generation.scanHash !== expectations.scanHash) {
      failures.push('candidate structural scan hash differs from the expected hash');
    }
    if (failures.length > 0) throw new AdifRewriteValidationError(failures);
    await expectations.validate?.(
      candidate.scan,
      candidate.generation,
      candidate.recordProjections,
    );
  }

  private async readConsistent<T>(
    reader: (before: LogbookFileScanResult) => Promise<T>,
    expectedGeneration?: GenerationToken,
  ): Promise<{ value: T; generation: GenerationToken; scan: AdifScanResult }> {
    if (this.closing || this.state === 'closed') throw new AdifFileStoreReadOnlyError(this.state);
    return this.queue.run(this.filePath, () => this.runLocked(async () => {
      const before = await this.scanRequired(this.filePath);
      this.assertExpectedGeneration(expectedGeneration, before.generation);
      const value = await reader(before);
      const after = await this.scanRequired(this.filePath);
      if (!sameGeneration(before.generation, after.generation)) {
        this.throwGenerationConflict(before.generation, after.generation);
      }
      return { value, generation: after.generation, scan: after.scan };
    }));
  }

  private async runLocked<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureRecoveryDirectory();
    try {
      return await this.lock.run(operation);
    } finally {
      await this.cleanupEmptyRecoveryDirectories().catch(() => undefined);
    }
  }

  private async ensureRecoveryDirectory(): Promise<void> {
    const baseExisted = await pathExists(this.fileSystem, this.recoveryBaseDirectory);
    const rootExisted = await pathExists(this.fileSystem, this.recoveryDirectory);
    await this.fileSystem.mkdir(this.recoveryDirectory, { recursive: true, mode: 0o700 });
    if (!baseExisted) await fsyncDirectory(this.fileSystem, path.dirname(this.recoveryBaseDirectory));
    if (!rootExisted) await fsyncDirectory(this.fileSystem, this.recoveryBaseDirectory);
  }

  private async cleanupEmptyRecoveryDirectories(): Promise<void> {
    try {
      if ((await this.fileSystem.readdir(this.recoveryDirectory)).length === 0) {
        await this.fileSystem.rmdir(this.recoveryDirectory);
        await fsyncDirectory(this.fileSystem, this.recoveryBaseDirectory);
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
    }

    try {
      if ((await this.fileSystem.readdir(this.recoveryBaseDirectory)).length === 0) {
        await this.fileSystem.rmdir(this.recoveryBaseDirectory);
        await fsyncDirectory(this.fileSystem, path.dirname(this.recoveryBaseDirectory));
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
    }
  }

  private async removeRecoveryArtifact(filePath: string): Promise<void> {
    try {
      await this.fileSystem.unlink(filePath);
      await fsyncDirectory(this.fileSystem, this.recoveryDirectory);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async scanRequired(filePath: string): Promise<LogbookFileScanResult> {
    return this.scanner.scan(filePath, this.onScanProgress);
  }

  /**
   * Reuse structural projections only after re-hashing the current bytes. File
   * metadata is an optimization hint, not generation proof: an in-place writer
   * can preserve inode, size, and even restore mtime after replacing content.
   */
  private async scanCurrentGeneration(
    expected: GenerationToken | undefined,
  ): Promise<LogbookFileScanResult> {
    const cached = this.currentScanResult;
    if (expected && cached && sameGeneration(expected, cached.generation)) {
      const stat = await this.fileSystem.stat(this.filePath);
      if (
        stat.isFile()
        && stat.size === cached.generation.size
        && stat.mtimeMs === cached.generation.mtimeMs
        && (cached.generation.dev === undefined || stat.dev === cached.generation.dev)
        && (cached.generation.ino === undefined || stat.ino === cached.generation.ino)
      ) {
        const contentHash = await this.hashFileRange(this.filePath, { start: 0, end: stat.size });
        const after = await this.fileSystem.stat(this.filePath);
        if (
          after.isFile()
          && after.size === stat.size
          && after.mtimeMs === stat.mtimeMs
          && (stat.dev === undefined || after.dev === stat.dev)
          && (stat.ino === undefined || after.ino === stat.ino)
          && contentHash === cached.generation.contentHash
        ) {
          return cached;
        }
      }
    }
    return this.scanRequired(this.filePath);
  }

  private async scanMutationBaseline(
    expected: GenerationToken | undefined,
  ): Promise<LogbookFileScanResult> {
    try {
      return await this.scanCurrentGeneration(expected);
    } catch (error) {
      const missing = errorCode(error) === 'ENOENT';
      const issue = missing
        ? toIssue(
            'MAIN_FILE_MISSING',
            this.filePath,
            error,
            'The formal ADIF file disappeared after it was opened; explicit reopen is required',
          )
        : toIssue(
            'MAIN_SCAN_FAILED',
            this.filePath,
            error,
            'The formal ADIF generation could not be verified before writing; explicit reopen is required',
          );
      this.publishState('read-only', [issue]);
      throw new AdifFileStoreReadOnlyError('read-only', {
        cause: error,
        message: issue.message,
      });
    }
  }

  private async tryScan(filePath: string): Promise<CandidateScan> {
    try {
      if (!await pathExists(this.fileSystem, filePath)) return { kind: 'missing' };
      return { kind: 'scanned', result: await this.scanRequired(filePath) };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
      return { kind: 'error', error: asError(error) };
    }
  }

  private assertExpectedGeneration(
    expected: GenerationToken | undefined,
    actual: GenerationToken,
  ): void {
    if (expected && !sameGeneration(expected, actual)) {
      this.throwGenerationConflict(expected, actual);
    }
  }

  private throwGenerationConflict(expected: GenerationToken, actual: GenerationToken): never {
    this.publishState('read-only', [{
      code: 'GENERATION_CONFLICT',
      message: 'The ADIF file changed outside the expected mutation generation; explicit reopen is required',
      path: this.filePath,
    }]);
    throw new AdifGenerationConflictError(expected, actual);
  }

  private assertMutationAllowed(): void {
    const blocked = this.closing
      || this.state === 'closed'
      || this.state === 'uncertain'
      || this.state === 'unavailable'
      || this.state === 'read-only';
    if (blocked) {
      throw new AdifFileStoreReadOnlyError(this.state);
    }
  }

  private async injectFault(point: AdifFileStoreFaultPoint, oldEof?: number): Promise<void> {
    await this.faultHook?.({ filePath: this.filePath, point, oldEof });
  }

  private markUncertain(
    operation: 'append' | 'rewrite',
    cause: Error,
    rollbackError: Error | undefined,
    message: string,
  ): AdifFileStateUncertainError {
    const issue = toIssue('STATE_UNCERTAIN', this.filePath, rollbackError ?? cause, message);
    this.publishState('uncertain', [issue]);
    try {
      this.onStateUncertain?.(issue);
    } catch {
      // State reporting must not replace the typed persistence failure.
    }
    return new AdifFileStateUncertainError(operation, message, rollbackError, { cause });
  }

  private publishScanState(result: LogbookFileScanResult): void {
    this.currentScanResult = result;
    const openResult = resultFromScan(result);
    this.publishState(openResult.status, openResult.issues);
  }

  private publishOpenResult(result: OpenResult): OpenResult {
    if (
      (result.status === 'ready' || result.status === 'degraded')
      && result.scan
      && result.generation
      && result.recordProjections
    ) {
      this.currentScanResult = {
        scan: result.scan,
        generation: result.generation,
        recordProjections: result.recordProjections,
        warnings: result.scan.issues.map(issue => issue.message),
      };
    }
    this.publishState(result.status, result.issues);
    return result;
  }

  private publishState(state: AdifFileStoreHealth, issues: readonly AdifFileStoreIssue[]): void {
    this.state = state;
    this.issues = Object.freeze([...issues]);
    try {
      this.onStateChanged?.(state, this.issues);
    } catch {
      // Observers are advisory and cannot participate in the durability result.
    }
    for (const listener of this.stateListeners) {
      try {
        listener(state, this.issues);
      } catch {
        // One observer must not prevent the remaining observers from seeing state.
      }
    }
  }
}

function shiftedRange(range: AdifByteRange, offset: number): AdifByteRange {
  return { start: range.start + offset, end: range.end + offset };
}

function shiftedIssue(issue: AdifScanIssue, offset: number): AdifScanIssue {
  return { ...issue, offset: issue.offset + offset };
}

function mergeAppendedScan(
  before: AdifScanResult,
  appended: AdifScanResult,
  appendBytes: Buffer,
): AdifScanResult {
  const offset = before.byteLength;
  const existingRecordCount = before.records.length;
  const appendedRecords: ScannedAdifRecord[] = appended.records.map((record, index) => {
    const range = shiftedRange(record.range, offset);
    const leadingRange = index === 0
      ? existingRecordCount > 0
        ? { start: before.safeTrailingRange.start, end: range.start }
        : { start: range.start, end: range.start }
      : shiftedRange(record.leadingRange, offset);
    return {
      ...record,
      leadingRange,
      range,
      fields: [],
      issues: record.issues.map(issue => shiftedIssue(issue, offset)),
    };
  });

  const bridgeIssues: AdifScanIssue[] = [];
  if (existingRecordCount > 0 && appended.records.length > 0) {
    const prefix = appendBytes.subarray(appended.prefixRange.start, appended.prefixRange.end);
    const nonWhitespace = prefix.findIndex(byte => !isAsciiWhitespace(byte));
    if (nonWhitespace >= 0) {
      bridgeIssues.push({
        code: 'non-whitespace-between-records',
        offset: offset + nonWhitespace,
        message: 'Non-whitespace bytes appear between complete ADIF records',
      });
    }
  }

  const records = [...before.records, ...appendedRecords];
  const byteLength = offset + appended.byteLength;
  const prefixRange = existingRecordCount > 0
    ? before.prefixRange
    : appendedRecords.length > 0
      ? { start: 0, end: appendedRecords[0]!.range.start }
      : { start: 0, end: byteLength };
  const safeTrailingRange = appendedRecords.length > 0
    ? shiftedRange(appended.safeTrailingRange, offset)
    : existingRecordCount > 0
      ? { start: before.safeTrailingRange.start, end: byteLength }
      : { start: byteLength, end: byteLength };

  return {
    byteLength,
    headerRange: before.headerRange,
    prefixRange,
    records,
    safeTrailingRange,
    safeEnd: byteLength,
    issues: [
      ...before.issues,
      ...bridgeIssues,
      ...appended.issues.map(issue => shiftedIssue(issue, offset)),
    ],
  };
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0d
    || byte === 0x0b
    || byte === 0x0c;
}

function sameFileStat(
  left: { size: number; mtimeMs: number; dev?: number; ino?: number; isFile(): boolean },
  right: { size: number; mtimeMs: number; dev?: number; ino?: number; isFile(): boolean },
): boolean {
  return left.isFile()
    && right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.dev === right.dev
    && left.ino === right.ino;
}

function resultFromScan(result: LogbookFileScanResult): OpenResult {
  const degraded = !isCompleteScan(result.scan)
    || result.scan.issues.length > 0
    || result.scan.records.some(record => !record.syntacticallyValid);
  return {
    status: degraded ? 'degraded' : 'ready',
    generation: result.generation,
    scan: result.scan,
    recordProjections: result.recordProjections,
    issues: result.scan.issues.map(issue => ({
      code: `ADIF_${issue.code.toUpperCase().replaceAll('-', '_')}`,
      message: issue.message,
    })),
  };
}

function isCompleteScan(scan: AdifScanResult): boolean {
  return scan.incompleteTailRange === undefined && scan.safeEnd === scan.byteLength;
}

function isSalvageableUnsafeTail(scan: AdifScanResult): boolean {
  return scan.incompleteTailRange !== undefined
    && scan.incompleteTailRange.end > scan.incompleteTailRange.start
    && scan.safeEnd > 0
    && (scan.records.length > 0 || scan.headerRange !== undefined);
}

function sameGeneration(left: GenerationToken, right: GenerationToken): boolean {
  return left.token === right.token
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.contentHash === right.contentHash
    && left.scanHash === right.scanHash;
}

function sameContentGeneration(left: GenerationToken, right: GenerationToken): boolean {
  return left.size === right.size
    && left.contentHash === right.contentHash
    && left.scanHash === right.scanHash;
}

function toIssue(
  code: string,
  filePath: string,
  error: unknown,
  message?: string,
): AdifFileStoreIssue {
  const cause = asError(error);
  return {
    code,
    path: filePath,
    message: message ?? cause.message,
    cause: cause.message,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
