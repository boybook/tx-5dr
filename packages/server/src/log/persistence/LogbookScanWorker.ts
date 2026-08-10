import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanLogbookFileInline } from './LogbookScanCore.js';
import type {
  LogbookFileScanResult,
  LogbookScanner,
  LogbookScanProgress,
  LogbookScanWorkerMessage,
  LogbookScanWorkerRequest,
  SerializedLogbookScanError,
} from './LogbookScanTypes.js';

const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 30_000;

export interface LogbookScanWorkerEntryResolution {
  entryPath: string;
  execArgv: string[];
  cwd: string;
  mode: 'development' | 'production';
}

export interface LogbookScanProcess extends EventEmitter {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  send?: (message: LogbookScanWorkerRequest, callback?: (error: Error | null) => void) => boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LogbookScanWorkerOptions {
  noProgressTimeoutMs?: number;
  useInline?: boolean;
  fallbackToInline?: boolean;
  inlineScanner?: typeof scanLogbookFileInline;
  workerFactory?: (entry: LogbookScanWorkerEntryResolution) => LogbookScanProcess;
  entry?: LogbookScanWorkerEntryResolution;
}

export class LogbookScanTimeoutError extends Error {
  readonly code = 'LOGBOOK_SCAN_TIMEOUT';

  constructor(public readonly filePath: string, timeoutMs: number) {
    super(`Logbook scan made no progress for ${timeoutMs}ms: ${filePath}`);
    this.name = 'LogbookScanTimeoutError';
  }
}

export class LogbookScanWorker implements LogbookScanner {
  private readonly noProgressTimeoutMs: number;
  private readonly useInline: boolean;
  private readonly fallbackToInline: boolean;
  private readonly inlineScanner: typeof scanLogbookFileInline;
  private readonly workerFactory: (entry: LogbookScanWorkerEntryResolution) => LogbookScanProcess;
  private readonly entry: LogbookScanWorkerEntryResolution;
  private nextRequestId = 1;

  constructor(options: LogbookScanWorkerOptions = {}) {
    this.noProgressTimeoutMs = options.noProgressTimeoutMs ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS;
    this.useInline = options.useInline ?? process.env.NODE_ENV === 'test';
    // A broken worker must isolate only this logbook; parsing in the server
    // process would reintroduce the startup-crash failure this worker prevents.
    this.fallbackToInline = options.fallbackToInline ?? false;
    this.inlineScanner = options.inlineScanner ?? scanLogbookFileInline;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.entry = options.entry ?? resolveLogbookScanWorkerEntry();
  }

  async scan(
    filePath: string,
    onProgress?: (progress: LogbookScanProgress) => void,
  ): Promise<LogbookFileScanResult> {
    if (this.useInline) return this.inlineScanner(filePath, onProgress);
    try {
      return await this.scanInWorker(filePath, onProgress);
    } catch (error) {
      if (!this.fallbackToInline || error instanceof LogbookScanTimeoutError) throw error;
      return this.inlineScanner(filePath, onProgress);
    }
  }

  private scanInWorker(
    filePath: string,
    onProgress?: (progress: LogbookScanProgress) => void,
  ): Promise<LogbookFileScanResult> {
    const id = this.nextRequestId++;
    return new Promise<LogbookFileScanResult>((resolve, reject) => {
      let worker: LogbookScanProcess;
      try {
        worker = this.workerFactory(this.entry);
      } catch (error) {
        reject(asError(error));
        return;
      }

      let settled = false;
      let requestSent = false;
      let timer: NodeJS.Timeout;

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(new LogbookScanTimeoutError(filePath, this.noProgressTimeoutMs), undefined, true);
        }, this.noProgressTimeoutMs);
        timer.unref?.();
      };

      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener('message', handleMessage);
        worker.removeListener('error', handleError);
        worker.removeListener('exit', handleExit);
      };

      const finish = (error?: Error, result?: LogbookFileScanResult, kill = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          worker.kill(kill ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // The process may already have exited between its event and cleanup.
        }
        if (error) reject(error);
        else resolve(result!);
      };

      const sendRequest = () => {
        if (requestSent) return;
        requestSent = true;
        resetTimer();
        if (!worker.send) {
          finish(new Error('Logbook scan worker has no IPC channel'));
          return;
        }
        try {
          worker.send({ type: 'scan', id, filePath }, (error) => {
            if (error) finish(error);
          });
        } catch (error) {
          finish(asError(error));
        }
      };

      const handleMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) return;
        const message = value as LogbookScanWorkerMessage;
        if (message.type === 'ready') {
          resetTimer();
          sendRequest();
          return;
        }
        if ('id' in message && message.id !== id) return;
        if (message.type === 'progress') {
          resetTimer();
          onProgress?.(message.progress);
        } else if (message.type === 'result') {
          finish(undefined, message.result);
        } else if (message.type === 'error') {
          finish(deserializeError(message.error));
        }
      };

      const handleError = (error: Error) => finish(error);
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Logbook scan worker exited before returning a result (code=${code}, signal=${signal})`));
      };

      worker.on('message', handleMessage);
      worker.on('error', handleError);
      worker.on('exit', handleExit);
      worker.stdout?.resume();
      worker.stderr?.resume();
      resetTimer();
    });
  }
}

export function resolveLogbookScanWorkerEntry(): LogbookScanWorkerEntryResolution {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const isTypeScriptRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  return {
    entryPath: path.join(
      currentDir,
      isTypeScriptRuntime ? 'logbook-scan-worker-entry.ts' : 'logbook-scan-worker-entry.js',
    ),
    execArgv: isTypeScriptRuntime
      ? ['--max-old-space-size=512', '--import', 'tsx']
      : ['--max-old-space-size=512'],
    cwd: process.cwd(),
    mode: isTypeScriptRuntime ? 'development' : 'production',
  };
}

function defaultWorkerFactory(entry: LogbookScanWorkerEntryResolution): LogbookScanProcess {
  return fork(entry.entryPath, [], {
    cwd: entry.cwd,
    execArgv: entry.execArgv,
    serialization: 'advanced',
    silent: true,
  }) as LogbookScanProcess;
}

function deserializeError(input: SerializedLogbookScanError): Error {
  const error = new Error(input.message);
  error.name = input.name;
  if (input.stack) error.stack = input.stack;
  if (input.code) (error as Error & { code?: string }).code = input.code;
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
