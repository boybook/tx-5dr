export type RadioIoTaskContext = Record<string, unknown>;

export type RadioIoTaskOptions = {
  sessionId: number;
  id?: string;
  name?: string;
  critical?: boolean;
  lowPriority?: boolean;
  timeoutMs?: number;
  context?: RadioIoTaskContext;
};

export const RADIO_IO_SKIPPED = Symbol('radio-io-skipped');

export interface RadioIoQueueCongestionSnapshot {
  label?: string;
  sessionId: number;
  activeCount: number;
  activeTask: string | null;
  activeRunMs: number | null;
  activeTimeoutMs: number | null;
  pendingCount: number;
  criticalPendingCount: number;
  normalPendingCount: number;
  pendingThreshold: number;
  oldestPendingTask: string | null;
  oldestPendingWaitMs: number | null;
  latestTask: string;
  latestTaskCritical: boolean;
  dedupedTaskCount: number;
  context?: RadioIoTaskContext;
}

export interface RadioIoQueueTimeoutSnapshot {
  label?: string;
  sessionId: number;
  task: string;
  taskId?: string;
  critical: boolean;
  runMs: number;
  timeoutMs: number;
  pendingCount: number;
  oldestPendingTask: string | null;
  oldestPendingWaitMs: number | null;
  action: 'skip-and-continue';
  context?: RadioIoTaskContext;
}

export interface RadioIoQueueLateResultSnapshot {
  label?: string;
  sessionId: number;
  task: string;
  taskId?: string;
  critical: boolean;
  runMs: number;
  timeoutMs: number | null;
  outcome: 'resolved' | 'rejected';
  error?: string;
  context?: RadioIoTaskContext;
}

export interface RadioIoQueueSnapshot {
  label?: string;
  busy: boolean;
  criticalActive: boolean;
  activeCount: number;
  activeTask: string | null;
  activeRunMs: number | null;
  activeTimeoutMs: number | null;
  pendingCount: number;
  criticalPendingCount: number;
  normalPendingCount: number;
  oldestPendingTask: string | null;
  oldestPendingWaitMs: number | null;
  dedupedTaskCount: number;
}

export interface RadioIoQueueOptions {
  label?: string;
  congestionPendingThreshold?: number;
  congestionWarnCooldownMs?: number;
  now?: () => number;
  onCongestionWarning?: (snapshot: RadioIoQueueCongestionSnapshot) => void;
  onTaskTimeoutWarning?: (snapshot: RadioIoQueueTimeoutSnapshot) => void;
  onLateTaskResult?: (snapshot: RadioIoQueueLateResultSnapshot) => void;
}

type QueuedRadioIoTask<T> = {
  options: RadioIoTaskOptions;
  dedupeKey: string | null;
  promise: Promise<T>;
  task: (sessionId: number) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  startedAt: number | null;
};

const DEFAULT_CONGESTION_PENDING_THRESHOLD = 5;
const DEFAULT_CONGESTION_WARN_COOLDOWN_MS = 10_000;

export class RadioIoQueue {
  private queue: QueuedRadioIoTask<unknown>[] = [];
  private activeCount = 0;
  private criticalCount = 0;
  private activeTask: QueuedRadioIoTask<unknown> | null = null;
  private pumpScheduled = false;
  private readonly dedupedTasks = new Map<string, Promise<unknown>>();
  private lastCongestionWarningAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RadioIoQueueOptions = {}) {}

  isCriticalActive(): boolean {
    return this.criticalCount > 0;
  }

  isBusy(): boolean {
    return this.activeCount > 0 || this.queue.length > 0;
  }

  getSnapshot(): RadioIoQueueSnapshot {
    const now = this.now();
    const oldestPendingTask = this.getOldestPendingTask();
    const criticalPendingCount = this.countCriticalPending();

    return {
      label: this.options.label,
      busy: this.isBusy(),
      criticalActive: this.isCriticalActive(),
      activeCount: this.activeCount,
      activeTask: this.activeTask ? this.describeTask(this.activeTask) : null,
      activeRunMs: this.activeTask?.startedAt !== null && this.activeTask?.startedAt !== undefined
        ? Math.max(0, now - this.activeTask.startedAt)
        : null,
      activeTimeoutMs: this.activeTask?.options.timeoutMs ?? null,
      pendingCount: this.queue.length,
      criticalPendingCount,
      normalPendingCount: this.queue.length - criticalPendingCount,
      oldestPendingTask: oldestPendingTask ? this.describeTask(oldestPendingTask) : null,
      oldestPendingWaitMs: oldestPendingTask ? Math.max(0, now - oldestPendingTask.enqueuedAt) : null,
      dedupedTaskCount: this.dedupedTasks.size,
    };
  }

  async runLowPriority<T>(
    options: RadioIoTaskOptions,
    task: (sessionId: number) => Promise<T>,
  ): Promise<T | typeof RADIO_IO_SKIPPED> {
    if (this.isBusy() || this.isCriticalActive()) {
      return RADIO_IO_SKIPPED;
    }

    return this.run(options, task);
  }

  async run<T>(
    options: RadioIoTaskOptions,
    task: (sessionId: number) => Promise<T>,
  ): Promise<T> {
    const dedupeKey = this.getDedupeKey(options);
    if (dedupeKey) {
      const existing = this.dedupedTasks.get(dedupeKey);
      if (existing) {
        return existing as Promise<T>;
      }
    }

    let resolveTask!: (value: T) => void;
    let rejectTask!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const queuedTask: QueuedRadioIoTask<T> = {
      options,
      dedupeKey,
      promise,
      task,
      resolve: resolveTask,
      reject: rejectTask,
      enqueuedAt: this.now(),
      startedAt: null,
    };

    if (dedupeKey) {
      this.dedupedTasks.set(dedupeKey, promise);
    }

    this.enqueue(queuedTask as QueuedRadioIoTask<unknown>);
    this.maybeWarnCongestion(queuedTask as QueuedRadioIoTask<unknown>);
    this.schedulePump();

    return promise;
  }

  private enqueue(queuedTask: QueuedRadioIoTask<unknown>): void {
    if (queuedTask.options.critical) {
      const firstNormalIndex = this.queue.findIndex((item) => !item.options.critical);
      if (firstNormalIndex === -1) {
        this.queue.push(queuedTask);
      } else {
        this.queue.splice(firstNormalIndex, 0, queuedTask);
      }
    } else {
      this.queue.push(queuedTask);
    }
  }

  private getDedupeKey(options: RadioIoTaskOptions): string | null {
    if (!options.id) {
      return null;
    }

    return `${options.sessionId}:${options.id}`;
  }

  private maybeWarnCongestion(triggerTask: QueuedRadioIoTask<unknown>): void {
    if (!this.options.onCongestionWarning) {
      return;
    }

    const pendingThreshold = Math.max(
      1,
      this.options.congestionPendingThreshold ?? DEFAULT_CONGESTION_PENDING_THRESHOLD,
    );
    if (this.queue.length < pendingThreshold) {
      return;
    }

    const now = this.now();
    const cooldownMs = Math.max(
      0,
      this.options.congestionWarnCooldownMs ?? DEFAULT_CONGESTION_WARN_COOLDOWN_MS,
    );
    if (cooldownMs > 0 && now - this.lastCongestionWarningAt < cooldownMs) {
      return;
    }

    this.lastCongestionWarningAt = now;
    const oldestPendingTask = this.getOldestPendingTask();
    const criticalPendingCount = this.countCriticalPending();
    const activeSnapshot = this.getSnapshot();

    try {
      this.options.onCongestionWarning({
        label: this.options.label,
        sessionId: triggerTask.options.sessionId,
        activeCount: this.activeCount,
        activeTask: activeSnapshot.activeTask,
        activeRunMs: activeSnapshot.activeRunMs,
        activeTimeoutMs: activeSnapshot.activeTimeoutMs,
        pendingCount: this.queue.length,
        criticalPendingCount,
        normalPendingCount: this.queue.length - criticalPendingCount,
        pendingThreshold,
        oldestPendingTask: oldestPendingTask ? this.describeTask(oldestPendingTask) : null,
        oldestPendingWaitMs: oldestPendingTask ? Math.max(0, now - oldestPendingTask.enqueuedAt) : null,
        latestTask: this.describeTask(triggerTask),
        latestTaskCritical: Boolean(triggerTask.options.critical),
        dedupedTaskCount: this.dedupedTasks.size,
        context: triggerTask.options.context,
      });
    } catch {
      // Warning hooks must not break radio I/O.
    }
  }

  private describeTask(queuedTask: QueuedRadioIoTask<unknown>): string {
    return queuedTask.options.name ?? queuedTask.options.id ?? 'anonymous';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private getOldestPendingTask(): QueuedRadioIoTask<unknown> | null {
    if (this.queue.length === 0) {
      return null;
    }

    return this.queue.reduce((oldest, item) =>
      item.enqueuedAt < oldest.enqueuedAt ? item : oldest
    );
  }

  private countCriticalPending(): number {
    return this.queue.filter((item) => item.options.critical).length;
  }

  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pumpNext();
    });
  }

  private pumpNext(): void {
    if (this.activeCount > 0) {
      return;
    }

    const queuedTask = this.queue.shift();
    if (!queuedTask) {
      return;
    }

    this.activeCount += 1;
    this.activeTask = queuedTask;
    queuedTask.startedAt = this.now();
    if (queuedTask.options.critical) {
      this.criticalCount += 1;
    }

    void (async () => {
      let settled = false;
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const timeoutMs = queuedTask.options.timeoutMs;

      const finishTask = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (queuedTask.options.critical) {
          this.criticalCount -= 1;
        }
        if (queuedTask.dedupeKey && this.dedupedTasks.get(queuedTask.dedupeKey) === queuedTask.promise) {
          this.dedupedTasks.delete(queuedTask.dedupeKey);
        }
        if (this.activeTask === queuedTask) {
          this.activeTask = null;
        }
        this.activeCount -= 1;
        this.schedulePump();
      };

      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          timedOut = true;
          const snapshot = this.buildTimeoutSnapshot(queuedTask, timeoutMs);
          try {
            this.options.onTaskTimeoutWarning?.(snapshot);
          } catch {
            // Warning hooks must not break radio I/O.
          }
          queuedTask.reject(new Error(`${this.describeTask(queuedTask)} timed out after ${timeoutMs}ms`));
          finishTask();
        }, timeoutMs);
      }

      try {
        const result = await queuedTask.task(queuedTask.options.sessionId);
        if (settled) {
          if (timedOut) {
            this.notifyLateTaskResult(queuedTask, 'resolved');
          }
          return;
        }
        settled = true;
        queuedTask.resolve(result);
      } catch (error) {
        if (settled) {
          if (timedOut) {
            this.notifyLateTaskResult(queuedTask, 'rejected', error);
          }
          return;
        }
        settled = true;
        queuedTask.reject(error);
      } finally {
        if (!timedOut) {
          finishTask();
        }
      }
    })();
  }

  private buildTimeoutSnapshot(
    queuedTask: QueuedRadioIoTask<unknown>,
    timeoutMs: number,
  ): RadioIoQueueTimeoutSnapshot {
    const now = this.now();
    const oldestPendingTask = this.getOldestPendingTask();
    return {
      label: this.options.label,
      sessionId: queuedTask.options.sessionId,
      task: this.describeTask(queuedTask),
      taskId: queuedTask.options.id,
      critical: Boolean(queuedTask.options.critical),
      runMs: queuedTask.startedAt !== null ? Math.max(0, now - queuedTask.startedAt) : timeoutMs,
      timeoutMs,
      pendingCount: this.queue.length,
      oldestPendingTask: oldestPendingTask ? this.describeTask(oldestPendingTask) : null,
      oldestPendingWaitMs: oldestPendingTask ? Math.max(0, now - oldestPendingTask.enqueuedAt) : null,
      action: 'skip-and-continue',
      context: queuedTask.options.context,
    };
  }

  private notifyLateTaskResult(
    queuedTask: QueuedRadioIoTask<unknown>,
    outcome: 'resolved' | 'rejected',
    error?: unknown,
  ): void {
    try {
      this.options.onLateTaskResult?.({
        label: this.options.label,
        sessionId: queuedTask.options.sessionId,
        task: this.describeTask(queuedTask),
        taskId: queuedTask.options.id,
        critical: Boolean(queuedTask.options.critical),
        runMs: queuedTask.startedAt !== null ? Math.max(0, this.now() - queuedTask.startedAt) : 0,
        timeoutMs: queuedTask.options.timeoutMs ?? null,
        outcome,
        error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        context: queuedTask.options.context,
      });
    } catch {
      // Debug hooks must not break radio I/O.
    }
  }
}
