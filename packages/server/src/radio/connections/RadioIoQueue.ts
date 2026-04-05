type RadioIoTaskOptions = {
  sessionId: number;
  bestEffort?: boolean;
};

export class RadioIoQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(
    options: RadioIoTaskOptions,
    task: (sessionId: number) => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;

    let resolveCurrent!: () => void;
    this.tail = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });

    await previous.catch(() => {});

    try {
      return await task(options.sessionId);
    } finally {
      resolveCurrent();
    }
  }
}
