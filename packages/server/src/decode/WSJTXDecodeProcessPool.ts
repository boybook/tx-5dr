import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecodeRequest, DecodeResult } from '@tx5dr/core';
import type { DecodeWorkerTelemetrySnapshot, DecodeWorkerTelemetryWorker } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DecodeProcessPool');
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_JOB_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_AUTO_WORKERS = 2;
const MAX_CONFIGURED_WORKERS = 4;
const MAX_NATIVE_THREADS_PER_WORKER = 4;
const LOW_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES_BEFORE_DEGRADE = 3;
const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000] as const;

export type DecodeWorkerCountReason = 'explicit' | 'low-memory' | 'low-cpu' | 'default';
export type DecodeNativeThreadReason = 'explicit' | 'default';
export type DecodeWorkerPoolStatus = 'starting' | 'ready' | 'degraded' | 'unavailable';

export interface DecodeWorkerCountDecision {
  configuredWorkers: string | undefined;
  resolvedWorkers: number;
  totalMemoryGiB: number;
  cpuCount: number;
  reason: DecodeWorkerCountReason;
  warning?: string;
}

export interface DecodeWorkerCountOsInfo {
  totalmem: () => number;
  cpuCount: () => number;
}

export interface DecodeNativeThreadDecision {
  configuredThreads: string | undefined;
  resolvedThreads: number;
  workerCount: number;
  cpuCount: number;
  reservedCpuCount: number;
  totalDecodeThreadBudget: number;
  reason: DecodeNativeThreadReason;
  warning?: string;
}

export interface SerializedWorkerError {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface DecodeWorkerProcess extends EventEmitter {
  pid?: number;
  killed?: boolean;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface DecodeProcessPoolOptions {
  workerCount?: number;
  readyTimeoutMs?: number;
  jobTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  workerFactory?: (workerId: number, entry: WorkerEntryResolution, env: NodeJS.ProcessEnv) => DecodeWorkerProcess;
}

export interface WorkerEntryResolution {
  entryPath: string;
  execArgv: string[];
  cwd: string;
  mode: 'development' | 'production';
}

export interface DecodeWorkerPoolHealthSnapshot {
  status: DecodeWorkerPoolStatus;
  desiredWorkers: number;
  readyWorkers: number;
  workerProcesses: number;
  pendingJobs: number;
  activeJobs: number;
  nativeThreadsPerWorker: number;
  lastFailure?: string;
  lastFailureAt?: number;
  restartAttempts: number;
  workerEntry: string;
  workerMode: WorkerEntryResolution['mode'];
}

interface PendingJob {
  id: number;
  request: DecodeRequest;
  enqueuedAt: number;
  resolve: (result: DecodeResult) => void;
  reject: (error: Error) => void;
}

interface ActiveJob extends PendingJob {
  timer: NodeJS.Timeout;
  dispatchedAt: number;
}

interface WorkerState {
  id: number;
  process: DecodeWorkerProcess;
  ready: boolean;
  activeJob: ActiveJob | null;
  startTimer: NodeJS.Timeout;
  stopping: boolean;
  failureRecorded: boolean;
  lastTelemetry: DecodeWorkerTelemetryWorker | null;
}

type WorkerMessage =
  | { type: 'ready'; workerId?: string }
  | { type: 'telemetry'; workerId?: string; metrics: DecodeWorkerTelemetryWorker }
  | { type: 'result'; id: number; result: DecodeResult }
  | { type: 'error'; id: number; error: SerializedWorkerError }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta?: unknown };

function isToolingWatchMessage(message: Record<string, unknown>): boolean {
  return Object.keys(message).some((key) => key.startsWith('watch:'));
}

export function resolveDecodeWorkerCount(
  env: NodeJS.ProcessEnv = process.env,
  osInfo: DecodeWorkerCountOsInfo = {
    totalmem: () => os.totalmem(),
    cpuCount: () => os.availableParallelism?.() ?? os.cpus().length,
  },
): DecodeWorkerCountDecision {
  const configuredWorkers = env.TX5DR_DECODE_WORKERS;
  const totalMemoryBytes = osInfo.totalmem();
  const totalMemoryGiB = Number((totalMemoryBytes / 1024 / 1024 / 1024).toFixed(2));
  const cpuCount = osInfo.cpuCount();
  const normalized = configuredWorkers?.trim().toLowerCase();

  if (normalized && normalized !== 'auto') {
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && String(parsed) === normalized && parsed > 0) {
      return {
        configuredWorkers,
        resolvedWorkers: Math.min(Math.max(parsed, 1), MAX_CONFIGURED_WORKERS),
        totalMemoryGiB,
        cpuCount,
        reason: 'explicit',
      };
    }
  }

  if (totalMemoryBytes < LOW_MEMORY_BYTES) {
    return {
      configuredWorkers,
      resolvedWorkers: 1,
      totalMemoryGiB,
      cpuCount,
      reason: 'low-memory',
      warning: normalized && normalized !== 'auto' ? `invalid TX5DR_DECODE_WORKERS=${configuredWorkers}; using auto policy` : undefined,
    };
  }

  if (cpuCount <= 2) {
    return {
      configuredWorkers,
      resolvedWorkers: 1,
      totalMemoryGiB,
      cpuCount,
      reason: 'low-cpu',
      warning: normalized && normalized !== 'auto' ? `invalid TX5DR_DECODE_WORKERS=${configuredWorkers}; using auto policy` : undefined,
    };
  }

  return {
    configuredWorkers,
    resolvedWorkers: MAX_AUTO_WORKERS,
    totalMemoryGiB,
    cpuCount,
    reason: 'default',
    warning: normalized && normalized !== 'auto' ? `invalid TX5DR_DECODE_WORKERS=${configuredWorkers}; using auto policy` : undefined,
  };
}

export function resolveDecodeNativeThreadCount(
  env: NodeJS.ProcessEnv = process.env,
  workerCount: number,
  cpuCount: number = os.availableParallelism?.() ?? os.cpus().length,
): DecodeNativeThreadDecision {
  const configuredThreads = env.TX5DR_DECODE_THREADS;
  const normalized = configuredThreads?.trim().toLowerCase();
  const safeWorkerCount = Math.max(1, workerCount);
  const safeCpuCount = Math.max(1, cpuCount);
  const reservedCpuCount = safeCpuCount <= 4 ? 1 : 2;
  const totalDecodeThreadBudget = Math.max(1, safeCpuCount - reservedCpuCount);

  if (normalized && normalized !== 'auto') {
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && String(parsed) === normalized && parsed > 0) {
      return {
        configuredThreads,
        resolvedThreads: Math.min(Math.max(parsed, 1), MAX_NATIVE_THREADS_PER_WORKER),
        workerCount: safeWorkerCount,
        cpuCount: safeCpuCount,
        reservedCpuCount,
        totalDecodeThreadBudget,
        reason: 'explicit',
      };
    }
  }

  return {
    configuredThreads,
    resolvedThreads: 1,
    workerCount: safeWorkerCount,
    cpuCount: safeCpuCount,
    reservedCpuCount,
    totalDecodeThreadBudget,
    reason: 'default',
    warning: normalized && normalized !== 'auto' ? `invalid TX5DR_DECODE_THREADS=${configuredThreads}; using auto policy` : undefined,
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDecodeWorkerEntry(): WorkerEntryResolution {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const sourceEntry = path.join(currentDir, 'decode-worker-entry.ts');
  const distEntry = path.join(currentDir, 'decode-worker-entry.js');
  const isTypeScriptRuntime = currentFile.endsWith('.ts') || currentDir.includes(`${path.sep}src${path.sep}`);
  const entryPath = isTypeScriptRuntime ? sourceEntry : distEntry;

  return {
    entryPath,
    execArgv: isTypeScriptRuntime ? ['--import', 'tsx'] : [],
    cwd: process.cwd(),
    mode: isTypeScriptRuntime ? 'development' : 'production',
  };
}

function createError(serialized: SerializedWorkerError | unknown): Error {
  if (serialized && typeof serialized === 'object' && 'message' in serialized) {
    const input = serialized as SerializedWorkerError;
    const error = new Error(input.message);
    error.name = input.name || 'Error';
    if (input.stack) error.stack = input.stack;
    if (input.code) (error as Error & { code?: string }).code = input.code;
    return error;
  }
  return new Error(String(serialized));
}

function defaultWorkerFactory(workerId: number, entry: WorkerEntryResolution, env: NodeJS.ProcessEnv): DecodeWorkerProcess {
  return fork(entry.entryPath, [], {
    cwd: entry.cwd,
    env,
    execArgv: entry.execArgv,
    serialization: 'advanced',
    silent: true,
  }) as DecodeWorkerProcess;
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

function getDecodeRequestAudioDurationMs(request: DecodeRequest): number | undefined {
  if (!request.sampleRate || request.sampleRate <= 0) return undefined;
  return Number(((request.pcm.byteLength / Float32Array.BYTES_PER_ELEMENT / request.sampleRate) * 1000).toFixed(1));
}

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

export class WSJTXDecodeProcessPool extends EventEmitter {
  private readonly pending: PendingJob[] = [];
  private readonly workers = new Map<number, WorkerState>();
  private readonly readyTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly workerFactory: (workerId: number, entry: WorkerEntryResolution, env: NodeJS.ProcessEnv) => DecodeWorkerProcess;
  private readonly entry: WorkerEntryResolution;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nativeThreads: number;
  private nextJobId = 1;
  private nextWorkerId = 1;
  private readonly initialDesiredWorkers: number;
  private desiredWorkers: number;
  private destroyed = false;
  private consecutiveFailures = 0;
  private restartAttempts = 0;
  private lastFailure: string | undefined;
  private lastFailureAt: number | undefined;
  private healthStatus: DecodeWorkerPoolStatus = 'starting';
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(options: DecodeProcessPoolOptions = {}) {
    super();
    const configEnv = options.env ?? process.env;
    const decision = resolveDecodeWorkerCount(configEnv);
    this.desiredWorkers = Math.min(Math.max(options.workerCount ?? decision.resolvedWorkers, 1), MAX_CONFIGURED_WORKERS);
    this.initialDesiredWorkers = this.desiredWorkers;
    const loggedDecision: DecodeWorkerCountDecision = options.workerCount === undefined
      ? decision
      : {
          ...decision,
          configuredWorkers: String(options.workerCount),
          resolvedWorkers: this.desiredWorkers,
          reason: 'explicit',
          warning: undefined,
        };
    const nativeThreadDecision = resolveDecodeNativeThreadCount(
      configEnv,
      this.desiredWorkers,
      loggedDecision.cpuCount,
    );
    this.nativeThreads = nativeThreadDecision.resolvedThreads;
    this.readyTimeoutMs = options.readyTimeoutMs ?? parsePositiveInteger(configEnv.TX5DR_DECODE_WORKER_START_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS);
    this.jobTimeoutMs = options.jobTimeoutMs ?? parsePositiveInteger(configEnv.TX5DR_DECODE_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS);
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.entry = resolveDecodeWorkerEntry();
    this.env = {
      ...configEnv,
      TX5DR_DECODE_NATIVE_THREADS: String(this.nativeThreads),
    };

    logger.info('decode worker pool initialized', {
      ...loggedDecision,
      nativeThreads: nativeThreadDecision,
      readyTimeoutMs: this.readyTimeoutMs,
      jobTimeoutMs: this.jobTimeoutMs,
      workerEntry: this.entry.entryPath,
      workerMode: this.entry.mode,
    });
    if (loggedDecision.warning) {
      logger.warn('decode worker count config ignored', { warning: loggedDecision.warning });
    }
    if (nativeThreadDecision.warning) {
      logger.warn('decode native thread config ignored', { warning: nativeThreadDecision.warning });
    }

    this.ensureWorkerCount();
    this.refreshHealthStatus();
  }

  decode(request: DecodeRequest): Promise<DecodeResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('decode worker pool has been destroyed'));
    }
    this.refreshHealthStatus();
    if (this.healthStatus === 'unavailable' && this.getReadyWorkerCount() === 0) {
      return Promise.reject(new Error(`decode worker unavailable: ${this.lastFailure ?? 'no worker is ready'}`));
    }

    return new Promise<DecodeResult>((resolve, reject) => {
      this.pending.push({
        id: this.nextJobId++,
        request,
        enqueuedAt: performance.now(),
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  size(): number {
    let active = 0;
    for (const worker of this.workers.values()) {
      if (worker.activeJob) active++;
    }
    return this.pending.length + active;
  }

  getStatus() {
    let active = 0;
    let ready = 0;
    for (const worker of this.workers.values()) {
      if (worker.ready) ready++;
      if (worker.activeJob) active++;
    }
    return {
      status: this.healthStatus,
      queueSize: this.size(),
      maxConcurrency: this.desiredWorkers,
      activeThreads: active,
      readyWorkers: ready,
      workerProcesses: this.workers.size,
      nativeThreadsPerWorker: this.nativeThreads,
      totalNativeDecodeThreads: this.nativeThreads * this.desiredWorkers,
      utilization: this.desiredWorkers > 0 ? active / this.desiredWorkers : 0,
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt,
      restartAttempts: this.restartAttempts,
    };
  }

  getHealthSnapshot(): DecodeWorkerPoolHealthSnapshot {
    this.refreshHealthStatus();
    return this.buildHealthSnapshot();
  }

  getTelemetrySnapshot(): DecodeWorkerTelemetrySnapshot | undefined {
    this.refreshHealthStatus();
    const now = Date.now();
    const workers = [...this.workers.values()]
      .map((worker) => this.buildWorkerTelemetrySnapshot(worker, now))
      .filter((worker): worker is DecodeWorkerTelemetryWorker => worker !== null);

    if (workers.length === 0 && this.healthStatus === 'ready') {
      return undefined;
    }

    return {
      summary: {
        status: this.healthStatus,
        workerCount: workers.length,
        desiredWorkers: this.desiredWorkers,
        readyCount: workers.filter((worker) => worker.ready).length,
        busyCount: workers.filter((worker) => worker.busy).length,
        totalRss: workers.reduce((sum, worker) => sum + worker.memory.rss, 0),
        totalCpu: workers.reduce((sum, worker) => sum + worker.cpu.total, 0),
        nativeThreadsPerWorker: this.nativeThreads,
        pendingJobs: this.pending.length,
        activeJobs: this.getActiveJobCount(),
        lastError: this.lastFailure,
        lastFailureAt: this.lastFailureAt,
        restartAttempts: this.restartAttempts,
        workerEntry: this.entry.entryPath,
        workerMode: this.entry.mode,
      },
      workers,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(new Error('decode worker pool destroyed before job started'));
    }

    await Promise.all([...this.workers.values()].map((worker) => this.stopWorker(worker)));
    this.workers.clear();
    logger.info('decode worker pool destroyed');
  }

  private ensureWorkerCount(): void {
    if (this.destroyed) return;
    if (this.respawnTimer) return;
    this.purgeKilledIdleWorkers();
    while (this.workers.size < this.desiredWorkers) {
      if (!this.spawnWorker()) {
        break;
      }
    }
    this.refreshHealthStatus();
  }

  private purgeKilledIdleWorkers(): void {
    for (const worker of this.workers.values()) {
      if (worker.process.killed && !worker.activeJob) {
        clearTimeout(worker.startTimer);
        this.workers.delete(worker.id);
      }
    }
  }

  private spawnWorker(): boolean {
    const workerId = this.nextWorkerId++;
    const env = {
      ...this.env,
      TX5DR_DECODE_WORKER_ID: String(workerId),
    };
    let child: DecodeWorkerProcess;
    try {
      child = this.workerFactory(workerId, this.entry, env);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('decode worker spawn failed', {
        workerId,
        error: err.message,
        workerEntry: this.entry.entryPath,
        workerMode: this.entry.mode,
      });
      this.recordWorkerFailure(workerId, err);
      this.scheduleRespawn();
      this.refreshHealthStatus();
      return false;
    }
    const state: WorkerState = {
      id: workerId,
      process: child,
      ready: false,
      activeJob: null,
      stopping: false,
      failureRecorded: false,
      lastTelemetry: null,
      startTimer: setTimeout(() => {
        logger.warn('decode worker startup timed out', { workerId, timeoutMs: this.readyTimeoutMs });
        this.handleWorkerFailure(state, new Error('decode worker startup timed out'));
        this.killWorker(state);
        this.scheduleRespawn();
      }, this.readyTimeoutMs),
    };

    this.workers.set(workerId, state);
    wireOutput(child.stdout, (line) => logger.debug('decode worker stdout', { workerId, line }));
    wireOutput(child.stderr, (line) => logger.warn('decode worker stderr', { workerId, line }));

    child.on('message', (message) => this.handleWorkerMessage(state, message));
    child.once('error', (error) => {
      logger.warn('decode worker process error', { workerId, error: error.message, code: (error as Error & { code?: string }).code });
      this.handleWorkerFailure(state, error);
      this.killWorker(state);
      this.scheduleRespawn();
    });
    child.once('exit', (code, signal) => {
      if (state.stopping || this.destroyed) {
        logger.debug('decode worker exited', { workerId, code, signal });
      } else {
        logger.warn('decode worker exited', { workerId, code, signal });
      }
      this.handleWorkerExit(state, code, signal);
    });
    this.refreshHealthStatus();
    return true;
  }

  private handleWorkerMessage(state: WorkerState, message: unknown): void {
    if (!message || typeof message !== 'object') return;
    if (!('type' in message)) {
      if (isToolingWatchMessage(message as Record<string, unknown>)) {
        logger.debug('ignored decode worker tooling watch message', { workerId: state.id });
        return;
      }
      logger.warn('decode worker returned unknown message', { workerId: state.id, message });
      return;
    }

    const workerMessage = message as WorkerMessage;

    if (workerMessage.type === 'ready') {
      clearTimeout(state.startTimer);
      state.ready = true;
      this.consecutiveFailures = 0;
      this.lastFailure = undefined;
      this.lastFailureAt = undefined;
      logger.info('decode worker ready', { workerId: state.id, pid: state.process.pid });
      this.refreshHealthStatus();
      this.dispatch();
      return;
    }

    if (workerMessage.type === 'log') {
      const log = logger[workerMessage.level] ?? logger.info;
      log(`worker ${state.id}: ${workerMessage.message}`, workerMessage.meta);
      return;
    }

    if (workerMessage.type === 'telemetry') {
      state.lastTelemetry = {
        ...workerMessage.metrics,
        workerId: state.id,
        pid: state.process.pid ?? workerMessage.metrics.pid,
        ready: state.ready,
        busy: Boolean(state.activeJob),
        nativeThreads: this.nativeThreads,
        lastSeenAt: Date.now(),
      };
      return;
    }

    const activeJob = state.activeJob;
    if (!activeJob || activeJob.id !== workerMessage.id) {
      logger.warn('decode worker returned unknown job', { workerId: state.id, message: workerMessage });
      return;
    }

    clearTimeout(activeJob.timer);
    state.activeJob = null;
    this.consecutiveFailures = 0;

    if (workerMessage.type === 'result') {
      const completedAt = performance.now();
      const queueWaitMs = activeJob.dispatchedAt - activeJob.enqueuedAt;
      const workerElapsedMs = completedAt - activeJob.dispatchedAt;
      const totalElapsedMs = completedAt - activeJob.enqueuedAt;
      const nativeProcessingTimeMs = workerMessage.result.processingTimeMs;
      logger.info('decode worker job completed', {
        workerId: state.id,
        workerPid: state.process.pid,
        jobId: activeJob.id,
        slotId: activeJob.request.slotId,
        windowIdx: activeJob.request.windowIdx,
        mode: activeJob.request.mode,
        apDecode: Boolean(activeJob.request.apContext),
        apOperatorId: activeJob.request.apContext?.operatorId,
        apCurrentSlot: activeJob.request.apContext?.currentSlot,
        apQsoProgress: activeJob.request.apContext?.qsoProgress,
        frameCount: workerMessage.result.frames.length,
        queueWaitMs: roundMs(queueWaitMs),
        workerElapsedMs: roundMs(workerElapsedMs),
        totalElapsedMs: roundMs(totalElapsedMs),
        nativeProcessingTimeMs: Number(nativeProcessingTimeMs.toFixed(1)),
        poolOverheadMs: roundMs(workerElapsedMs - nativeProcessingTimeMs),
        requestAudioDurationMs: getDecodeRequestAudioDurationMs(activeJob.request),
        pcmBytes: activeJob.request.pcm.byteLength,
        sampleRate: activeJob.request.sampleRate,
        pendingJobs: this.pending.length,
        activeJobs: this.getActiveJobCount(),
        readyWorkers: this.getReadyWorkerCount(),
        workerProcesses: this.workers.size,
        desiredWorkers: this.desiredWorkers,
        nativeThreadsPerWorker: this.nativeThreads,
      });
      activeJob.resolve(workerMessage.result);
    } else {
      const failedAt = performance.now();
      logger.warn('decode worker job failed', {
        workerId: state.id,
        workerPid: state.process.pid,
        jobId: activeJob.id,
        slotId: activeJob.request.slotId,
        windowIdx: activeJob.request.windowIdx,
        mode: activeJob.request.mode,
        queueWaitMs: roundMs(activeJob.dispatchedAt - activeJob.enqueuedAt),
        workerElapsedMs: roundMs(failedAt - activeJob.dispatchedAt),
        totalElapsedMs: roundMs(failedAt - activeJob.enqueuedAt),
        requestAudioDurationMs: getDecodeRequestAudioDurationMs(activeJob.request),
        error: workerMessage.error,
      });
      activeJob.reject(createError(workerMessage.error));
    }

    this.dispatch();
  }

  private dispatch(): void {
    if (this.destroyed) return;
    this.ensureWorkerCount();

    for (const worker of this.workers.values()) {
      if (this.pending.length === 0) return;
      if (!worker.ready || worker.activeJob) continue;

      const job = this.pending.shift()!;
      const dispatchedAt = performance.now();
      const timer = setTimeout(() => {
        logger.warn('decode job timed out', { workerId: worker.id, jobId: job.id, timeoutMs: this.jobTimeoutMs });
        job.reject(new Error('decode job timed out'));
        worker.activeJob = null;
        this.handleWorkerFailure(worker, new Error('decode job timed out'));
        this.killWorker(worker);
        this.scheduleRespawn();
      }, this.jobTimeoutMs);
      worker.activeJob = { ...job, timer, dispatchedAt };

      const ok = worker.process.send?.({
        type: 'decode',
        id: job.id,
        request: job.request,
      }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        if (worker.activeJob?.id === job.id) worker.activeJob = null;
        job.reject(error);
        this.handleWorkerFailure(worker, error);
        this.killWorker(worker);
        this.scheduleRespawn();
      });

      if (ok === false) {
        logger.warn(
          `decode worker IPC backpressure workerId=${worker.id} workerPid=${worker.process.pid ?? 'unknown'} `
          + `jobId=${job.id} slotId=${job.request.slotId} windowIdx=${job.request.windowIdx} mode=${job.request.mode} `
          + `requestAudioDurationMs=${getDecodeRequestAudioDurationMs(job.request) ?? 'unknown'} `
          + `queueWaitMs=${roundMs(dispatchedAt - job.enqueuedAt)} dispatchElapsedMs=${roundMs(performance.now() - dispatchedAt)} `
          + `pcmBytes=${job.request.pcm.byteLength} sampleRate=${job.request.sampleRate} `
          + `pendingJobs=${this.pending.length} activeJobs=${this.getActiveJobCount()} readyWorkers=${this.getReadyWorkerCount()} `
          + `workerProcesses=${this.workers.size} desiredWorkers=${this.desiredWorkers} nativeThreadsPerWorker=${this.nativeThreads} `
          + `jobTimeoutMs=${this.jobTimeoutMs} readyTimeoutMs=${this.readyTimeoutMs} ipcSendReturned=false`,
        );
      }
    }
  }

  private getActiveJobCount(): number {
    let active = 0;
    for (const worker of this.workers.values()) {
      if (worker.activeJob) active++;
    }
    return active;
  }

  private getReadyWorkerCount(): number {
    let ready = 0;
    for (const worker of this.workers.values()) {
      if (worker.ready) ready++;
    }
    return ready;
  }

  private resolveHealthStatus(): DecodeWorkerPoolStatus {
    const readyWorkers = this.getReadyWorkerCount();
    if (readyWorkers > 0) {
      return this.desiredWorkers < this.initialDesiredWorkers || readyWorkers < this.desiredWorkers
        ? 'degraded'
        : 'ready';
    }
    if (this.lastFailure) {
      return 'unavailable';
    }
    return 'starting';
  }

  private buildHealthSnapshot(): DecodeWorkerPoolHealthSnapshot {
    return {
      status: this.healthStatus,
      desiredWorkers: this.desiredWorkers,
      readyWorkers: this.getReadyWorkerCount(),
      workerProcesses: this.workers.size,
      pendingJobs: this.pending.length,
      activeJobs: this.getActiveJobCount(),
      nativeThreadsPerWorker: this.nativeThreads,
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt,
      restartAttempts: this.restartAttempts,
      workerEntry: this.entry.entryPath,
      workerMode: this.entry.mode,
    };
  }

  private refreshHealthStatus(): void {
    const nextStatus = this.resolveHealthStatus();
    if (nextStatus === this.healthStatus) return;
    const previousStatus = this.healthStatus;
    this.healthStatus = nextStatus;
    if (nextStatus === 'unavailable') {
      this.rejectPendingForUnavailable();
    }
    this.emit('healthStatusChanged', this.buildHealthSnapshot(), previousStatus);
  }

  private rejectPendingForUnavailable(): void {
    if (this.pending.length === 0) return;
    const error = new Error(`decode worker unavailable: ${this.lastFailure ?? 'no worker is ready'}`);
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(error);
    }
  }

  private buildWorkerTelemetrySnapshot(worker: WorkerState, now: number): DecodeWorkerTelemetryWorker | null {
    if (!worker.lastTelemetry) {
      return null;
    }

    const activeJob = worker.activeJob;
    return {
      ...worker.lastTelemetry,
      workerId: worker.id,
      pid: worker.process.pid ?? worker.lastTelemetry.pid,
      ready: worker.ready,
      busy: Boolean(activeJob),
      nativeThreads: this.nativeThreads,
      currentJob: activeJob
        ? {
            jobId: activeJob.id,
            slotId: activeJob.request.slotId,
            windowIdx: activeJob.request.windowIdx,
            mode: activeJob.request.mode,
            startedAt: now - (performance.now() - activeJob.dispatchedAt),
            elapsedMs: performance.now() - activeJob.dispatchedAt,
            requestAudioDurationMs: getDecodeRequestAudioDurationMs(activeJob.request),
          }
        : undefined,
    };
  }

  private handleWorkerExit(state: WorkerState, code: number | null, signal: NodeJS.Signals | null): void {
    clearTimeout(state.startTimer);
    if (state.activeJob) {
      clearTimeout(state.activeJob.timer);
      state.activeJob.reject(new Error(`decode worker exited before job completed (code=${code}, signal=${signal})`));
      state.activeJob = null;
    }
    this.workers.delete(state.id);

    if (!this.destroyed && !state.stopping) {
      this.handleWorkerFailure(state, new Error(`decode worker exited (code=${code}, signal=${signal})`));
      this.scheduleRespawn();
      this.dispatch();
    }
    this.refreshHealthStatus();
  }

  private handleWorkerFailure(state: WorkerState, error: Error): void {
    if (state.failureRecorded) {
      return;
    }
    state.failureRecorded = true;
    this.recordWorkerFailure(state.id, error);
  }

  private recordWorkerFailure(workerId: number, error: Error): void {
    this.consecutiveFailures++;
    this.restartAttempts++;
    this.lastFailure = error.message;
    this.lastFailureAt = Date.now();
    const code = (error as Error & { code?: string }).code;
    if (this.desiredWorkers > 1 && (code === 'ENOMEM' || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_DEGRADE)) {
      this.desiredWorkers = 1;
      logger.warn('decode worker pool degraded to one worker', {
        workerId,
        reason: code === 'ENOMEM' ? 'ENOMEM' : 'consecutive-failures',
        consecutiveFailures: this.consecutiveFailures,
      });
      this.stopExtraIdleWorkers();
    }
    this.refreshHealthStatus();
  }

  private scheduleRespawn(): void {
    if (this.destroyed || this.respawnTimer) return;
    const index = Math.min(Math.max(this.consecutiveFailures - 1, 0), RESPAWN_BACKOFF_MS.length - 1);
    const delayMs = RESPAWN_BACKOFF_MS[index];
    logger.warn('decode worker respawn scheduled', {
      delayMs,
      consecutiveFailures: this.consecutiveFailures,
      desiredWorkers: this.desiredWorkers,
      lastFailure: this.lastFailure,
    });
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.ensureWorkerCount();
      this.dispatch();
    }, delayMs);
    this.respawnTimer.unref();
    this.refreshHealthStatus();
  }

  private stopExtraIdleWorkers(): void {
    const idleWorkers = [...this.workers.values()]
      .filter((worker) => !worker.activeJob)
      .sort((a, b) => Number(a.ready) - Number(b.ready));
    for (const worker of idleWorkers) {
      if (this.workers.size <= this.desiredWorkers) return;
      void this.stopWorker(worker);
      this.workers.delete(worker.id);
    }
  }

  private async stopWorker(worker: WorkerState): Promise<void> {
    worker.stopping = true;
    clearTimeout(worker.startTimer);
    if (worker.activeJob) {
      clearTimeout(worker.activeJob.timer);
      worker.activeJob.reject(new Error('decode worker stopped before job completed'));
      worker.activeJob = null;
    }

    if (worker.process.killed) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.killWorker(worker);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      worker.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      const sent = worker.process.send?.({ type: 'shutdown' }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.killWorker(worker);
          resolve();
        }
      });
      if (sent === undefined) {
        clearTimeout(timer);
        this.killWorker(worker);
        resolve();
      }
    });
  }

  private killWorker(worker: WorkerState): void {
    try {
      if (!worker.process.killed) {
        worker.process.kill('SIGTERM');
      }
    } catch (error) {
      logger.warn('failed to kill decode worker', { workerId: worker.id, error: (error as Error).message });
    }
  }
}
