import path from 'node:path';

interface QueueEntry {
  tail: Promise<void>;
  pending: number;
}

/** Serializes mutations across every store instance that targets the same path. */
export class PerPathSerialQueue {
  private readonly entries = new Map<string, QueueEntry>();

  async run<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
    const entry = this.entries.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    this.entries.set(key, entry);
    entry.pending += 1;

    const previous = entry.tail.catch(() => undefined);
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.tail = previous.then(() => completed);

    await previous;
    try {
      return await operation();
    } finally {
      entry.pending -= 1;
      release();
      if (entry.pending === 0) {
        void entry.tail.finally(() => {
          if (this.entries.get(key) === entry && entry.pending === 0) {
            this.entries.delete(key);
          }
        });
      }
    }
  }

  async drain(filePath: string): Promise<void> {
    const entry = this.entries.get(path.resolve(filePath));
    await entry?.tail.catch(() => undefined);
  }
}

export const globalLogbookPathQueue = new PerPathSerialQueue();
