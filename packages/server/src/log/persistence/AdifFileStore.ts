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
  nodeAdifFileSystem,
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
import { globalLogbookPathQueue, type PerPathSerialQueue } from './PerPathSerialQueue.js';
import {
  LogbookRecordProjector,
  type LogbookRecordProjection,
} from './LogbookDocument.js';

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
  affectedBytes?: number;
}

export interface OpenResult {
  status: AdifFileStoreHealth;
  issues: readonly AdifFileStoreIssue[];
  generation?: GenerationToken;
  scan?: AdifScanResult;
  recordProjections?: readonly LogbookRecordProjection[];
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
  | 'rewrite-after-main-rename'
  | 'rewrite-after-directory-fsync';

export interface AdifFileStoreFaultContext {
  filePath: string;
  point: AdifFileStoreFaultPoint;
  oldEof?: number;
}

export interface AdifFileStoreOptions {
  fileSystem?: AdifFileSystem;
  scanner?: LogbookScanner;
  queue?: PerPathSerialQueue;
  onStateChanged?: (state: AdifFileStoreHealth, issues: readonly AdifFileStoreIssue[]) => void;
  onStateUncertain?: (issue: AdifFileStoreIssue) => void;
  onScanProgress?: (progress: LogbookScanProgress) => void;
  faultHook?: (context: AdifFileStoreFaultContext) => void | Promise<void>;
  createIfMissing?: boolean;
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
  readonly rewriteTempPath: string;

  private readonly fileSystem: AdifFileSystem;
  private readonly scanner: LogbookScanner;
  private readonly queue: PerPathSerialQueue;
  private readonly onStateChanged?: AdifFileStoreOptions['onStateChanged'];
  private readonly onStateUncertain?: AdifFileStoreOptions['onStateUncertain'];
  private readonly onScanProgress?: AdifFileStoreOptions['onScanProgress'];
  private readonly faultHook?: AdifFileStoreOptions['faultHook'];
  private readonly createIfMissing: boolean;
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
    this.rewriteTempPath = `${this.filePath}.rewrite.tmp`;
    this.fileSystem = options.fileSystem ?? nodeAdifFileSystem;
    this.scanner = options.scanner ?? new LogbookScanWorker();
    this.queue = options.queue ?? globalLogbookPathQueue;
    this.onStateChanged = options.onStateChanged;
    this.onStateUncertain = options.onStateUncertain;
    this.onScanProgress = options.onScanProgress;
    this.faultHook = options.faultHook;
    this.createIfMissing = options.createIfMissing ?? true;
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
      return await this.queue.run(this.filePath, () => this.openLocked());
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
    return this.queue.run(this.filePath, async () => {
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
        if (rollback.ok === false) {
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
        if (rollback.ok === false) {
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
        if (rollback.ok === false) {
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
    });
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
    return this.queue.run(this.filePath, async () => {
      this.assertMutationAllowed();
      const before = await this.scanMutationBaseline(expectedGeneration);
      this.assertExpectedGeneration(expectedGeneration, before.generation);

      let mainRenamed = false;
      try {
        const handle = await this.openRewriteTemp(await this.fileMode(this.filePath));
        try {
          await this.writeRewriteSource(handle, source, before.generation.size);
          await this.injectFault('rewrite-after-temp-write');
          await handle.sync();
          await this.injectFault('rewrite-after-temp-fsync');
        } finally {
          await handle.close().catch(() => undefined);
        }

        const candidate = await this.scanRequired(this.rewriteTempPath);
        await this.validateRewriteCandidate(candidate, expectations);
        await this.injectFault('rewrite-after-temp-validated');

        const immediatelyBeforeCommit = await this.scanRequired(this.filePath);
        if (!sameGeneration(before.generation, immediatelyBeforeCommit.generation)) {
          this.throwGenerationConflict(before.generation, immediatelyBeforeCommit.generation);
        }

        await this.fileSystem.rename(this.rewriteTempPath, this.filePath);
        mainRenamed = true;
        await this.injectFault('rewrite-after-main-rename');
        let directorySyncIssue: AdifFileStoreIssue | undefined;
        try {
          const synchronized = await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
          if (!synchronized) {
            directorySyncIssue = {
              code: 'DIRECTORY_SYNC_UNSUPPORTED',
              message: 'The ADIF content is committed, but this platform does not support directory synchronization',
              path: path.dirname(this.filePath),
            };
          }
        } catch (error) {
          directorySyncIssue = toIssue(
            'DIRECTORY_SYNC_FAILED',
            path.dirname(this.filePath),
            error,
            'The ADIF content is committed, but directory metadata durability could not be confirmed',
          );
        }
        await this.injectFault('rewrite-after-directory-fsync');

        const committed = await this.scanRequired(this.filePath);
        if (!sameContentGeneration(committed.generation, candidate.generation)) {
          throw new Error('Post-rename ADIF content hash differs from the validated rewrite candidate');
        }
        this.publishCommittedScan(committed, directorySyncIssue);
        return {
          generation: committed.generation,
          scan: committed.scan,
          recordProjections: committed.recordProjections,
        };
      } catch (error) {
        if (!mainRenamed) {
          await this.fileSystem.unlink(this.rewriteTempPath).catch(() => undefined);
          throw error;
        }
        if (error instanceof AdifFileStateUncertainError) throw error;
        throw this.markUncertain(
          'rewrite',
          asError(error),
          undefined,
          'The rewrite rename started, but final namespace durability could not be verified',
        );
      }
    });
  }

  /**
   * Explicitly replaces the formal logbook with a validated ADIF file. The
   * caller owns any pre-restore backup; this transaction never creates one.
   */
  async commitReplaceFromFile(
    sourcePath: string,
    expectedGeneration?: GenerationToken,
    options: {
      beforeReplace?: () => void | Promise<void>;
    } = {},
  ): Promise<{
    generation: GenerationToken;
    scan: AdifScanResult;
    recordProjections: readonly LogbookRecordProjection[];
  }> {
    if (this.closing || this.state === 'closed') {
      throw new AdifFileStoreReadOnlyError(this.state);
    }

    const resolvedSourcePath = path.resolve(sourcePath);
    if (resolvedSourcePath === this.filePath) {
      throw new AdifFileStoreError(
        'The restore source must be different from the formal ADIF file',
        'ADIF_RESTORE_SOURCE_INVALID',
      );
    }

    return this.queue.run(this.filePath, async () => {
      if (this.closing || this.state === 'closed') {
        throw new AdifFileStoreReadOnlyError(this.state);
      }

      const source = await this.scanRequired(resolvedSourcePath);
      if (!isCompleteScan(source.scan)) {
        throw new AdifRewriteValidationError(['restore source has an incomplete tail']);
      }

      // Restoration is allowed from read-only/unavailable states, but never
      // overwrites bytes whose current content revision cannot be established.
      let before: LogbookFileScanResult | undefined;
      try {
        before = await this.scanRequired(this.filePath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT' && expectedGeneration === undefined) {
          before = undefined;
        } else {
          throw new AdifFileStoreReadOnlyError(this.state, {
            cause: error,
            message: 'The current ADIF content could not be verified before restore',
          });
        }
      }
      if (before) this.assertExpectedGeneration(expectedGeneration, before.generation);

      let renamed = false;
      try {
        const handle = await this.openRewriteTemp(
          before ? await this.fileMode(this.filePath) : await this.fileMode(resolvedSourcePath),
        );
        try {
          await this.copyFileRangeToHandle(
            resolvedSourcePath,
            { start: 0, end: source.generation.size },
            handle,
          );
          await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }

        const candidate = await this.scanRequired(this.rewriteTempPath);
        if (!isCompleteScan(candidate.scan) || !sameContentGeneration(source.generation, candidate.generation)) {
          throw new AdifRewriteValidationError([
            'copied restore candidate differs from the validated source',
          ]);
        }

        const immediatelyBeforeCommit = await this.tryScan(this.filePath);
        if (before) {
          if (immediatelyBeforeCommit.kind !== 'scanned') {
            throw new AdifFileStoreReadOnlyError(this.state, {
              cause: immediatelyBeforeCommit.error,
              message: 'The current ADIF content could not be reverified before restore',
            });
          }
          if (!sameContentGeneration(before.generation, immediatelyBeforeCommit.result!.generation)) {
            this.throwGenerationConflict(before.generation, immediatelyBeforeCommit.result!.generation);
          }
        } else if (immediatelyBeforeCommit.kind !== 'missing') {
          if (immediatelyBeforeCommit.kind === 'scanned') {
            throw new AdifFileStoreError(
              'The formal ADIF appeared while preparing restore; retry with its current revision',
              'ADIF_GENERATION_CONFLICT',
            );
          }
          throw new AdifFileStoreReadOnlyError(this.state, {
            cause: immediatelyBeforeCommit.error,
            message: 'The formal ADIF path could not be verified before restore',
          });
        }

        await options.beforeReplace?.();
        await this.fileSystem.rename(this.rewriteTempPath, this.filePath);
        renamed = true;
        let directorySyncIssue: AdifFileStoreIssue | undefined;
        try {
          const synchronized = await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
          if (!synchronized) {
            directorySyncIssue = {
              code: 'DIRECTORY_SYNC_UNSUPPORTED',
              message: 'The restored ADIF content is committed, but this platform does not support directory synchronization',
              path: path.dirname(this.filePath),
            };
          }
        } catch (error) {
          directorySyncIssue = toIssue(
            'DIRECTORY_SYNC_FAILED',
            path.dirname(this.filePath),
            error,
            'The restored ADIF content is committed, but directory metadata durability could not be confirmed',
          );
        }

        const committed = await this.scanRequired(this.filePath);
        if (!sameContentGeneration(candidate.generation, committed.generation)) {
          throw new Error('Post-rename ADIF content differs from the validated restore candidate');
        }

        this.publishCommittedScan(committed, directorySyncIssue);
        return {
          generation: committed.generation,
          scan: committed.scan,
          recordProjections: committed.recordProjections,
        };
      } catch (error) {
        if (!renamed) {
          await this.fileSystem.unlink(this.rewriteTempPath).catch(() => undefined);
          throw error;
        }
        if (error instanceof AdifFileStateUncertainError) throw error;
        throw this.markUncertain(
          'rewrite',
          asError(error),
          undefined,
          'The restore candidate was renamed, but the committed ADIF content could not be verified',
        );
      }
    });
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

  /**
   * Starts a reader while the per-path mutation queue is held, then releases
   * the queue as soon as the reader confirms that it owns a fixed snapshot.
   * The returned promise still follows the reader through completion.
   */
  async startConsistentRead<T>(
    operation: (onSnapshotOpened: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.state === 'closed') {
      throw new AdifFileStoreReadOnlyError(this.state);
    }

    let operationPromise: Promise<T> | undefined;
    await this.queue.run(this.filePath, async () => {
      if (this.closing || this.state === 'closed') {
        throw new AdifFileStoreReadOnlyError(this.state);
      }

      let releaseSnapshot!: () => void;
      const snapshotOpened = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      let opened = false;
      const onSnapshotOpened = () => {
        if (opened) return;
        opened = true;
        releaseSnapshot();
      };

      operationPromise = Promise.resolve().then(() => operation(onSnapshotOpened));

      // A failed operation may settle before it can open a snapshot. Release
      // the queue in that case while leaving the failure for the outer await.
      void operationPromise.then(onSnapshotOpened, onSnapshotOpened);
      await snapshotOpened;
    });

    if (!operationPromise) {
      throw new AdifFileStoreError(
        'The consistent read did not start',
        'ADIF_CONSISTENT_READ_NOT_STARTED',
      );
    }
    return operationPromise;
  }

  /** Returns the most recently verified content generation without rescanning. */
  getCurrentGeneration(): GenerationToken {
    const generation = this.currentScanResult?.generation;
    if (!generation) {
      throw new AdifFileStoreReadOnlyError(this.state, {
        message: 'The ADIF file store does not have a verified current generation',
      });
    }
    return { ...generation };
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

  private async openLocked(): Promise<OpenResult> {
    const staleTempIssue = await this.removeStaleRewriteTemp();
    const includeCleanupIssue = (result: OpenResult): OpenResult => staleTempIssue
      ? {
          ...result,
          status: result.status === 'ready' ? 'degraded' : result.status,
          issues: [...result.issues, staleTempIssue],
        }
      : result;
    const main = await this.tryScan(this.filePath);

    if (main.kind === 'scanned') {
      // Complete opaque records remain usable. An incomplete tail stays in
      // place and is readable, but writing behind it would make the boundary
      // ambiguous, so only that book becomes read-only.
      return this.publishOpenResult(includeCleanupIssue(resultFromScan(main.result!)));
    }

    if (main.kind === 'error') {
      return this.publishOpenResult(includeCleanupIssue({
        status: 'unavailable',
        issues: [toIssue('MAIN_SCAN_FAILED', this.filePath, main.error)],
      }));
    }

    if (!this.createIfMissing) {
      return this.publishOpenResult(includeCleanupIssue({
        status: 'unavailable',
        issues: [{
          code: 'MAIN_FILE_MISSING',
          message: 'The formal ADIF file does not exist and automatic creation is disabled',
          path: this.filePath,
        }],
      }));
    }

    const directorySyncIssue = await this.createEmptyMain();
    const created = await this.scanRequired(this.filePath);
    const result = resultFromScan(created);
    return this.publishOpenResult(includeCleanupIssue(directorySyncIssue
      ? { ...result, status: 'degraded', issues: [...result.issues, directorySyncIssue] }
      : result));
  }

  private async removeStaleRewriteTemp(): Promise<AdifFileStoreIssue | undefined> {
    try {
      await this.fileSystem.unlink(this.rewriteTempPath);
      return undefined;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      return toIssue(
        'STALE_REWRITE_TEMP_CLEANUP_FAILED',
        this.rewriteTempPath,
        error,
        'A stale rewrite temp could not be removed; it is never used as a recovery source',
      );
    }
  }

  private async createEmptyMain(): Promise<AdifFileStoreIssue | undefined> {
    const handle = await this.fileSystem.open(this.filePath, ADIF_EXCLUSIVE_CREATE_FLAGS, 0o600);
    try {
      await writeAll(handle, encodeAdifHeader());
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      const synchronized = await fsyncDirectory(this.fileSystem, path.dirname(this.filePath));
      if (synchronized) return undefined;
      return {
        code: 'DIRECTORY_SYNC_UNSUPPORTED',
        message: 'The new ADIF file is synced, but this platform does not support directory synchronization',
        path: path.dirname(this.filePath),
      };
    } catch (error) {
      return toIssue(
        'DIRECTORY_SYNC_FAILED',
        path.dirname(this.filePath),
        error,
        'The new ADIF file is synced, but directory metadata durability could not be confirmed',
      );
    }
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
    if (!statAfterHash.isFile() || statAfterHash.size !== expectedSize) {
      throw this.markUncertain(
        'append',
        new Error('The ADIF file size changed while its committed generation was being hashed'),
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
    return this.queue.run(this.filePath, async () => {
      const before = await this.scanRequired(this.filePath);
      this.assertExpectedGeneration(expectedGeneration, before.generation);
      const value = await reader(before);
      const after = await this.scanRequired(this.filePath);
      if (!sameGeneration(before.generation, after.generation)) {
        this.throwGenerationConflict(before.generation, after.generation);
      }
      return { value, generation: after.generation, scan: after.scan };
    });
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
      if (stat.isFile() && stat.size === cached.generation.size) {
        const contentHash = await this.hashFileRange(this.filePath, { start: 0, end: stat.size });
        const after = await this.fileSystem.stat(this.filePath);
        if (
          after.isFile()
          && after.size === stat.size
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

  private publishCommittedScan(
    result: LogbookFileScanResult,
    commitIssue?: AdifFileStoreIssue,
  ): void {
    if (!commitIssue) {
      this.publishScanState(result);
      return;
    }
    this.currentScanResult = result;
    const openResult = resultFromScan(result);
    this.publishState('degraded', [...openResult.issues, commitIssue]);
  }

  private publishOpenResult(result: OpenResult): OpenResult {
    if (
      (result.status === 'ready' || result.status === 'degraded' || result.status === 'read-only')
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

function resultFromScan(result: LogbookFileScanResult): OpenResult {
  const incomplete = !isCompleteScan(result.scan);
  const degraded = result.scan.issues.length > 0
    || result.scan.records.some(record => !record.syntacticallyValid);
  const incompleteTailBytes = result.scan.incompleteTailRange
    ? result.scan.incompleteTailRange.end - result.scan.incompleteTailRange.start
    : result.scan.byteLength - result.scan.safeEnd;
  return {
    status: incomplete ? 'read-only' : degraded ? 'degraded' : 'ready',
    generation: result.generation,
    scan: result.scan,
    recordProjections: result.recordProjections,
    issues: [
      ...result.scan.issues.map(issue => ({
        code: `ADIF_${issue.code.toUpperCase().replaceAll('-', '_')}`,
        message: issue.message,
      })),
      ...(incomplete ? [{
        code: 'ADIF_INCOMPLETE_TAIL',
        message: 'The ADIF has an incomplete tail; complete records remain readable but writes are paused',
        affectedBytes: incompleteTailBytes,
      }] : []),
    ],
  };
}

function isCompleteScan(scan: AdifScanResult): boolean {
  return scan.incompleteTailRange === undefined && scan.safeEnd === scan.byteLength;
}

function sameGeneration(left: GenerationToken, right: GenerationToken): boolean {
  return left.size === right.size
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
