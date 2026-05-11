type RadioIoTaskOptions = {
  sessionId: number;
  id?: string;
  name?: string;
  critical?: boolean;
  lowPriority?: boolean;
};

export const RADIO_IO_SKIPPED = Symbol('radio-io-skipped');

export interface RadioIoQueueCongestionSnapshot {
  label?: string;
  sessionId: number;
  activeCount: number;
  pendingCount: number;
  criticalPendingCount: number;
  normalPendingCount: number;
  pendingThreshold: number;
  oldestPendingTask: string;
  oldestPendingWaitMs: number;
  latestTask: string;
  latestTaskCritical: boolean;
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
};

const DEFAULT_CONGESTION_PENDING_THRESHOLD = 5;
const DEFAULT_CONGESTION_WARN_COOLDOWN_MS = 10_000;

export class RadioIoQueue {
  private queue: QueuedRadioIoTask<unknown>[] = [];
  private activeCount = 0;
  private criticalCount = 0;
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
    const oldestPendingTask = this.queue.reduce((oldest, item) =>
      item.enqueuedAt < oldest.enqueuedAt ? item : oldest
    );
    const criticalPendingCount = this.queue.filter((item) => item.options.critical).length;

    try {
      this.options.onCongestionWarning({
        label: this.options.label,
        sessionId: triggerTask.options.sessionId,
        activeCount: this.activeCount,
        pendingCount: this.queue.length,
        criticalPendingCount,
        normalPendingCount: this.queue.length - criticalPendingCount,
        pendingThreshold,
        oldestPendingTask: this.describeTask(oldestPendingTask),
        oldestPendingWaitMs: Math.max(0, now - oldestPendingTask.enqueuedAt),
        latestTask: this.describeTask(triggerTask),
        latestTaskCritical: Boolean(triggerTask.options.critical),
        dedupedTaskCount: this.dedupedTasks.size,
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
    if (queuedTask.options.critical) {
      this.criticalCount += 1;
    }

    void (async () => {
      try {
        const result = await queuedTask.task(queuedTask.options.sessionId);
        queuedTask.resolve(result);
      } catch (error) {
        queuedTask.reject(error);
      } finally {
        if (queuedTask.options.critical) {
          this.criticalCount -= 1;
        }
        if (queuedTask.dedupeKey && this.dedupedTasks.get(queuedTask.dedupeKey) === queuedTask.promise) {
          this.dedupedTasks.delete(queuedTask.dedupeKey);
        }
        this.activeCount -= 1;
        this.schedulePump();
      }
    })();
  }
}
