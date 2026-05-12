export type RadioIoTaskContext = Record<string, unknown>;

export type RadioIoTaskOptions = {
  sessionId: number;
  id?: string;
  name?: string;
  critical?: boolean;
  lowPriority?: boolean;
  context?: RadioIoTaskContext;
};

export const RADIO_IO_SKIPPED = Symbol('radio-io-skipped');

export interface RadioIoQueueCongestionSnapshot {
  label?: string;
  sessionId: number;
  activeCount: number;
  activeTask: string | null;
  activeRunMs: number | null;
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

export interface RadioIoQueueSnapshot {
  label?: string;
  busy: boolean;
  criticalActive: boolean;
  activeCount: number;
  activeTask: string | null;
  activeRunMs: number | null;
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
      const finishTask = () => {
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

      try {
        const result = await queuedTask.task(queuedTask.options.sessionId);
        queuedTask.resolve(result);
      } catch (error) {
        queuedTask.reject(error);
      } finally {
        finishTask();
      }
    })();
  }
}
