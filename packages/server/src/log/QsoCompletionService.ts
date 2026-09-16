import { createHash, randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import type { QSORecord, QSOPersistencePolicy, QsoPersistenceStatus } from '@tx5dr/contracts';
import { QSORecordSchema } from '@tx5dr/contracts';
import { LogbookOperationError } from '@tx5dr/core';
import type { StrategyQSOCompletionEffect } from '@tx5dr/plugin-api';
import { PersistenceCoordinator } from '../utils/persistence/PersistenceCoordinator.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('QsoCompletionService');
const SLOW_AFTER_MS = 5_000;
const DIAGNOSTIC_INTERVAL_MS = 30_000;

export interface QsoCompletionRequest {
  operatorId: string;
  logBookId: string;
  qsoRecord: QSORecord;
  qsoLifecycleId?: string;
  qsoLifecycleEpoch?: number;
  qsoRuntimeGeneration?: number;
  streamId?: string;
  persistencePolicy?: QSOPersistencePolicy;
  destination?: StrategyQSOCompletionEffect['destination'];
  sourcePluginName?: string;
  metadata?: Record<string, unknown>;
  stationCallsign?: string;
  baseFrequency?: number;
  enrichment?: { grid?: string; reportSent?: number; reportReceived?: number };
}

export interface UnsavedQsoAttempt extends QsoCompletionRequest {
  attemptId: string;
  createdAt: number;
}

export type QsoCompletionState = 'queued' | 'saving' | 'committed' | 'failed' | 'uncertain' | 'discarded';

export interface QsoCompletionWrite {
  readonly request: QsoCompletionRequest;
  prepare(factory: () => Promise<QSORecord>): Promise<QSORecord>;
}

interface Task {
  key: string;
  attemptId: string;
  fingerprint: string;
  operatorId: string;
  logBookId: string;
  generation?: number;
  attemptNumber: number;
  state: QsoCompletionState;
  request?: QsoCompletionRequest;
  prepared?: QSORecord;
  promise?: Promise<QSORecord>;
  persistedRecordId?: string;
  error?: unknown;
  createdAt: number;
  startedAt: number;
  waitingSince: number;
  slow: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retired?: boolean;
}

interface QsoCompletionServiceDeps {
  write: (task: QsoCompletionWrite) => Promise<{ record: QSORecord; afterCommit?: () => Promise<void> }>;
  readCommitted: (logBookId: string, recordId: string) => Promise<QSORecord | null>;
  onFailed: (attempt: UnsavedQsoAttempt, error: unknown) => void;
  onCommitted?: (request: QsoCompletionRequest, recovered: boolean) => void;
  onChanged?: (operatorId: string) => void;
  persistence?: PersistenceCoordinator;
}

/** Owns accepted QSO writes independently of strategy execution and radio lifetime. */
export class QsoCompletionService {
  private readonly tasks = new Map<string, Task>();
  private readonly liveByOperator = new Map<string, Set<Task>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly postCommit = new Set<Promise<void>>();
  private accepting = true;
  private readonly persistence: PersistenceCoordinator;

  constructor(private readonly deps: QsoCompletionServiceDeps) {
    this.persistence = deps.persistence ?? PersistenceCoordinator.getInstance();
  }

  submit(input: QsoCompletionRequest): Promise<QSORecord> {
    try {
      const request = structuredClone({ ...input, qsoRecord: QSORecordSchema.parse(input.qsoRecord) });
      const key = JSON.stringify([
        request.operatorId, request.sourcePluginName ?? '', request.qsoRuntimeGeneration ?? null,
        request.streamId ?? 'default', request.qsoLifecycleEpoch ?? null, request.qsoRecord.id,
      ]);
      // Admission-time Host observations are frozen by the first submission;
      // re-delivery of the same effect must not rebind it after a station edit.
      const { logBookId: _book, stationCallsign: _station, baseFrequency: _frequency, enrichment: _enrichment, ...effect } = request;
      const fingerprint = createHash('sha256').update(serialize(effect)).digest('hex');
      const existing = this.tasks.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'Conflicting payload for an accepted QSO completion');
        }
        if (existing.promise) return existing.promise;
        if (existing.state === 'committed') return this.readCommitted(existing);
        throw existing.error ?? new LogbookOperationError('LOGBOOK_MAINTENANCE', 'QSO completion requires explicit recovery');
      }
      if (!this.accepting) throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'QSO completion admission is closed');
      const admission = this.persistence.acceptLogbookWrite(request.logBookId);
      const task: Task = {
        key, fingerprint, request, operatorId: request.operatorId, logBookId: request.logBookId,
        generation: request.qsoRuntimeGeneration, attemptId: randomUUID(), attemptNumber: 0, state: 'queued',
        createdAt: Date.now(), startedAt: performance.now(), waitingSince: Date.now(), slow: false,
      };
      this.tasks.set(key, task);
      const live = this.liveByOperator.get(task.operatorId) ?? new Set<Task>();
      live.add(task);
      this.liveByOperator.set(task.operatorId, live);
      return this.start(task, admission);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private start(task: Task, admission: ReturnType<PersistenceCoordinator['acceptLogbookWrite']>): Promise<QSORecord> {
    task.state = 'queued';
    task.attemptNumber += 1;
    task.startedAt = performance.now();
    task.waitingSince = Date.now();
    task.slow = false;
    this.watch(task);
    const previous = this.tails.get(task.operatorId) ?? Promise.resolve();
    const promise = previous.then(async () => {
      const request = task.request!;
      if (task.attemptNumber === 1
          && this.unresolved(task.operatorId).some(attempt => attempt.attemptId !== task.attemptId)) {
        throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'Resolve the existing unsaved QSO before recording another contact');
      }
      task.state = 'saving';
      this.changed(task);
      return admission.run(() => this.deps.write({
        request: structuredClone(request),
        prepare: async (factory) => {
          if (!task.prepared) task.prepared = structuredClone(await factory());
          return structuredClone(task.prepared);
        },
      }));
    }).then(({ record, afterCommit }) => {
      if (!record) throw new Error('Logbook provider did not return a durably committed QSO');
      task.state = 'committed';
      this.removeLive(task);
      task.persistedRecordId = record.id;
      task.error = undefined;
      this.stopWatch(task);
      admission.release();
      const request = task.request!;
      this.observe(() => this.deps.onCommitted?.(structuredClone(request), task.attemptNumber > 1));
      this.changed(task);
      const notification = Promise.resolve().then(afterCommit).catch((error) => {
        logger.warn('Post-commit QSO notification failed', { error: String(error) });
      }).then(() => {
        task.request = undefined;
        task.prepared = undefined;
        task.promise = undefined;
        this.postCommit.delete(notification);
        if (task.retired) this.tasks.delete(task.key);
      });
      this.postCommit.add(notification);
      return structuredClone(record);
    }).catch((error: unknown) => {
      // Notification failures are handled separately and cannot reach this path.
      if (task.state === 'committed') throw error;
      task.state = (error as { code?: string })?.code === 'LOGBOOK_WRITE_STATE_UNCERTAIN' ? 'uncertain' : 'failed';
      task.error = error;
      this.stopWatch(task);
      admission.release();
      task.promise = undefined;
      this.observe(() => this.deps.onFailed(this.asAttempt(task), error));
      this.changed(task);
      throw error;
    });
    task.promise = promise;
    const tail = promise.then(() => undefined, () => undefined);
    this.tails.set(task.operatorId, tail);
    void tail.then(() => {
      if (this.tails.get(task.operatorId) === tail) this.tails.delete(task.operatorId);
    });
    this.changed(task);
    return promise;
  }

  private async readCommitted(task: Task): Promise<QSORecord> {
    const record = await this.deps.readCommitted(task.logBookId, task.persistedRecordId!);
    if (!record) throw new LogbookOperationError('LOGBOOK_UNAVAILABLE', 'The previously committed QSO is no longer available');
    return record;
  }

  unresolved(operatorId?: string): UnsavedQsoAttempt[] {
    return this.liveTasks(operatorId)
      .filter(task => (task.state === 'failed' || task.state === 'uncertain')
        && (!operatorId || task.operatorId === operatorId))
      .map(task => this.asAttempt(task));
  }

  requireAttempt(logBookId: string, attemptId: string, operatorIds?: ReadonlySet<string>): UnsavedQsoAttempt {
    const task = [...this.tasks.values()].find(candidate => candidate.attemptId === attemptId);
    if (!task?.request || task.logBookId !== logBookId
        || (operatorIds && !operatorIds.has(task.operatorId))
        || !['failed', 'uncertain', 'queued', 'saving'].includes(task.state)) {
      throw new LogbookOperationError('LOGBOOK_UNSAVED_QSO_NOT_FOUND', 'The unsaved QSO no longer exists');
    }
    return this.asAttempt(task);
  }

  retry(logBookId: string, attemptId: string, operatorIds?: ReadonlySet<string>): Promise<QSORecord> {
    try {
      this.requireAttempt(logBookId, attemptId, operatorIds);
      const task = [...this.tasks.values()].find(candidate => candidate.attemptId === attemptId)!;
      if (task.promise) return task.promise;
      if (task.state !== 'failed') throw new LogbookOperationError('LOGBOOK_WRITE_STATE_UNCERTAIN', 'Verify the logbook before retrying an uncertain write');
      if (!this.accepting) throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'QSO completion admission is closed');
      return this.start(task, this.persistence.acceptLogbookWrite(task.logBookId));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  discard(logBookId: string, attemptId: string, operatorIds?: ReadonlySet<string>): void {
    this.requireAttempt(logBookId, attemptId, operatorIds);
    const task = [...this.tasks.values()].find(candidate => candidate.attemptId === attemptId)!;
    if (task.state !== 'failed') throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'An active or uncertain QSO write cannot be discarded');
    task.state = 'discarded';
    this.removeLive(task);
    task.request = undefined;
    task.prepared = undefined;
    task.error = new LogbookOperationError('LOGBOOK_MAINTENANCE', 'The QSO completion was explicitly discarded');
    this.changed(task);
  }

  status(operatorId: string): QsoPersistenceStatus {
    const tasks = this.liveTasks(operatorId);
    const pending = tasks.filter(task => task.state === 'queued' || task.state === 'saving');
    const unsaved = tasks.filter(task => task.state === 'failed' || task.state === 'uncertain');
    return {
      state: unsaved.some(task => task.state === 'uncertain') ? 'uncertain'
        : unsaved.length ? 'failed' : pending.some(task => task.slow) ? 'slow'
          : pending.length ? 'saving' : 'idle',
      pendingCount: pending.length,
      unsavedCount: unsaved.length,
      ...(pending.length ? { oldestStartedAt: Math.min(...pending.map(task => task.waitingSince)) } : {}),
    };
  }

  assertLogbookRemovable(logBookId: string): void {
    if (this.liveTasks().some(task => task.logBookId === logBookId
        && ['queued', 'saving', 'failed', 'uncertain'].includes(task.state))) {
      throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'Resolve accepted QSO writes before removing this logbook');
    }
  }

  retire(operatorId: string, generation?: number): void {
    for (const task of this.tasks.values()) {
      if (task.operatorId !== operatorId || (generation !== undefined && task.generation !== generation)) continue;
      task.retired = true;
      if (task.state === 'discarded' || (task.state === 'committed' && !task.request)) this.tasks.delete(task.key);
    }
  }

  stopAccepting(): void { this.accepting = false; }

  async flushNotifications(): Promise<void> { await Promise.all(this.postCommit); }

  async drain(deadlineMs = 30_000): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (this.tails.size || this.postCommit.size) {
            await Promise.all([...this.tails.values(), ...this.postCommit]);
          }
          if (this.unresolved().length) throw new LogbookOperationError('LOGBOOK_MAINTENANCE', 'Unresolved QSO writes remain at shutdown');
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('QSO completion drain exceeded shutdown deadline')), Math.max(1, deadlineMs));
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private asAttempt(task: Task): UnsavedQsoAttempt {
    return structuredClone({
      ...task.request!, qsoRecord: task.prepared ?? task.request!.qsoRecord,
      attemptId: task.attemptId, createdAt: task.createdAt,
    });
  }

  private liveTasks(operatorId?: string): Task[] {
    return operatorId ? [...(this.liveByOperator.get(operatorId) ?? [])]
      : [...this.liveByOperator.values()].flatMap(tasks => [...tasks]);
  }

  private removeLive(task: Task): void {
    const live = this.liveByOperator.get(task.operatorId);
    live?.delete(task);
    if (!live?.size) this.liveByOperator.delete(task.operatorId);
  }

  private watch(task: Task): void {
    task.timer = setTimeout(() => {
      task.slow = true;
      this.changed(task);
      const report = () => logger.warn('QSO persistence remains pending', {
        state: task.state, elapsedMs: Math.round(performance.now() - task.startedAt),
      });
      report();
      task.timer = setInterval(report, DIAGNOSTIC_INTERVAL_MS);
      task.timer.unref?.();
    }, SLOW_AFTER_MS);
    task.timer.unref?.();
  }

  private stopWatch(task: Task): void {
    if (task.timer) clearTimeout(task.timer);
    task.timer = undefined;
    task.slow = false;
  }

  private changed(task: Task): void { this.observe(() => this.deps.onChanged?.(task.operatorId)); }
  private observe(callback: () => void): void {
    try { callback(); } catch (error) { logger.warn('QSO completion observer failed', { error: String(error) }); }
  }
}
