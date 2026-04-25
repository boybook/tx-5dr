type RadioIoTaskOptions = {
  sessionId: number;
  critical?: boolean;
  lowPriority?: boolean;
};

export const RADIO_IO_SKIPPED = Symbol('radio-io-skipped');

type QueuedRadioIoTask<T> = {
  options: RadioIoTaskOptions;
  task: (sessionId: number) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export class RadioIoQueue {
  private queue: QueuedRadioIoTask<unknown>[] = [];
  private activeCount = 0;
  private criticalCount = 0;
  private pumpScheduled = false;

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
    return new Promise<T>((resolve, reject) => {
      const queuedTask: QueuedRadioIoTask<T> = {
        options,
        task,
        resolve,
        reject,
      };

      if (options.critical) {
        const firstNormalIndex = this.queue.findIndex((item) => !item.options.critical);
        if (firstNormalIndex === -1) {
          this.queue.push(queuedTask as QueuedRadioIoTask<unknown>);
        } else {
          this.queue.splice(firstNormalIndex, 0, queuedTask as QueuedRadioIoTask<unknown>);
        }
      } else {
        this.queue.push(queuedTask as QueuedRadioIoTask<unknown>);
      }

      this.schedulePump();
    });
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
        this.activeCount -= 1;
        this.schedulePump();
      }
    })();
  }
}
