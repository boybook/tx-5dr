import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecodeWorkerTelemetryWorker } from '@tx5dr/contracts';
import type { CWDecoderWorkerTelemetrySnapshot } from '../cw-decoder/types.js';
import { createLogger } from '../utils/logger.js';
import { probeDeepCWRuntime, runDeepCWDecode, type CWDecoderWorkerRequest, type CWDecoderWorkerResult } from './CWDecoderWorkerCore.js';

const logger = createLogger('CWDecoderWorkerPool');
const READY_TIMEOUT_MS = 10_000;
const JOB_TIMEOUT_MS = 20_000;

export interface CWDecoderWorkerPoolOptions {
  workerCount: number;
  modelPath?: string | null;
  runtimeBackend?: CWDecoderWorkerRequest['runtimeBackend'];
  modelSize?: CWDecoderWorkerRequest['modelSize'];
  language?: string;
  targetFreqHz?: number;
  filterWidthHz?: number;
  runtimeProbe?: typeof probeDeepCWRuntime;
  decode?: (request: CWDecoderWorkerRequest) => Promise<CWDecoderWorkerResult>;
}

type CWWorkerPoolStatus = CWDecoderWorkerTelemetrySnapshot['status'];

type WorkerMessage =
  | { type: 'ready'; telemetry?: WorkerTelemetryPayload }
  | { type: 'result'; id: number; result: CWDecoderWorkerResult; telemetry?: WorkerTelemetryPayload }
  | { type: 'error'; id?: number; error: string; telemetry?: WorkerTelemetryPayload };

interface WorkerTelemetryPayload {
  uptimeSeconds?: number;
  memory?: DecodeWorkerTelemetryWorker['memory'];
  cpu?: DecodeWorkerTelemetryWorker['cpu'];
  lastSeenAt?: number;
}

interface PendingJob {
  id: number;
  audio: Float32Array;
  sampleRate: number;
  resolve: (result: CWDecoderWorkerResult) => void;
  reject: (error: Error) => void;
}

interface ActiveJob extends PendingJob {
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface WorkerState {
  id: number;
  worker: ChildProcess;
  ready: boolean;
  activeJob: ActiveJob | null;
  lastTelemetry: DecodeWorkerTelemetryWorker | null;
}

export class CWDecoderWorkerPool {
  private status: CWWorkerPoolStatus = 'stopped';
  private jobsStarted = 0;
  private jobsCompleted = 0;
  private jobsFailed = 0;
  private inFlight = 0;
  private lastError: string | null = null;
  private nextId = 1;
  private readonly workerCount: number;
  private readonly modelPath?: string | null;
  private readonly runtimeBackend?: CWDecoderWorkerRequest['runtimeBackend'];
  private readonly modelSize?: CWDecoderWorkerRequest['modelSize'];
  private readonly language?: string;
  private readonly targetFreqHz?: number;
  private readonly filterWidthHz?: number;
  private readonly runtimeProbe: typeof probeDeepCWRuntime;
  private readonly decodeImpl?: (request: CWDecoderWorkerRequest) => Promise<CWDecoderWorkerResult>;
  private readonly pending: PendingJob[] = [];
  private readonly workers = new Map<number, WorkerState>();

  constructor(options: CWDecoderWorkerPoolOptions) {
    this.workerCount = Math.max(1, Math.floor(options.workerCount || 1));
    this.modelPath = options.modelPath;
    this.runtimeBackend = options.runtimeBackend;
    this.modelSize = options.modelSize;
    this.language = options.language;
    this.targetFreqHz = options.targetFreqHz;
    this.filterWidthHz = options.filterWidthHz;
    this.runtimeProbe = options.runtimeProbe ?? probeDeepCWRuntime;
    this.decodeImpl = options.decode;
  }

  async start(): Promise<void> {
    const probe = this.runtimeProbe(this.modelPath);
    if (!probe.available) {
      this.status = 'unavailable';
      this.lastError = probe.error;
      return;
    }

    if (this.decodeImpl) {
      this.status = 'running';
      this.lastError = null;
      return;
    }

    this.status = 'running';
    this.lastError = null;
    try {
      await Promise.all(Array.from({ length: this.workerCount }, (_, index) => this.spawnWorker(index + 1)));
    } catch (error) {
      await this.stop();
      this.status = 'unavailable';
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn('CW decoder worker pool failed to start', { error: this.lastError });
    }
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(new Error('CW decoder worker pool stopped before job started'));
    }
    for (const state of this.workers.values()) {
      if (state.activeJob) {
        clearTimeout(state.activeJob.timer);
        state.activeJob.reject(new Error('CW decoder worker pool stopped before job completed'));
        state.activeJob = null;
      }
      await stopWorkerProcess(state.worker).catch((error) => logger.warn('CW decoder worker terminate failed', { workerId: state.id, error }));
    }
    this.workers.clear();
    this.inFlight = 0;
  }

  async decode(audio: Float32Array, sampleRate: number): Promise<CWDecoderWorkerResult> {
    if (this.status !== 'running') {
      throw new Error(this.lastError ?? `CW decoder worker pool is ${this.status}`);
    }
    const jobId = this.nextId++;
    if (this.decodeImpl) {
      return this.runInline(jobId, audio, sampleRate);
    }

    return new Promise<CWDecoderWorkerResult>((resolve, reject) => {
      this.pending.push({ id: jobId, audio, sampleRate, resolve, reject });
      this.dispatch();
    });
  }

  getTelemetrySnapshot(): CWDecoderWorkerTelemetrySnapshot {
    return {
      status: this.status,
      workerCount: this.workerCount,
      jobsStarted: this.jobsStarted,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      inFlight: this.inFlight,
      pendingJobs: this.pending.length,
      lastError: this.lastError,
      workers: [...this.workers.values()].map((state) => this.buildWorkerTelemetry(state)),
    };
  }

  private async runInline(id: number, audio: Float32Array, sampleRate: number): Promise<CWDecoderWorkerResult> {
    this.jobsStarted += 1;
    this.inFlight += 1;
    try {
      const result = await (this.decodeImpl ?? runDeepCWDecode)(this.buildRequest(id, audio, sampleRate));
      this.jobsCompleted += 1;
      return result;
    } catch (error) {
      this.jobsFailed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private spawnWorker(workerId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = resolveWorkerEntry();
      const initData = {
        modelPath: this.modelPath,
        runtimeBackend: this.runtimeBackend,
        modelSize: this.modelSize,
        language: this.language,
        targetFreqHz: this.targetFreqHz,
        filterWidthHz: this.filterWidthHz,
      } satisfies Partial<CWDecoderWorkerRequest>;
      const worker = fork(entry.entryPath, [], {
        execArgv: entry.execArgv,
        serialization: 'advanced',
        silent: true,
        env: {
          ...process.env,
          TX5DR_CW_DECODER_INIT: JSON.stringify(initData),
        },
      });
      const state: WorkerState = {
        id: workerId,
        worker,
        ready: false,
        activeJob: null,
        lastTelemetry: null,
      };
      this.workers.set(workerId, state);
      wireOutput(worker.stdout, (line) => logger.debug('CW decoder worker stdout', { workerId, line }));
      wireOutput(worker.stderr, (line) => logger.warn('CW decoder worker stderr', { workerId, line }));

      const timer = setTimeout(() => {
        reject(new Error('CW decoder worker startup timed out'));
      }, READY_TIMEOUT_MS);

      worker.on('message', (message) => {
        const workerMessage = message as WorkerMessage;
        const wasReady = state.ready;
        this.handleWorkerMessage(state, workerMessage);
        if (workerMessage.type === 'ready' && !wasReady) {
          clearTimeout(timer);
          resolve();
        } else if (workerMessage.type === 'error' && !wasReady && workerMessage.id === undefined) {
          clearTimeout(timer);
          reject(new Error(workerMessage.error));
        }
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        this.recordFailure(error);
        reject(error);
      });
      worker.once('exit', (code) => {
        this.workers.delete(workerId);
        if (this.status === 'running' && code !== 0) {
          this.recordFailure(new Error(`CW decoder worker exited with code ${code}`));
        }
      });
    });
  }

  private handleWorkerMessage(state: WorkerState, message: WorkerMessage): void {
    this.updateTelemetry(state, message.telemetry);
    if (message.type === 'ready') {
      state.ready = true;
      this.dispatch();
      return;
    }
    if (message.type === 'error' && message.id === undefined) {
      this.recordFailure(new Error(message.error));
      return;
    }

    const activeJob = state.activeJob;
    if (!activeJob || activeJob.id !== message.id) {
      return;
    }
    clearTimeout(activeJob.timer);
    state.activeJob = null;
    this.inFlight = Math.max(0, this.inFlight - 1);

    if (message.type === 'result') {
      this.jobsCompleted += 1;
      activeJob.resolve(message.result);
    } else {
      this.jobsFailed += 1;
      this.lastError = message.error;
      activeJob.reject(new Error(message.error));
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.status !== 'running') return;
    for (const state of this.workers.values()) {
      if (this.pending.length === 0) return;
      if (!state.ready || state.activeJob) continue;
      const job = this.pending.shift()!;
      this.jobsStarted += 1;
      this.inFlight += 1;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (state.activeJob?.id !== job.id) return;
        state.activeJob = null;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.jobsFailed += 1;
        this.lastError = 'CW decoder job timed out';
        job.reject(new Error(this.lastError));
        void stopWorkerProcess(state.worker);
      }, JOB_TIMEOUT_MS);
      state.activeJob = { ...job, timer, startedAt };
      const sent = state.worker.send?.(this.buildRequest(job.id, job.audio, job.sampleRate), (error) => {
        if (!error) return;
        clearTimeout(timer);
        if (state.activeJob?.id === job.id) state.activeJob = null;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.jobsFailed += 1;
        this.lastError = error.message;
        job.reject(error);
      });
      if (sent === false) {
        logger.warn('CW decoder worker IPC backpressure', { workerId: state.id, jobId: job.id });
      }
    }
  }

  private buildRequest(id: number, audio: Float32Array, sampleRate: number): CWDecoderWorkerRequest {
    return {
      id,
      audio,
      sampleRate,
      modelPath: this.modelPath,
      runtimeBackend: this.runtimeBackend,
      modelSize: this.modelSize,
      language: this.language,
      targetFreqHz: this.targetFreqHz,
      filterWidthHz: this.filterWidthHz,
    };
  }

  private updateTelemetry(state: WorkerState, telemetry?: WorkerTelemetryPayload): void {
    if (!telemetry) return;
    state.lastTelemetry = {
      workerId: state.id,
      ready: state.ready,
      busy: Boolean(state.activeJob),
      nativeThreads: 1,
      uptimeSeconds: telemetry.uptimeSeconds ?? 0,
      memory: telemetry.memory ?? { heapUsed: 0, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 },
      cpu: telemetry.cpu ?? { user: 0, system: 0, total: 0 },
      lastSeenAt: telemetry.lastSeenAt ?? Date.now(),
    };
  }

  private buildWorkerTelemetry(state: WorkerState): DecodeWorkerTelemetryWorker {
    const activeJob = state.activeJob;
    return {
      workerId: state.id,
      ready: state.ready,
      busy: Boolean(activeJob),
      nativeThreads: 1,
      uptimeSeconds: state.lastTelemetry?.uptimeSeconds ?? 0,
      memory: state.lastTelemetry?.memory ?? { heapUsed: 0, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 },
      cpu: state.lastTelemetry?.cpu ?? { user: 0, system: 0, total: 0 },
      currentJob: activeJob
        ? {
            jobId: activeJob.id,
            slotId: 'cw-stream',
            windowIdx: activeJob.id,
            mode: 'cw',
            startedAt: activeJob.startedAt,
            elapsedMs: Date.now() - activeJob.startedAt,
            requestAudioDurationMs: activeJob.sampleRate > 0 ? (activeJob.audio.length / activeJob.sampleRate) * 1000 : undefined,
          }
        : undefined,
      lastSeenAt: state.lastTelemetry?.lastSeenAt ?? Date.now(),
    };
  }

  private recordFailure(error: Error): void {
    this.jobsFailed += 1;
    this.lastError = error.message;
    if (this.workers.size === 0) {
      this.status = 'unavailable';
    }
  }
}

function resolveWorkerEntry(): { entryPath: string; execArgv: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const isTypeScriptRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  return {
    entryPath: path.join(currentDir, isTypeScriptRuntime ? 'cw-decoder-worker-entry.ts' : 'cw-decoder-worker-entry.js'),
    // Keep this aligned with the FT8/FT4 decode process pool. In dev, fork a
    // TS entry with the tsx loader instead of handing a .ts file to Worker.
    execArgv: isTypeScriptRuntime ? ['--import', 'tsx'] : [],
  };
}

function wireOutput(stream: NodeJS.ReadableStream | null | undefined, log: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) log(line);
      newlineIndex = buffer.indexOf('\n');
    }
  });
}

function stopWorkerProcess(worker: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (worker.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      worker.kill('SIGTERM');
      resolve();
    }, 2_000);
    worker.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    const sent = worker.send?.({ type: 'shutdown' }, (error) => {
      if (error) {
        clearTimeout(timer);
        worker.kill('SIGTERM');
        resolve();
      }
    });
    if (sent === undefined) {
      clearTimeout(timer);
      worker.kill('SIGTERM');
      resolve();
    }
  });
}
