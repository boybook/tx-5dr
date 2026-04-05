type RadioIoTaskOptions = {
  sessionId: number;
  critical?: boolean;
  lowPriority?: boolean;
};

export const RADIO_IO_SKIPPED = Symbol('radio-io-skipped');

export class RadioIoQueue {
  private tail: Promise<void> = Promise.resolve();
  private queuedCount = 0;
  private activeCount = 0;
  private criticalCount = 0;

  isCriticalActive(): boolean {
    return this.criticalCount > 0;
  }

  isBusy(): boolean {
    return this.activeCount > 0 || this.queuedCount > 0;
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
    this.queuedCount += 1;
    const previous = this.tail;

    let resolveCurrent!: () => void;
    this.tail = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });

    await previous.catch(() => {});
    this.queuedCount -= 1;
    this.activeCount += 1;
    if (options.critical) {
      this.criticalCount += 1;
    }

    try {
      return await task(options.sessionId);
    } finally {
      if (options.critical) {
        this.criticalCount -= 1;
      }
      this.activeCount -= 1;
      resolveCurrent();
    }
  }
}
