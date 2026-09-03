import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdifRewriteChunk } from './AdifFileStore.js';

const DEFAULT_TIMEOUT_MS = 60_000;

interface RewriteWorkerProcess extends EventEmitter {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  send?: (message: RewriteWorkerRequest, callback?: (error: Error | null) => void) => boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface RewriteWorkerEntry {
  entryPath: string;
  execArgv: string[];
  cwd: string;
}

interface SourceChunk {
  kind: 'source';
  range: { start: number; end: number };
}

interface BytesChunk {
  kind: 'bytes';
  bytes: Uint8Array;
}

type RewriteWorkerChunk = SourceChunk | BytesChunk;

interface RewriteWorkerRequest {
  type: 'rewrite';
  id: number;
  sourcePath: string;
  tempPath: string;
  mode: number;
  chunks: RewriteWorkerChunk[];
}

type RewriteWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number }
  | { type: 'error'; id: number; message: string; stack?: string };

export class AdifRewriteWorker {
  private nextRequestId = 1;

  async write(
    sourcePath: string,
    tempPath: string,
    mode: number,
    source: Iterable<AdifRewriteChunk>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    const chunks: RewriteWorkerChunk[] = [];
    let chunkIndex = 0;
    for (const chunk of source) {
      if (chunk instanceof Uint8Array) {
        chunks.push({ kind: 'bytes', bytes: Buffer.from(chunk) });
      } else if (chunk.kind === 'source') {
        chunks.push({ kind: 'source', range: { ...chunk.range } });
      } else {
        chunks.push({ kind: 'bytes', bytes: Buffer.from(chunk.bytes) });
      }
      chunkIndex += 1;
      if (chunkIndex % 256 === 0) await yieldToEventLoop();
    }

    const entry = resolveAdifRewriteWorkerEntry();
    const worker = fork(entry.entryPath, [], {
      cwd: entry.cwd,
      execArgv: entry.execArgv,
      serialization: 'advanced',
      silent: true,
    }) as RewriteWorkerProcess;
    const id = this.nextRequestId++;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        try { worker.kill(error ? 'SIGKILL' : 'SIGTERM'); } catch {}
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) return;
        const message = value as RewriteWorkerMessage;
        if (message.type === 'ready') {
          if (!worker.send) {
            finish(new Error('ADIF rewrite worker has no IPC channel'));
            return;
          }
          try {
            worker.send({ type: 'rewrite', id, sourcePath, tempPath, mode, chunks }, (error) => {
              if (error) finish(error);
            });
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        } else if (message.type === 'result' && message.id === id) {
          finish();
        } else if (message.type === 'error' && message.id === id) {
          const error = new Error(message.message);
          if (message.stack) error.stack = message.stack;
          finish(error);
        }
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`ADIF rewrite worker exited before returning a result (code=${code}, signal=${signal})`));
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.stdout?.resume();
      worker.stderr?.resume();
      const timer = setTimeout(() => finish(new Error(`ADIF rewrite worker timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function resolveAdifRewriteWorkerEntry(): RewriteWorkerEntry {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const isTypeScriptRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  return {
    entryPath: path.join(
      currentDir,
      isTypeScriptRuntime ? 'adif-rewrite-worker-entry.ts' : 'adif-rewrite-worker-entry.js',
    ),
    execArgv: isTypeScriptRuntime
      ? ['--max-old-space-size=512', '--import', 'tsx']
      : ['--max-old-space-size=512'],
    cwd: process.cwd(),
  };
}
