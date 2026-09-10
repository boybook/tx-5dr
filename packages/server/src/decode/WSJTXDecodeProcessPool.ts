import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecodeSessionCancelledError, type DecodeSessionCancelReason, type DecodeRequest, type DecodeResult } from '@tx5dr/core';
import { DecodeSessionEndedSchema } from './decode-worker-protocol.js';
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
const SLOW_NON_AP_DECODE_THRESHOLD_MS = 1_000;
const AP_DECODE_SUPPRESSION_CYCLES = 3;
const NATIVE_TIMING_SAMPLE_LIMIT = 512;
const MAINTENANCE_INTERVAL_MS = 1_000;
const SESSION_IDLE_TIMEOUT_MS = 20_000;
const QUEUE_WAIT_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 20_000;
const DIAGNOSTIC_INTERVAL_MS = 30_000;
const CLOSED_SESSION_LIMIT = 256;
const MODE_SLOT_MS: Record<DecodeRequest['mode'], number> = {
  FT8: 15_000,
  FT4: 7_500,
};

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
  performanceNow?: () => number;
  workerFactory?: (workerId: number, entry: WorkerEntryResolution, env: NodeJS.ProcessEnv) => DecodeWorkerProcess;
}

export interface WorkerEntryResolution {
  entryPath: string;
  execArgv: string[];
  cwd: string;
  mode: 'development' | 'production';
}

export interface DecodeWorkerPoolHealthSnapshot {
  unavailableReason?: 'worker-unavailable' | 'queue-stalled';
  oldestPendingMs?: number;
  noProgressMs?: number;
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

interface DecodeSessionState {
  id: string;
  workerId?: number;
  lastActivityAt: number;
  cancelled?: DecodeSessionCancelReason;
}

interface PendingJob {
  id: number;
  request: DecodeRequest;
  enqueuedAt: number;
  session?: DecodeSessionState;
  settled?: boolean;
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
  session: DecodeSessionState | null;
  ending: { id: number; sessionId: string; startedAt: number; timer: NodeJS.Timeout } | null;
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
  private readonly sessions = new Map<string, DecodeSessionState>();
  private readonly closedSessions = new Map<string, DecodeSessionCancelReason>();
  private readonly maintenanceTimer: NodeJS.Timeout;
  private nextControlId = 1;
  private waitingSince: number | null = null;
  private lastProgressAt: number | null = null;
  private stalledSince: number | null = null;
  private readonly counters = { submitted: 0, dispatched: 0, completed: 0, cancelled: 0, expired: 0, failed: 0 };
  private readonly cancellationReasons: Partial<Record<DecodeSessionCancelReason, number>> = {};
  private readonly readyTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly workerFactory: (workerId: number, entry: WorkerEntryResolution, env: NodeJS.ProcessEnv) => DecodeWorkerProcess;
  private readonly entry: WorkerEntryResolution;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nativeThreads: number;
  private readonly performanceNow: () => number;
  private readonly apDecodeSuppressedUntilMs = new Map<DecodeRequest['mode'], number>();
  private readonly nativeDecodeDurationsMs: number[] = [];
  private lastDiagnosticLogAt = 0;
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
    this.performanceNow = options.performanceNow ?? (() => performance.now());
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
    this.lastDiagnosticLogAt = this.performanceNow();
    this.maintenanceTimer = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  decode(request: DecodeRequest): Promise<DecodeResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('decode worker pool has been destroyed'));
    }
    this.refreshHealthStatus();
    if (this.healthStatus === 'unavailable' && this.getReadyWorkerCount() === 0) {
      return Promise.reject(new Error(`decode worker unavailable: ${this.lastFailure ?? 'no worker is ready'}`));
    }

    const now = this.performanceNow();
    let session: DecodeSessionState | undefined;
    if (request.decodeSessionId && request.decodeStage !== undefined && !request.lateRetry) {
      const reason = this.closedSessions.get(request.decodeSessionId);
      if (reason) return Promise.reject(new DecodeSessionCancelledError(reason));
      session = this.sessions.get(request.decodeSessionId);
      if (!session) {
        session = { id: request.decodeSessionId, lastActivityAt: now };
        this.sessions.set(session.id, session);
      }
      if (session.cancelled) return Promise.reject(new DecodeSessionCancelledError(session.cancelled));
      session.lastActivityAt = now;
    }
    this.counters.submitted++;
    if (this.size() === 0) this.waitingSince = now;
    return new Promise<DecodeResult>((resolve, reject) => {
      this.pending.push({ id: this.nextJobId++, request, session, enqueuedAt: now, resolve, reject });
      this.dispatch();
    });
  }

  cancelSession(sessionId: string, reason: DecodeSessionCancelReason): void {
    if (this.destroyed || this.closedSessions.has(sessionId)) return;
    this.rememberClosed(sessionId, reason);
    this.cancellationReasons[reason] = (this.cancellationReasons[reason] ?? 0) + 1;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = reason;
    const error = new DecodeSessionCancelledError(reason);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].session !== session) continue;
      this.rejectJob(this.pending.splice(i, 1)[0], error);
    }
    const worker = session.workerId === undefined ? undefined : this.workers.get(session.workerId);
    if (worker?.activeJob) this.rejectJob(worker.activeJob, error);
    if (worker) this.endIdleSession(worker);
    else this.releaseSession(session);
    this.dispatch();
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
      unavailableReason: this.getUnavailableReason(),
      oldestPendingMs: this.getOldestPendingMs(),
      noProgressMs: this.getNoProgressMs(),
      maxConcurrency: this.desiredWorkers,
      activeThreads: active,
      readyWorkers: ready,
      workerProcesses: this.workers.size,
      nativeThreadsPerWorker: this.nativeThreads,
      totalNativeDecodeThreads: this.nativeThreads * this.desiredWorkers,
      utilization: this.desiredWorkers > 0 ? active / this.desiredWorkers : 0,
      lastFailure: this.stalledSince === null ? this.lastFailure : 'Decode queue stopped making progress',
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

    const nativeDecodeTiming = this.getNativeDecodeTiming();
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
        lastError: this.stalledSince === null ? this.lastFailure : 'Decode queue stopped making progress',
        unavailableReason: this.getUnavailableReason(),
        oldestPendingMs: this.getOldestPendingMs(),
        noProgressMs: this.getNoProgressMs(),
        lastFailureAt: this.lastFailureAt,
        restartAttempts: this.restartAttempts,
        workerEntry: this.entry.entryPath,
        workerMode: this.entry.mode,
        ...(nativeDecodeTiming ? { nativeDecodeTiming } : {}),
      },
      workers,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    clearInterval(this.maintenanceTimer);
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    while (this.pending.length > 0) {
      this.rejectJob(this.pending.shift()!, new DecodeSessionCancelledError('stopped'));
    }

    await Promise.all([...this.workers.values()].map((worker) => this.stopWorker(worker)));
    this.workers.clear();
    this.sessions.clear();
    this.closedSessions.clear();
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
        this.detachWorker(worker, new Error('Decode worker was killed'));
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
      session: null,
      ending: null,
      stopping: false,
      failureRecorded: false,
      lastTelemetry: null,
      startTimer: setTimeout(() => {
        logger.warn('decode worker startup timed out', { workerId, timeoutMs: this.readyTimeoutMs });
        this.handleWorkerFailure(state, new Error('decode worker startup timed out'));
      }, this.readyTimeoutMs),
    };

    this.workers.set(workerId, state);
    wireOutput(child.stdout, (line) => logger.debug('decode worker stdout', { workerId, line }));
    wireOutput(child.stderr, (line) => logger.warn('decode worker stderr', { workerId, line }));

    child.on('message', (message) => this.handleWorkerMessage(state, message));
    child.once('error', (error) => {
      logger.warn('decode worker process error', { workerId, error: error.message, code: (error as Error & { code?: string }).code });
      this.handleWorkerFailure(state, error);
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
    if (this.destroyed || state.stopping || this.workers.get(state.id) !== state) return;
    if (!message || typeof message !== 'object') return;
    if (!('type' in message)) {
      if (isToolingWatchMessage(message as Record<string, unknown>)) {
        logger.debug('ignored decode worker tooling watch message', { workerId: state.id });
        return;
      }
      logger.warn('decode worker returned unknown message', { workerId: state.id, message });
      return;
    }

    if (message.type === 'session-ended') {
      const parsed = DecodeSessionEndedSchema.safeParse(message);
      if (!parsed.success) {
        this.handleWorkerFailure(state, new Error('Invalid decode session cleanup response'));
        return;
      }
      const ack = parsed.data;
      if (!state.ending || state.ending.id !== ack.id || state.ending.sessionId !== ack.sessionId) return;
      if (ack.error) {
        this.handleWorkerFailure(state, createError(ack.error));
        return;
      }
      clearTimeout(state.ending.timer);
      state.ending = null;
      if (state.session) this.releaseSession(state.session);
      this.dispatch();
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
    if (activeJob.session) activeJob.session.lastActivityAt = this.performanceNow();
    if (activeJob.settled) {
      // Cancellation settles callers immediately but retains native exclusivity
      // until the original response (or its execution timeout) arrives.
      this.endIdleSession(state);
      this.dispatch();
      return;
    }

    if (workerMessage.type === 'result') {
      const completedAt = this.performanceNow();
      const queueWaitMs = activeJob.dispatchedAt - activeJob.enqueuedAt;
      const workerElapsedMs = completedAt - activeJob.dispatchedAt;
      const totalElapsedMs = completedAt - activeJob.enqueuedAt;
      const nativeProcessingTimeMs = workerMessage.result.nativeProcessingTimeMs ?? workerMessage.result.processingTimeMs;
      this.maybeSuppressApDecode(activeJob.request, workerElapsedMs, completedAt);
      logger.debug('decode worker job completed', {
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
        decodeDepth: activeJob.request.decodeDepth,
        decodeStage: activeJob.request.decodeStage,
        lateRetry: activeJob.request.lateRetry,
        decodeStats: workerMessage.result.decodeStats,
        decisionDeadlineMs: activeJob.request.decisionDeadlineMs,
        pendingJobs: this.pending.length,
        activeJobs: this.getActiveJobCount(),
        readyWorkers: this.getReadyWorkerCount(),
        workerProcesses: this.workers.size,
        desiredWorkers: this.desiredWorkers,
        nativeThreadsPerWorker: this.nativeThreads,
      });
      this.recordNativeDecodeDuration(nativeProcessingTimeMs);
      activeJob.settled = true;
      this.counters.completed++;
      this.lastProgressAt = completedAt;
      this.stalledSince = null;
      this.refreshHealthStatus();
      activeJob.resolve({
        ...workerMessage.result,
        queueWaitMs: roundMs(queueWaitMs),
      });
      if (activeJob.request.decodeFinalWindow && activeJob.session) {
        this.rememberClosed(activeJob.session.id, 'completed');
        for (let i = this.pending.length - 1; i >= 0; i--) {
          if (this.pending[i].session === activeJob.session) {
            this.rejectJob(this.pending.splice(i, 1)[0], new DecodeSessionCancelledError('completed'));
          }
        }
        this.releaseSession(activeJob.session);
      }
    } else {
      const failedAt = this.performanceNow();
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
      this.rejectJob(activeJob, createError(workerMessage.error));
      if (activeJob.session) this.cancelSession(activeJob.session.id, 'worker-failed');
    }

    this.dispatch();
  }

  private rememberClosed(id: string, reason: DecodeSessionCancelReason): void {
    this.closedSessions.set(id, reason);
    if (this.closedSessions.size > CLOSED_SESSION_LIMIT) {
      this.closedSessions.delete(this.closedSessions.keys().next().value!);
    }
  }

  private releaseSession(session: DecodeSessionState): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    const worker = session.workerId === undefined ? undefined : this.workers.get(session.workerId);
    if (worker?.session === session) worker.session = null;
  }

  private rejectJob(job: PendingJob, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (error instanceof DecodeSessionCancelledError) {
      this.counters.cancelled++;
      if (error.reason === 'queue-expired' || error.reason === 'session-expired') this.counters.expired++;
    } else this.counters.failed++;
    job.reject(error);
  }

  private endIdleSession(worker: WorkerState): void {
    const session = worker.session;
    if (!session?.cancelled || worker.activeJob || worker.ending || worker.stopping) return;
    const id = this.nextControlId++;
    const timer = setTimeout(() => {
      this.handleWorkerFailure(worker, new Error('Decode session cleanup timed out'));
    }, this.readyTimeoutMs);
    worker.ending = { id, sessionId: session.id, startedAt: this.performanceNow(), timer };
    try {
      if (!worker.process.send) throw new Error('Decode worker IPC is unavailable');
      worker.process.send({ type: 'end-session', id, sessionId: session.id }, error => {
        if (error) this.handleWorkerFailure(worker, error);
      });
    } catch (error) {
      this.handleWorkerFailure(worker, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatch(): void {
    if (this.destroyed) return;
    this.ensureWorkerCount();
    if (this.workers.size > this.desiredWorkers) this.stopExtraIdleWorkers();
    const now = this.performanceNow();
    const expiredSessions = new Set(this.pending
      .filter(job => job.session && now - job.enqueuedAt >= QUEUE_WAIT_TIMEOUT_MS)
      .map(job => job.session));
    for (const worker of this.workers.values()) {
      if (this.pending.length === 0) break;
      if (!worker.ready || worker.activeJob || worker.ending || worker.stopping) continue;
      const jobIndex = this.pending.findIndex(job => !job.session?.cancelled
        && !expiredSessions.has(job.session)
        && this.performanceNow() - job.enqueuedAt < QUEUE_WAIT_TIMEOUT_MS && (
        job.session ? worker.session === job.session || (job.session.workerId === undefined && !worker.session) : !worker.session
      ));
      if (jobIndex < 0) continue;
      const [job] = this.pending.splice(jobIndex, 1);
      if (job.session) {
        job.session.workerId = worker.id;
        worker.session = job.session;
      }
      const dispatchedAt = this.performanceNow();
      this.lastProgressAt = dispatchedAt;
      this.counters.dispatched++;
      const dispatchRequest = this.applyApDecodeSuppression(job.request, dispatchedAt);
      const timer = setTimeout(() => {
        if (worker.activeJob?.id !== job.id) return;
        logger.warn('decode job timed out', { workerId: worker.id, jobId: job.id, timeoutMs: this.jobTimeoutMs });
        this.handleWorkerFailure(worker, new Error('decode job timed out'));
      }, this.jobTimeoutMs);
      worker.activeJob = { ...job, request: dispatchRequest, timer, dispatchedAt };
      try {
        if (!worker.process.send) throw new Error('Decode worker IPC is unavailable');
        const ok = worker.process.send({ type: 'decode', id: job.id, request: dispatchRequest }, error => {
          if (error && worker.activeJob?.id === job.id) this.handleWorkerFailure(worker, error);
        });
        if (!ok) logger.debug('decode worker IPC backpressure', { workerId: worker.id, jobId: job.id });
      } catch (error) {
        this.handleWorkerFailure(worker, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.size() === 0) this.waitingSince = null;
    this.refreshHealthStatus();
  }

  private getOldestPendingMs(): number {
    return this.pending.length ? Math.max(0, this.performanceNow() - this.pending[0].enqueuedAt) : 0;
  }

  private getNoProgressMs(): number {
    if (this.waitingSince === null) return 0;
    return Math.max(0, this.performanceNow() - Math.max(this.waitingSince, this.lastProgressAt ?? this.waitingSince));
  }

  private getUnavailableReason(): DecodeWorkerPoolHealthSnapshot['unavailableReason'] {
    if (this.stalledSince !== null) return 'queue-stalled';
    return this.healthStatus === 'unavailable' ? 'worker-unavailable' : undefined;
  }

  private maintain(): void {
    if (this.destroyed) return;
    const now = this.performanceNow();
    for (const worker of this.workers.values()) {
      if (worker.session && !worker.activeJob && !worker.ending
        && now - worker.session.lastActivityAt >= SESSION_IDLE_TIMEOUT_MS) {
        this.cancelSession(worker.session.id, 'session-expired');
      }
    }
    this.dispatch();
    // A prompt cleanup acknowledgement can restore dispatch on the next IPC
    // turn. Let its separate bounded timeout handle failure before alarming.
    const cleanupInProgress = [...this.workers.values()].some(worker => worker.ending
      && now - worker.ending.startedAt < this.readyTimeoutMs);
    if (this.pending.length && this.getNoProgressMs() >= STALL_TIMEOUT_MS
      && !cleanupInProgress && this.stalledSince === null) {
      this.stalledSince = now;
      this.refreshHealthStatus();
      logger.warn('decode queue stopped making progress', this.buildHealthSnapshot());
    }
    // Check before expiring jobs so trimming a stalled queue cannot hide its
    // unavailable state. Only an actual completed decode clears that state.
    for (const job of [...this.pending]) {
      if (job.settled || !this.pending.includes(job) || now - job.enqueuedAt < QUEUE_WAIT_TIMEOUT_MS) continue;
      if (job.session) this.cancelSession(job.session.id, 'queue-expired');
      else {
        const index = this.pending.indexOf(job);
        if (index >= 0) {
          this.pending.splice(index, 1);
          this.rejectJob(job, new DecodeSessionCancelledError('queue-expired'));
        }
      }
    }
    this.dispatch();
    if (now - this.lastDiagnosticLogAt >= DIAGNOSTIC_INTERVAL_MS) {
      logger.info('decode worker pool diagnostic snapshot', {
        ...this.buildHealthSnapshot(),
        intervalMs: roundMs(now - this.lastDiagnosticLogAt),
        counts: { ...this.counters },
        cancellations: { ...this.cancellationReasons },
        lastProgressAgeMs: this.lastProgressAt === null ? null : roundMs(now - this.lastProgressAt),
        workers: [...this.workers.values()].map(worker => ({
          workerId: worker.id, ready: worker.ready,
          sessionId: worker.session?.id,
          sessionIdleMs: worker.session ? roundMs(now - worker.session.lastActivityAt) : undefined,
          cleanupPending: Boolean(worker.ending),
          activeJob: worker.activeJob ? {
            jobId: worker.activeJob.id, slotId: worker.activeJob.request.slotId,
            windowIdx: worker.activeJob.request.windowIdx, decodeStage: worker.activeJob.request.decodeStage,
            elapsedMs: roundMs(now - worker.activeJob.dispatchedAt), cancelled: Boolean(worker.activeJob.settled),
          } : null,
        })),
      });
      this.lastDiagnosticLogAt = now;
      for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) this.counters[key] = 0;
      for (const key of Object.keys(this.cancellationReasons) as DecodeSessionCancelReason[]) delete this.cancellationReasons[key];
    }
  }

  private applyApDecodeSuppression(request: DecodeRequest, nowMs: number): DecodeRequest {
    if (!request.apContext) {
      return request;
    }

    const suppressedUntilMs = this.apDecodeSuppressedUntilMs.get(request.mode) ?? 0;
    if (nowMs >= suppressedUntilMs) {
      return request;
    }

    const { apContext: suppressedApContext, ...requestWithoutApContext } = request;
    logger.info('AP decode suppressed after slow non-AP decode', {
      slotId: request.slotId,
      windowIdx: request.windowIdx,
      mode: request.mode,
      apOperatorId: suppressedApContext.operatorId,
      apCurrentSlot: suppressedApContext.currentSlot,
      apQsoProgress: suppressedApContext.qsoProgress,
      suppressedUntilMs: roundMs(suppressedUntilMs),
      remainingMs: roundMs(suppressedUntilMs - nowMs),
    });
    return requestWithoutApContext;
  }

  private maybeSuppressApDecode(request: DecodeRequest, workerElapsedMs: number, completedAtMs: number): void {
    if (request.apContext || workerElapsedMs <= SLOW_NON_AP_DECODE_THRESHOLD_MS) {
      return;
    }

    const suppressionDurationMs = MODE_SLOT_MS[request.mode] * AP_DECODE_SUPPRESSION_CYCLES;
    const suppressedUntilMs = completedAtMs + suppressionDurationMs;
    const previousSuppressedUntilMs = this.apDecodeSuppressedUntilMs.get(request.mode) ?? 0;
    this.apDecodeSuppressedUntilMs.set(request.mode, Math.max(previousSuppressedUntilMs, suppressedUntilMs));
    logger.warn('slow non-AP decode detected; suppressing AP decode', {
      slotId: request.slotId,
      windowIdx: request.windowIdx,
      mode: request.mode,
      workerElapsedMs: roundMs(workerElapsedMs),
      thresholdMs: SLOW_NON_AP_DECODE_THRESHOLD_MS,
      suppressionCycles: AP_DECODE_SUPPRESSION_CYCLES,
      suppressionDurationMs,
      suppressedUntilMs: roundMs(Math.max(previousSuppressedUntilMs, suppressedUntilMs)),
    });
  }

  private getActiveJobCount(): number {
    let active = 0;
    for (const worker of this.workers.values()) {
      if (worker.activeJob) active++;
    }
    return active;
  }

  private recordNativeDecodeDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (this.nativeDecodeDurationsMs.length >= NATIVE_TIMING_SAMPLE_LIMIT) {
      this.nativeDecodeDurationsMs.shift();
    }
    this.nativeDecodeDurationsMs.push(durationMs);
  }

  private getNativeDecodeTiming(): { p50Ms: number; p95Ms: number; sampleCount: number } | undefined {
    if (this.nativeDecodeDurationsMs.length === 0) return undefined;
    const sorted = [...this.nativeDecodeDurationsMs].sort((a, b) => a - b);
    const percentile = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
    return {
      p50Ms: roundMs(percentile(0.5)),
      p95Ms: roundMs(percentile(0.95)),
      sampleCount: sorted.length,
    };
  }

  private getReadyWorkerCount(): number {
    let ready = 0;
    for (const worker of this.workers.values()) {
      if (worker.ready) ready++;
    }
    return ready;
  }

  private resolveHealthStatus(): DecodeWorkerPoolStatus {
    if (this.stalledSince !== null) return 'unavailable';
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
      unavailableReason: this.getUnavailableReason(),
      oldestPendingMs: this.getOldestPendingMs(),
      noProgressMs: this.getNoProgressMs(),
      desiredWorkers: this.desiredWorkers,
      readyWorkers: this.getReadyWorkerCount(),
      workerProcesses: this.workers.size,
      pendingJobs: this.pending.length,
      activeJobs: this.getActiveJobCount(),
      nativeThreadsPerWorker: this.nativeThreads,
      lastFailure: this.stalledSince === null ? this.lastFailure : 'Decode queue stopped making progress',
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
    if (nextStatus === 'unavailable' && this.getReadyWorkerCount() === 0) {
      this.rejectPendingForUnavailable();
    }
    this.emit('healthStatusChanged', this.buildHealthSnapshot(), previousStatus);
  }

  private rejectPendingForUnavailable(): void {
    if (this.pending.length === 0) return;
    const error = new Error(`decode worker unavailable: ${this.lastFailure ?? 'no worker is ready'}`);
    while (this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.rejectJob(job, error);
      if (job.session && job.session.workerId === undefined) this.releaseSession(job.session);
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
      ...(worker.session ? { reservedSessionId: worker.session.id } : {}),
      ...(worker.ending ? { sessionCleanupPending: true } : {}),
      nativeThreads: this.nativeThreads,
      currentJob: activeJob
        ? {
            jobId: activeJob.id,
            slotId: activeJob.request.slotId,
            windowIdx: activeJob.request.windowIdx,
            mode: activeJob.request.mode,
            startedAt: now - (this.performanceNow() - activeJob.dispatchedAt),
            elapsedMs: this.performanceNow() - activeJob.dispatchedAt,
            requestAudioDurationMs: getDecodeRequestAudioDurationMs(activeJob.request),
            ...(activeJob.request.decodeDepth !== undefined ? { decodeDepth: activeJob.request.decodeDepth } : {}),
            ...(activeJob.request.decodeStage !== undefined ? { decodeStage: activeJob.request.decodeStage } : {}),
            ...(activeJob.request.decisionDeadlineMs !== undefined ? { decisionDeadlineMs: activeJob.request.decisionDeadlineMs } : {}),
          }
        : undefined,
    };
  }

  private detachWorker(state: WorkerState, error: Error): void {
    clearTimeout(state.startTimer);
    if (state.ending) clearTimeout(state.ending.timer);
    state.ending = null;
    state.ready = false;
    state.stopping = true;
    if (state.activeJob) {
      clearTimeout(state.activeJob.timer);
      this.rejectJob(state.activeJob, error);
      state.activeJob = null;
    }
    const session = state.session;
    if (session) {
      this.rememberClosed(session.id, 'worker-failed');
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].session === session) {
          this.rejectJob(this.pending.splice(i, 1)[0], new DecodeSessionCancelledError('worker-failed'));
        }
      }
      this.releaseSession(session);
    }
    this.workers.delete(state.id);
  }

  private handleWorkerExit(state: WorkerState, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.workers.get(state.id) !== state) return;
    if (!this.destroyed && !state.stopping) {
      this.handleWorkerFailure(state, new Error(`decode worker exited (code=${code}, signal=${signal})`));
    } else this.detachWorker(state, new DecodeSessionCancelledError('stopped'));
  }

  private handleWorkerFailure(state: WorkerState, error: Error): void {
    if (state.failureRecorded || this.workers.get(state.id) !== state) return;
    state.failureRecorded = true;
    this.detachWorker(state, error);
    this.recordWorkerFailure(state.id, error);
    this.scheduleRespawn();
    this.killWorker(state);
    this.dispatch();
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
      lastFailure: this.stalledSince === null ? this.lastFailure : 'Decode queue stopped making progress',
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
    }
  }

  private async stopWorker(worker: WorkerState): Promise<void> {
    this.detachWorker(worker, new DecodeSessionCancelledError('stopped'));

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
      try {
        const sent = worker.process.send?.({ type: 'shutdown' }, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.killWorker(worker);
          resolve();
        });
        if (sent === undefined) throw new Error('Decode worker IPC is unavailable');
      } catch {
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
