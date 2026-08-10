import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  LegacyMigrationResult,
} from './LegacyLogbookMigrator.js';
import {
  legacyMigrationPaths,
} from './LegacyLogbookMigrator.js';
import {
  NodeLegacyLogbookFileStore,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';
import type {
  LegacyRetentionProof,
  LegacyRetentionResult,
} from './LegacyLogbookRecovery.js';
import { inventoryLegacyLogbookArtifacts } from './legacyLogbookArtifacts.js';

const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 30_000;
const DEFAULT_HARD_TIMEOUT_MS = 10 * 60_000;
const LEGACY_READ_CHUNK_BYTES = 64 * 1024;
const LEGACY_READ_PROGRESS_BYTES = 1024 * 1024;

export async function readLegacyFileWithProgress(
  filePath: string,
  onProgress: (bytesRead: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let nextProgress = LEGACY_READ_PROGRESS_BYTES;
  let lastReportedBytes = -1;
  const reportRead = (reportedBytes: number) => {
    if (reportedBytes === lastReportedBytes) return;
    lastReportedBytes = reportedBytes;
    onProgress(reportedBytes);
  };

  // Smaller reads are genuine forward progress for the watchdog. MiB
  // boundaries are still emitted explicitly for stable operator progress.
  for await (const value of createReadStream(filePath, { highWaterMark: LEGACY_READ_CHUNK_BYTES })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    chunks.push(chunk);
    bytesRead += chunk.length;
    while (bytesRead >= nextProgress) {
      reportRead(nextProgress);
      nextProgress += LEGACY_READ_PROGRESS_BYTES;
    }
    reportRead(bytesRead);
  }

  if (bytesRead === 0) reportRead(0);
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, bytesRead);
}

export interface LegacyLogbookMigrationRunner {
  migrate(mainPath: string): Promise<LegacyMigrationResult>;
  cleanupExpired(mainPath: string, proof: LegacyRetentionProof): Promise<LegacyRetentionResult>;
}

export interface LegacyMigrationWorkerEntryResolution {
  entryPath: string;
  execArgv: string[];
  cwd: string;
}

export interface LegacyMigrationProcess extends EventEmitter {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  send?: (message: LegacyMigrationWorkerRequest, callback?: (error: Error | null) => void) => boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type LegacyMigrationWorkerRequest =
  | { type: 'migrate'; id: number; mainPath: string }
  | { type: 'cleanup'; id: number; mainPath: string; proof: LegacyRetentionProof };

export type LegacyMigrationWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; id: number; sequence: number; stage: string }
  | { type: 'migration-result'; id: number; result: LegacyMigrationResult }
  | { type: 'retention-result'; id: number; result: LegacyRetentionResult }
  | { type: 'error'; id?: number; message: string; code?: string };

export interface LegacyLogbookMigrationWorkerOptions {
  noProgressTimeoutMs?: number;
  hardTimeoutMs?: number;
  fileStore?: LegacyLogbookFileStore;
  workerFactory?: (entry: LegacyMigrationWorkerEntryResolution) => LegacyMigrationProcess;
  entry?: LegacyMigrationWorkerEntryResolution;
}

/**
 * Runs the legacy-only migration path outside the server process. A malformed
 * legacy snapshot can exhaust or crash this bounded child without controlling
 * server readiness or the current ADIF store.
 */
export class LegacyLogbookMigrationWorker implements LegacyLogbookMigrationRunner {
  private readonly noProgressTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly fileStore: LegacyLogbookFileStore;
  private readonly workerFactory: (entry: LegacyMigrationWorkerEntryResolution) => LegacyMigrationProcess;
  private readonly entry: LegacyMigrationWorkerEntryResolution;
  private nextRequestId = 1;

  constructor(options: LegacyLogbookMigrationWorkerOptions = {}) {
    this.noProgressTimeoutMs = options.noProgressTimeoutMs ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS;
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    this.fileStore = options.fileStore ?? new NodeLegacyLogbookFileStore();
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.entry = options.entry ?? resolveLegacyMigrationWorkerEntry();
  }

  async migrate(mainPath: string): Promise<LegacyMigrationResult> {
    const normalizedPath = path.resolve(mainPath);
    try {
      // Avoid forking on the stable path. Inventory only reads names and stats;
      // arbitrary ADIF bytes are never loaded into the server process.
      const inventory = await inventoryLegacyLogbookArtifacts(normalizedPath, this.fileStore);
      const manifestPath = path.join(legacyMigrationPaths(normalizedPath).recoveryRoot, 'manifest.json');
      if (inventory.artifacts.length === 0 && !await this.fileStore.exists(manifestPath)) {
        return {
          status: 'NOT_NEEDED',
          mainPath: normalizedPath,
          committed: false,
          appliedTransactions: 0,
          skippedTransactions: 0,
          unappliedOperations: 0,
          issues: [],
        };
      }
      return await this.request<LegacyMigrationResult>({
        type: 'migrate',
        id: this.nextRequestId++,
        mainPath: normalizedPath,
      }, 'migration-result');
    } catch (error) {
      return {
        status: 'FAILED',
        mainPath: normalizedPath,
        committed: false,
        appliedTransactions: 0,
        skippedTransactions: 0,
        unappliedOperations: 0,
        issues: [{
          code: 'MIGRATION_WORKER_FAILED',
          path: normalizedPath,
          message: asError(error).message,
        }],
      };
    }
  }

  async cleanupExpired(
    mainPath: string,
    proof: LegacyRetentionProof,
  ): Promise<LegacyRetentionResult> {
    const normalizedPath = path.resolve(mainPath);
    try {
      if (!await this.fileStore.exists(path.join(legacyMigrationPaths(normalizedPath).recoveryRoot, 'manifest.json'))) {
        return { removedRecoverySets: 0, issues: [] };
      }
      return await this.request<LegacyRetentionResult>({
        type: 'cleanup',
        id: this.nextRequestId++,
        mainPath: normalizedPath,
        proof,
      }, 'retention-result');
    } catch (error) {
      return {
        removedRecoverySets: 0,
        issues: [{
          code: 'RECOVERY_RETENTION_WORKER_FAILED',
          path: normalizedPath,
          message: asError(error).message,
        }],
      };
    }
  }

  private request<Result>(
    request: LegacyMigrationWorkerRequest,
    expectedType: 'migration-result' | 'retention-result',
  ): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      let child: LegacyMigrationProcess;
      try {
        child = this.workerFactory(this.entry);
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let sent = false;
      let lastProgressSequence = 0;
      const timers: { noProgress?: NodeJS.Timeout; hard?: NodeJS.Timeout } = {};

      const cleanup = () => {
        clearTimeout(timers.noProgress);
        clearTimeout(timers.hard);
        child.removeListener('message', onMessage);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
      const finish = (error?: Error, result?: Result, kill = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          child.kill(kill ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // The child may already have disconnected after returning its result.
        }
        if (error) reject(error);
        else resolve(result!);
      };
      const resetNoProgressTimer = () => {
        clearTimeout(timers.noProgress);
        timers.noProgress = setTimeout(() => {
          finish(new Error(`Legacy logbook worker made no progress for ${this.noProgressTimeoutMs}ms`), undefined, true);
        }, this.noProgressTimeoutMs);
        timers.noProgress.unref?.();
      };
      const send = () => {
        if (sent) return;
        sent = true;
        resetNoProgressTimer();
        if (!child.send) {
          finish(new Error('Legacy logbook worker has no IPC channel'));
          return;
        }
        try {
          child.send(request, error => error && finish(error));
        } catch (error) {
          finish(asError(error));
        }
      };
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) return;
        const message = value as LegacyMigrationWorkerMessage;
        if (message.type === 'ready') {
          resetNoProgressTimer();
          send();
          return;
        }
        if ('id' in message && message.id !== request.id) return;
        if (message.type === 'progress') {
          // A repeated liveness heartbeat is not work. Only a new, monotonic
          // milestone can extend the no-progress window; the hard deadline is
          // intentionally never reset by child messages.
          if (Number.isSafeInteger(message.sequence) && message.sequence > lastProgressSequence) {
            lastProgressSequence = message.sequence;
            resetNoProgressTimer();
          }
          return;
        }
        if (message.type === expectedType) {
          finish(undefined, message.result as Result);
          return;
        }
        if (message.type === 'error') {
          const error = new Error(message.message);
          if (message.code) (error as Error & { code?: string }).code = message.code;
          finish(error);
        }
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Legacy logbook worker exited before returning a result (code=${code}, signal=${signal})`));
      };

      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);
      child.stdout?.resume();
      child.stderr?.resume();
      resetNoProgressTimer();
      timers.hard = setTimeout(() => {
        finish(new Error(`Legacy logbook worker exceeded hard deadline of ${this.hardTimeoutMs}ms`), undefined, true);
      }, this.hardTimeoutMs);
      timers.hard.unref?.();
    });
  }
}

export function resolveLegacyMigrationWorkerEntry(): LegacyMigrationWorkerEntryResolution {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const isTypeScriptRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  return {
    entryPath: path.join(
      currentDir,
      isTypeScriptRuntime ? 'legacy-logbook-migration-worker-entry.ts' : 'legacy-logbook-migration-worker-entry.js',
    ),
    execArgv: isTypeScriptRuntime
      ? ['--max-old-space-size=512', '--import', 'tsx']
      : ['--max-old-space-size=512'],
    cwd: process.cwd(),
  };
}

function defaultWorkerFactory(entry: LegacyMigrationWorkerEntryResolution): LegacyMigrationProcess {
  return fork(entry.entryPath, [], {
    cwd: entry.cwd,
    execArgv: entry.execArgv,
    serialization: 'advanced',
    silent: true,
  }) as LegacyMigrationProcess;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
