import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AdifBackupSummary {
  size: number;
  sha256: string;
  recordCount: number;
  opaqueRecordCount: number;
  incompleteTail: boolean;
  issueCount: number;
}

export type AdifBackupWorkerProgress = {
  bytesCopied: number;
  totalBytes: number;
};

export type AdifBackupWorkerRequest =
  | {
    type: 'copy-and-scan';
    id: number;
    sourcePath: string;
    targetPath: string;
  }
  | {
    type: 'scan';
    id: number;
    sourcePath: string;
  };

export type AdifBackupWorkerMessage =
  | { type: 'ready' }
  | { type: 'source-opened'; id: number }
  | { type: 'progress'; id: number; progress: AdifBackupWorkerProgress }
  | { type: 'result'; id: number; summary: AdifBackupSummary }
  | { type: 'error'; id?: number; error: { name: string; message: string; stack?: string; code?: string } };

export interface AdifBackupWorkerEntryResolution {
  entryPath: string;
  execArgv: string[];
  cwd: string;
}

export interface AdifBackupProcess extends EventEmitter {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  send?: (message: AdifBackupWorkerRequest, callback?: (error: Error | null) => void) => boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AdifBackupWorkerOptions {
  noProgressTimeoutMs?: number;
  workerFactory?: (entry: AdifBackupWorkerEntryResolution) => AdifBackupProcess;
  entry?: AdifBackupWorkerEntryResolution;
}

export class AdifBackupWorker {
  private readonly noProgressTimeoutMs: number;
  private readonly workerFactory: (entry: AdifBackupWorkerEntryResolution) => AdifBackupProcess;
  private readonly entry: AdifBackupWorkerEntryResolution;
  private nextId = 1;

  constructor(options: AdifBackupWorkerOptions = {}) {
    this.noProgressTimeoutMs = options.noProgressTimeoutMs ?? 30_000;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.entry = options.entry ?? resolveAdifBackupWorkerEntry();
  }

  copyAndScan(
    sourcePath: string,
    targetPath: string,
    onProgress?: (progress: AdifBackupWorkerProgress) => void,
    onSourceOpened?: () => void,
  ): Promise<AdifBackupSummary> {
    return this.request(
      { type: 'copy-and-scan', id: this.nextId++, sourcePath, targetPath },
      onProgress,
      onSourceOpened,
    );
  }

  scan(
    sourcePath: string,
    onProgress?: (progress: AdifBackupWorkerProgress) => void,
    onSourceOpened?: () => void,
  ): Promise<AdifBackupSummary> {
    return this.request(
      { type: 'scan', id: this.nextId++, sourcePath },
      onProgress,
      onSourceOpened,
    );
  }

  private request(
    request: AdifBackupWorkerRequest,
    onProgress?: (progress: AdifBackupWorkerProgress) => void,
    onSourceOpened?: () => void,
  ): Promise<AdifBackupSummary> {
    const id = request.id;
    return new Promise<AdifBackupSummary>((resolve, reject) => {
      let worker: AdifBackupProcess;
      try {
        worker = this.workerFactory(this.entry);
      } catch (error) {
        reject(asError(error));
        return;
      }

      let settled = false;
      let sent = false;
      let sourceOpened = false;
      let timer: NodeJS.Timeout;
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(new Error(`ADIF backup worker made no progress for ${this.noProgressTimeoutMs}ms`), undefined, true);
        }, this.noProgressTimeoutMs);
        timer.unref?.();
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      };
      const finish = (error?: Error, summary?: AdifBackupSummary, kill = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          worker.kill(kill ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // The worker can exit immediately after delivering its result.
        }
        if (error) reject(error);
        else resolve(summary!);
      };
      const send = () => {
        if (sent) return;
        sent = true;
        resetTimer();
        if (!worker.send) {
          finish(new Error('ADIF backup worker has no IPC channel'));
          return;
        }
        worker.send(request, error => {
          if (error) finish(error);
        });
      };
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) return;
        const message = value as AdifBackupWorkerMessage;
        if (message.type === 'ready') {
          send();
          return;
        }
        if ('id' in message && message.id !== id) return;
        if (message.type === 'source-opened') {
          resetTimer();
          if (!sourceOpened) {
            sourceOpened = true;
            onSourceOpened?.();
          }
        } else if (message.type === 'progress') {
          resetTimer();
          onProgress?.(message.progress);
        } else if (message.type === 'result') {
          finish(undefined, message.summary);
        } else if (message.type === 'error') {
          const error = new Error(message.error.message) as Error & { code?: string };
          error.name = message.error.name;
          error.stack = message.error.stack ?? error.stack;
          error.code = message.error.code;
          finish(error);
        }
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`ADIF backup worker exited before returning a result (code=${code}, signal=${signal})`));
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.stdout?.resume();
      worker.stderr?.resume();
      resetTimer();
    });
  }
}

export function resolveAdifBackupWorkerEntry(): AdifBackupWorkerEntryResolution {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const sourceRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  return {
    entryPath: path.join(currentDir, sourceRuntime ? 'adif-backup-worker-entry.ts' : 'adif-backup-worker-entry.js'),
    execArgv: sourceRuntime
      ? ['--max-old-space-size=512', '--import', 'tsx']
      : ['--max-old-space-size=512'],
    cwd: process.cwd(),
  };
}

function defaultWorkerFactory(entry: AdifBackupWorkerEntryResolution): AdifBackupProcess {
  return fork(entry.entryPath, [], {
    cwd: entry.cwd,
    execArgv: entry.execArgv,
    serialization: 'advanced',
    silent: true,
  }) as AdifBackupProcess;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
