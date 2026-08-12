import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

import type {
  LogbookBackupStatus,
  LogbookHealth,
  LogbookRestorePreflight,
} from '@tx5dr/contracts';

import type { AdifFileStore } from '../persistence/AdifFileStore.js';
import type { GenerationToken } from '../persistence/LogbookScanTypes.js';
import { createLogger } from '../../utils/logger.js';
import {
  AdifBackupWorker,
  type AdifBackupSummary,
  type AdifBackupWorkerProgress,
} from './AdifBackupWorker.js';

const BACKUP_INTERVAL_MS = 30 * 60 * 1000;
const BACKUP_MUTATION_THRESHOLD = 100;
const PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const logger = createLogger('AdifBackupService');

interface BackupManifest extends AdifBackupSummary {
  schemaVersion: 1;
  pathFingerprint: string;
  logBookId: string;
  sourceRevision: string;
  createdAt: number;
}

interface RestorePreflightState {
  token: string;
  tokenId: string;
  expiresAt: number;
  mainRevision: string;
  backupHash: string;
  mainGeneration?: GenerationToken;
  response: LogbookRestorePreflight;
}

export interface AdifRestoreCommitResult {
  generation: GenerationToken;
  scan: import('../persistence/AdifCodec.js').AdifScanResult;
  recordProjections: readonly import('../persistence/LogbookDocument.js').LogbookRecordProjection[];
}

export interface BackupDownload {
  stream: NodeJS.ReadableStream;
  fileName: string;
  size: number;
  createdAt?: number;
  close(): Promise<void>;
}

export interface AdifBackupServiceOptions {
  worker?: AdifBackupWorker;
  now?: () => number;
  onChanged?: () => void;
}

export class LogbookBackupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'LogbookBackupError';
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class AdifBackupService {
  readonly backupDirectory: string;
  readonly latestPath: string;
  readonly manifestPath: string;
  readonly preRestorePath: string;

  private readonly worker: AdifBackupWorker;
  private readonly now: () => number;
  private readonly onChanged?: () => void;
  private manifest?: BackupManifest;
  private dirtyMutations = 0;
  private currentOperation?: LogbookBackupStatus['operation'];
  private backupJob?: Promise<LogbookBackupStatus>;
  private restorePreparing = false;
  private preflight?: RestorePreflightState;
  private lastError?: { code: string; message: string };
  private maintenance = false;
  private preRestoreInfo?: { createdAt: number; size: number };

  constructor(
    readonly logBookId: string,
    readonly mainPath: string,
    private readonly store: AdifFileStore,
    options: AdifBackupServiceOptions = {},
  ) {
    const baseName = path.basename(mainPath);
    this.backupDirectory = path.join(path.dirname(mainPath), '.tx5dr-backups', baseName);
    this.latestPath = path.join(this.backupDirectory, 'latest.adi');
    this.manifestPath = path.join(this.backupDirectory, 'latest.json');
    this.preRestorePath = path.join(this.backupDirectory, 'pre-restore.adi');
    this.worker = options.worker ?? new AdifBackupWorker();
    this.now = options.now ?? Date.now;
    this.onChanged = options.onChanged;
  }

  async initialize(): Promise<void> {
    try {
      await this.ensureBackupDirectory();
      await this.removeFixedTemps();
      this.manifest = await this.loadAndValidateManifest();
      this.preRestoreInfo = await statFile(this.preRestorePath);
    } catch (error) {
      logger.warn('Failed to initialize logbook backup state', error);
      this.lastError = clientBackupError('LOGBOOK_BACKUP_FAILED');
    }
  }

  get maintenanceActive(): boolean {
    return this.maintenance;
  }

  get pendingMutations(): number {
    return this.dirtyMutations;
  }

  markMutationCommitted(): void {
    this.dirtyMutations += 1;
    this.onChanged?.();
    if (this.shouldRefresh()) void this.createBackup().catch(() => undefined);
  }

  shouldRefresh(): boolean {
    if (!this.manifest) return true;
    return this.dirtyMutations >= BACKUP_MUTATION_THRESHOLD
      || this.now() - this.manifest.createdAt >= BACKUP_INTERVAL_MS;
  }

  async ensureBeforeRewrite(): Promise<void> {
    // A background refresh may already own the fixed temp names. Let it
    // settle, then verify the actual latest bytes instead of trusting the
    // in-memory manifest across arbitrary filesystem failures.
    await this.backupJob;
    this.manifest = await this.loadAndValidateManifest();
    if (!this.manifest || this.shouldRefresh()) await this.createBackup();
  }

  async createInitialBackupInBackground(): Promise<void> {
    if (this.manifest) return;
    await this.createBackup();
  }

  async flushWithin(deadlineMs: number): Promise<void> {
    // Shutdown is the final chance to capture even a single mutation that has
    // not yet reached the periodic age/count thresholds.
    if (this.manifest && this.dirtyMutations === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.createBackup().then(() => undefined),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Backup flush deadline exceeded')), deadlineMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  createBackup(): Promise<LogbookBackupStatus> {
    if (this.maintenance || this.restorePreparing) {
      return Promise.reject(new LogbookBackupError(
        'LOGBOOK_MAINTENANCE',
        'The logbook is currently being restored',
      ));
    }
    if (this.backupJob) return this.backupJob;
    const operationId = randomUUID();
    this.currentOperation = {
      id: operationId,
      kind: 'backup',
      state: 'queued',
      phase: 'waiting-for-logbook',
    };
    this.onChanged?.();
    const job = this.runBackup(operationId)
      .finally(() => {
        if (this.backupJob === job) this.backupJob = undefined;
      });
    this.backupJob = job;
    return job;
  }

  getStatus(
    health: LogbookHealth,
    revision: string,
    options: { admin: boolean; tokenId?: string; unsaved?: LogbookBackupStatus['unsaved'] } = { admin: false },
  ): LogbookBackupStatus {
    const canDownloadPreRestore = options.admin && this.preRestoreInfo !== undefined;
    const status: LogbookBackupStatus = {
      logBookId: this.logBookId,
      revision,
      mainHealth: health,
      // "dirty" means the main file is newer than latest.adi. The age
      // threshold schedules refreshes, but age alone does not make two
      // identical snapshots diverge.
      dirty: !this.manifest || this.dirtyMutations > 0,
      pendingMutations: this.dirtyMutations,
      latest: this.manifest ? {
        createdAt: this.manifest.createdAt,
        size: this.manifest.size,
        recordCount: this.manifest.recordCount,
        opaqueRecordCount: this.manifest.opaqueRecordCount,
      } : undefined,
      operation: this.currentOperation ? { ...this.currentOperation } : undefined,
      unsaved: options.unsaved,
      capabilities: {
        canCreate: health.readable && !this.maintenance && !this.restorePreparing,
        canDownload: Boolean(this.manifest),
        canRestore: options.admin
          && Boolean(this.manifest)
          && !this.maintenance
          && !this.restorePreparing,
        canDownloadPreRestore,
      },
      error: this.lastError ? { ...this.lastError } : undefined,
    };
    if (options.admin && this.preRestoreInfo) status.preRestore = { ...this.preRestoreInfo };
    return status;
  }

  async prepareRestore(
    tokenId: string,
    expectedRevision: string,
    health: LogbookHealth,
    currentRevision: string,
    currentGeneration?: GenerationToken,
  ): Promise<LogbookRestorePreflight> {
    if (this.restorePreparing || this.maintenance) {
      throw new LogbookBackupError('LOGBOOK_MAINTENANCE', 'A restore operation is already in progress');
    }
    this.restorePreparing = true;
    const operationId = randomUUID();
    this.currentOperation = {
      id: operationId,
      kind: 'restore-prepare',
      state: 'running',
      phase: 'scanning',
    };
    this.onChanged?.();
    try {
      this.assertRevision(expectedRevision, currentRevision);
      // A backup that was already copying may atomically replace latest.adi.
      // Let it settle before binding a restore preview to that artifact.
      await this.backupJob?.catch(() => undefined);
      if (!this.manifest) {
        throw new LogbookBackupError('LOGBOOK_BACKUP_UNAVAILABLE', 'No valid logbook backup is available');
      }

      let snapshotGeneration: GenerationToken | undefined;
      const [mainSnapshot, backup] = await Promise.all([
        this.store.startConsistentRead(onSnapshotOpened => {
          try {
            snapshotGeneration = this.store.getCurrentGeneration();
          } catch {
            snapshotGeneration = undefined;
          }
          return this.scanMainForPreflight(onSnapshotOpened);
        }),
        this.worker.scan(this.latestPath),
      ]);
      const main = mainSnapshot.summary;
      if (mainSnapshot.missing) snapshotGeneration = undefined;
      const snapshotRevision = snapshotGeneration
        ? generationRevision(snapshotGeneration)
        : currentRevision;
      this.assertRevision(expectedRevision, snapshotRevision);
      if (snapshotGeneration && (
        snapshotGeneration.size !== main.size
        || snapshotGeneration.contentHash !== main.sha256
      )) {
        throw new LogbookBackupError(
          'LOGBOOK_REVISION_MISMATCH',
          'The main logbook changed while the restore preview snapshot was opening',
        );
      }
      if (backup.sha256 !== this.manifest.sha256 || backup.incompleteTail) {
        throw new LogbookBackupError('LOGBOOK_BACKUP_CHANGED', 'The latest backup is no longer valid');
      }
      const token = randomUUID();
      const expiresAt = this.now() + PREFLIGHT_TTL_MS;
      const response: LogbookRestorePreflight = {
        preflightToken: token,
        expiresAt,
        revision: snapshotRevision,
        main: toPreflightFile(main),
        backup: toPreflightFile(backup),
        recordDelta: backup.recordCount - main.recordCount,
        estimatedLoss: Math.max(0, main.recordCount - backup.recordCount),
        highRisk: mainSnapshot.missing
          || backup.recordCount < main.recordCount
          || backup.incompleteTail
          || main.incompleteTail
          || !health.readable,
      };
      this.preflight = {
        token,
        tokenId,
        expiresAt,
        mainRevision: snapshotRevision,
        backupHash: backup.sha256,
        mainGeneration: mainSnapshot.missing
          ? undefined
          : snapshotGeneration
            ? { ...snapshotGeneration }
            : currentGeneration
              ? { ...currentGeneration }
              : undefined,
        response,
      };
      this.currentOperation = { ...this.currentOperation, state: 'succeeded', phase: 'ready' };
      this.onChanged?.();
      return response;
    } catch (error) {
      this.currentOperation = {
        ...this.currentOperation,
        state: 'failed',
        phase: 'failed',
        errorCode: error instanceof LogbookBackupError ? error.code : 'LOGBOOK_BACKUP_FAILED',
      };
      this.onChanged?.();
      throw error;
    } finally {
      this.restorePreparing = false;
    }
  }

  async restore(
    input: {
      tokenId: string;
      preflightToken: string;
      expectedRevision: string;
      currentRevision: string;
      beforeReplace?: () => Promise<void>;
    },
  ): Promise<AdifRestoreCommitResult> {
    const preflight = this.preflight;
    if (!preflight
      || preflight.token !== input.preflightToken
      || preflight.tokenId !== input.tokenId
      || preflight.expiresAt < this.now()) {
      throw new LogbookBackupError(
        'LOGBOOK_RESTORE_PRECONDITION_FAILED',
        'The restore preview has expired or does not belong to this session',
      );
    }
    this.assertRevision(input.expectedRevision, input.currentRevision);
    this.assertRevision(preflight.mainRevision, input.currentRevision);
    if (!this.manifest || this.manifest.sha256 !== preflight.backupHash) {
      throw new LogbookBackupError('LOGBOOK_BACKUP_CHANGED', 'The backup changed after restore preview');
    }

    // A preflight token is a one-shot authorization to attempt a destructive
    // restore. HTTP idempotency owns replaying the result of the same request.
    this.preflight = undefined;
    this.maintenance = true;
    await this.backupJob?.catch(() => undefined);
    if (!this.manifest || this.manifest.sha256 !== preflight.backupHash) {
      this.maintenance = false;
      throw new LogbookBackupError('LOGBOOK_BACKUP_CHANGED', 'The backup changed after restore preview');
    }

    const operationId = randomUUID();
    this.currentOperation = {
      id: operationId,
      kind: 'restore',
      state: 'running',
      phase: 'preserving-main',
    };
    this.onChanged?.();
    try {
      if (preflight.mainGeneration) {
        await this.copyDurable(this.mainPath, this.preRestorePath);
        this.preRestoreInfo = await statFile(this.preRestorePath);
      } else {
        const main = await statFile(this.mainPath);
        if (main) {
          throw new LogbookBackupError(
            'LOGBOOK_RESTORE_PRECONDITION_FAILED',
            'The current logbook appeared after the restore preview; refresh before continuing',
          );
        }
      }
      const backup = await this.worker.scan(this.latestPath);
      if (backup.sha256 !== preflight.backupHash || backup.incompleteTail) {
        throw new LogbookBackupError('LOGBOOK_BACKUP_CHANGED', 'The backup failed final validation');
      }
      this.currentOperation = { ...this.currentOperation, phase: 'replacing-main' };
      this.onChanged?.();
      const committed = await this.store.commitReplaceFromFile(
        this.latestPath,
        preflight.mainGeneration,
        { beforeReplace: input.beforeReplace },
      );
      this.dirtyMutations = 0;
      this.currentOperation = { ...this.currentOperation, state: 'succeeded', phase: 'complete' };
      this.lastError = undefined;
      this.onChanged?.();
      return committed;
    } catch (error) {
      this.currentOperation = {
        ...this.currentOperation,
        state: 'failed',
        phase: 'failed',
        errorCode: error instanceof LogbookBackupError ? error.code : 'LOGBOOK_BACKUP_FAILED',
      };
      logger.warn('Logbook restore failed', error);
      this.lastError = clientBackupError(this.currentOperation.errorCode!);
      this.onChanged?.();
      throw error;
    } finally {
      this.maintenance = false;
    }
  }

  async openDownload(kind: 'latest' | 'pre-restore'): Promise<BackupDownload> {
    const target = kind === 'latest' ? this.latestPath : this.preRestorePath;
    if (kind === 'latest' && !this.manifest) {
      throw new LogbookBackupError('LOGBOOK_BACKUP_UNAVAILABLE', 'No valid logbook backup is available');
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(target, constants.O_RDONLY);
    } catch (error) {
      throw new LogbookBackupError('LOGBOOK_BACKUP_UNAVAILABLE', 'The requested recovery file is unavailable', { cause: error });
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new LogbookBackupError('LOGBOOK_BACKUP_UNAVAILABLE', 'The requested recovery artifact is not a file');
    }
    const stream = stat.size === 0
      ? Readable.from([])
      : createReadStream('', { fd: handle.fd, autoClose: false, start: 0, end: stat.size - 1 });
    return {
      stream,
      fileName: kind === 'latest'
        ? `${safeBaseName(this.mainPath)}-backup.adi`
        : `${safeBaseName(this.mainPath)}-pre-restore.adi`,
      size: stat.size,
      createdAt: stat.mtimeMs,
      close: () => handle.close(),
    };
  }

  private async runBackup(operationId: string): Promise<LogbookBackupStatus> {
    const tempPath = path.join(this.backupDirectory, 'latest.tmp');
    const manifestTempPath = path.join(this.backupDirectory, 'latest.json.tmp');
    try {
      await this.ensureBackupDirectory();
      await fs.unlink(tempPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      this.currentOperation = {
        id: operationId,
        kind: 'backup',
        state: 'running',
        phase: 'copying',
      };
      this.onChanged?.();
      let mutationsAtSnapshot = this.dirtyMutations;
      const summary = await this.store.startConsistentRead(onSnapshotOpened => (
        this.worker.copyAndScan(
          this.mainPath,
          tempPath,
          progress => this.updateProgress(operationId, progress),
          () => {
            mutationsAtSnapshot = this.dirtyMutations;
            onSnapshotOpened();
          },
        )
      ));
      if (summary.incompleteTail) {
        throw new LogbookBackupError('LOGBOOK_BACKUP_FAILED', 'Refusing to replace the backup with an incomplete ADIF snapshot');
      }
      const createdAt = this.now();
      const sourceRevision = summaryRevision(summary);
      const manifest: BackupManifest = {
        schemaVersion: 1,
        pathFingerprint: pathFingerprint(this.mainPath),
        logBookId: this.logBookId,
        sourceRevision,
        createdAt,
        ...summary,
      };
      await writeJsonDurable(manifestTempPath, manifest);
      await fs.rename(tempPath, this.latestPath);
      await fs.rename(manifestTempPath, this.manifestPath);
      await syncDirectoryBestEffort(this.backupDirectory);
      this.manifest = manifest;
      this.dirtyMutations = Math.max(0, this.dirtyMutations - mutationsAtSnapshot);
      this.lastError = undefined;
      this.currentOperation = {
        id: operationId,
        kind: 'backup',
        state: 'succeeded',
        phase: 'complete',
        processedBytes: summary.size,
        totalBytes: summary.size,
      };
      this.onChanged?.();
      return this.getStatus(emptyHealth(), sourceRevision);
    } catch (error) {
      await Promise.all([
        fs.unlink(tempPath).catch(() => undefined),
        fs.unlink(manifestTempPath).catch(() => undefined),
      ]);
      const code = error instanceof LogbookBackupError ? error.code : 'LOGBOOK_BACKUP_FAILED';
      logger.warn('Logbook backup refresh failed', error);
      this.lastError = clientBackupError(code);
      this.currentOperation = {
        id: operationId,
        kind: 'backup',
        state: 'failed',
        phase: 'failed',
        errorCode: code,
      };
      this.onChanged?.();
      throw error instanceof LogbookBackupError
        ? error
        : new LogbookBackupError(code, asMessage(error), { cause: error });
    }
  }

  private updateProgress(operationId: string, progress: AdifBackupWorkerProgress): void {
    if (this.currentOperation?.id !== operationId) return;
    this.currentOperation = {
      ...this.currentOperation,
      processedBytes: progress.bytesCopied,
      totalBytes: progress.totalBytes,
    };
    this.onChanged?.();
  }

  private async loadAndValidateManifest(): Promise<BackupManifest | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as unknown;
    } catch {
      parsed = undefined;
    }
    try {
      const summary = await this.worker.scan(this.latestPath);
      if (summary.incompleteTail) return undefined;
      if (
        isManifest(parsed, this.logBookId, this.mainPath)
        && summary.sha256 === parsed.sha256
        && summary.size === parsed.size
      ) return parsed;

      // The data file is authoritative for this optional recovery artifact.
      // A crash between its rename and the manifest rename is repaired here.
      const repaired: BackupManifest = {
        schemaVersion: 1,
        pathFingerprint: pathFingerprint(this.mainPath),
        logBookId: this.logBookId,
        sourceRevision: summaryRevision(summary),
        createdAt: isManifestIdentity(parsed, this.logBookId, this.mainPath)
          && typeof parsed.createdAt === 'number'
          ? parsed.createdAt
          : (await fs.stat(this.latestPath)).mtimeMs,
        ...summary,
      };
      const tempPath = `${this.manifestPath}.tmp`;
      await fs.unlink(tempPath).catch(() => undefined);
      await writeJsonDurable(tempPath, repaired);
      await fs.rename(tempPath, this.manifestPath);
      await syncDirectoryBestEffort(this.backupDirectory);
      return repaired;
    } catch {
      return undefined;
    }
  }

  private async scanMainForPreflight(
    onSourceOpened: () => void,
  ): Promise<{ summary: AdifBackupSummary; missing: boolean }> {
    try {
      return {
        summary: await this.worker.scan(this.mainPath, undefined, onSourceOpened),
        missing: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        missing: true,
        summary: {
          size: 0,
          sha256: createHash('sha256').digest('hex'),
          recordCount: 0,
          opaqueRecordCount: 0,
          incompleteTail: false,
          issueCount: 0,
        },
      };
    }
  }

  private async copyDurable(sourcePath: string, targetPath: string): Promise<void> {
    const tempPath = `${targetPath}.tmp`;
    await fs.unlink(tempPath).catch(() => undefined);
    try {
      const summary = await this.worker.copyAndScan(sourcePath, tempPath);
      if (summary.size < 0) throw new Error('Invalid recovery copy size');
      await fs.rename(tempPath, targetPath);
      await syncDirectoryBestEffort(this.backupDirectory);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private assertRevision(expected: string, actual: string): void {
    if (!expected || expected !== actual) {
      throw new LogbookBackupError('LOGBOOK_REVISION_MISMATCH', 'The logbook changed; refresh before continuing');
    }
  }

  private async removeFixedTemps(): Promise<void> {
    await Promise.all([
      'latest.tmp',
      'latest.json.tmp',
      'pre-restore.adi.tmp',
      'restore.tmp',
    ].map(name => fs.unlink(path.join(this.backupDirectory, name)).catch(() => undefined)));
  }

  private async ensureBackupDirectory(): Promise<void> {
    const root = path.dirname(this.backupDirectory);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700).catch(() => undefined);
    await fs.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.backupDirectory, 0o700).catch(() => undefined);
  }
}

export function generationRevision(generation: GenerationToken | undefined): string {
  if (!generation) return 'unavailable';
  return `"${generation.size}-${generation.contentHash}"`;
}

function isManifest(value: unknown, logBookId: string, mainPath: string): value is BackupManifest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BackupManifest>;
  return item.schemaVersion === 1
    && item.pathFingerprint === pathFingerprint(mainPath)
    && item.logBookId === logBookId
    && typeof item.sourceRevision === 'string'
    && typeof item.createdAt === 'number'
    && typeof item.size === 'number'
    && typeof item.sha256 === 'string'
    && typeof item.recordCount === 'number'
    && typeof item.opaqueRecordCount === 'number'
    && item.incompleteTail === false;
}

function isManifestIdentity(
  value: unknown,
  logBookId: string,
  mainPath: string,
): value is Partial<BackupManifest> & { schemaVersion: 1 } {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BackupManifest>;
  return item.schemaVersion === 1
    && item.pathFingerprint === pathFingerprint(mainPath)
    && item.logBookId === logBookId;
}

function pathFingerprint(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 24);
}

function summaryRevision(summary: Pick<AdifBackupSummary, 'size' | 'sha256'>): string {
  return `"${summary.size}-${summary.sha256}"`;
}

function safeBaseName(filePath: string): string {
  return path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.adi$/i, '');
}

async function writeJsonDurable(filePath: string, value: unknown): Promise<void> {
  const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function toPreflightFile(summary: AdifBackupSummary): LogbookRestorePreflight['main'] {
  return {
    size: summary.size,
    recordCount: summary.recordCount,
    opaqueRecordCount: summary.opaqueRecordCount,
    incompleteTail: summary.incompleteTail,
    issueCount: summary.issueCount,
  };
}

function emptyHealth(): LogbookHealth {
  return { state: 'healthy', readable: true, writable: true, issues: [], updatedAt: Date.now() };
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientBackupError(code: string): { code: string; message: string } {
  return { code, message: safeBackupErrorMessage(code) };
}

export function safeBackupErrorMessage(code: string): string {
  switch (code) {
    case 'LOGBOOK_BACKUP_UNAVAILABLE':
      return 'No valid logbook backup is available';
    case 'LOGBOOK_BACKUP_CHANGED':
      return 'The selected logbook backup changed; refresh and prepare the restore again';
    case 'LOGBOOK_REVISION_MISMATCH':
      return 'The logbook changed; refresh before continuing';
    case 'LOGBOOK_RESTORE_PRECONDITION_FAILED':
      return 'The restore confirmation or preview is no longer valid';
    case 'LOGBOOK_MAINTENANCE':
      return 'A logbook backup or restore operation is already in progress';
    default:
      return 'The logbook backup operation failed';
  }
}

async function statFile(filePath: string): Promise<{ size: number; createdAt: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? { size: stat.size, createdAt: stat.mtimeMs } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
