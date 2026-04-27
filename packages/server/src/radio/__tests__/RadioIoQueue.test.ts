import { describe, expect, it, vi } from 'vitest';
import { RADIO_IO_SKIPPED, RadioIoQueue } from '../connections/RadioIoQueue.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RadioIoQueue', () => {
  it('lets critical tasks jump ahead of queued normal tasks without interrupting the active task', async () => {
    const queue = new RadioIoQueue();
    const events: string[] = [];
    const releaseActive = createDeferred<void>();

    const normalA = queue.run({ sessionId: 1 }, async () => {
      events.push('A-start');
      await releaseActive.promise;
      events.push('A-end');
    });

    await vi.waitFor(() => {
      expect(events).toEqual(['A-start']);
    });

    const normalB = queue.run({ sessionId: 1 }, async () => {
      events.push('B');
    });
    const criticalC = queue.run({ sessionId: 1, critical: true }, async () => {
      events.push('C');
    });

    await Promise.resolve();
    expect(events).toEqual(['A-start']);

    releaseActive.resolve(undefined);
    await Promise.all([normalA, normalB, criticalC]);

    expect(events).toEqual(['A-start', 'A-end', 'C', 'B']);
  });

  it('preserves FIFO order between critical tasks', async () => {
    const queue = new RadioIoQueue();
    const events: string[] = [];
    const releaseActive = createDeferred<void>();

    const normalA = queue.run({ sessionId: 1 }, async () => {
      events.push('A-start');
      await releaseActive.promise;
      events.push('A-end');
    });

    await vi.waitFor(() => {
      expect(events).toEqual(['A-start']);
    });

    const normalB = queue.run({ sessionId: 1 }, async () => {
      events.push('B');
    });
    const criticalC1 = queue.run({ sessionId: 1, critical: true }, async () => {
      events.push('C1');
    });
    const criticalC2 = queue.run({ sessionId: 1, critical: true }, async () => {
      events.push('C2');
    });

    releaseActive.resolve(undefined);
    await Promise.all([normalA, normalB, criticalC1, criticalC2]);

    expect(events).toEqual(['A-start', 'A-end', 'C1', 'C2', 'B']);
  });

  it('skips low-priority tasks while regular work is active or queued', async () => {
    const queue = new RadioIoQueue();
    const releaseActive = createDeferred<void>();

    const active = queue.run({ sessionId: 1 }, async () => {
      await releaseActive.promise;
    });

    await vi.waitFor(() => {
      expect(queue.isBusy()).toBe(true);
    });

    await expect(queue.runLowPriority({ sessionId: 1 }, async () => 'meter')).resolves.toBe(RADIO_IO_SKIPPED);

    releaseActive.resolve(undefined);
    await active;
  });

  it('reuses a queued task with the same id and session', async () => {
    const queue = new RadioIoQueue();
    const releaseActive = createDeferred<void>();
    const task = vi.fn().mockResolvedValue('frequency');

    const active = queue.run({ sessionId: 1 }, async () => {
      await releaseActive.promise;
    });

    await vi.waitFor(() => {
      expect(queue.isBusy()).toBe(true);
    });

    const first = queue.run({ sessionId: 1, id: 'getFrequency' }, task);
    const second = queue.run({ sessionId: 1, id: 'getFrequency' }, async () => 'duplicate');

    releaseActive.resolve(undefined);
    await active;

    await expect(Promise.all([first, second])).resolves.toEqual(['frequency', 'frequency']);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('reuses an active task with the same id and session', async () => {
    const queue = new RadioIoQueue();
    const releaseRead = createDeferred<string>();
    const task = vi.fn().mockReturnValue(releaseRead.promise);

    const first = queue.run({ sessionId: 1, id: 'getFrequency' }, task);

    await vi.waitFor(() => {
      expect(task).toHaveBeenCalledTimes(1);
    });

    const second = queue.run({ sessionId: 1, id: 'getFrequency' }, async () => 'duplicate');

    releaseRead.resolve('frequency');
    await expect(Promise.all([first, second])).resolves.toEqual(['frequency', 'frequency']);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe different ids or tasks without ids', async () => {
    const queue = new RadioIoQueue();
    const events: string[] = [];

    await Promise.all([
      queue.run({ sessionId: 1, id: 'A' }, async () => events.push('A')),
      queue.run({ sessionId: 1, id: 'B' }, async () => events.push('B')),
      queue.run({ sessionId: 1 }, async () => events.push('no-id-1')),
      queue.run({ sessionId: 1 }, async () => events.push('no-id-2')),
    ]);

    expect(events).toEqual(['A', 'B', 'no-id-1', 'no-id-2']);
  });

  it('clears dedupe entries after rejection so future calls can retry', async () => {
    const queue = new RadioIoQueue();
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    await expect(queue.run({ sessionId: 1, id: 'getFrequency' }, task)).rejects.toThrow('transient');
    await expect(queue.run({ sessionId: 1, id: 'getFrequency' }, task)).resolves.toBe('ok');

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not interrupt the active task when a critical task is queued', async () => {
    const queue = new RadioIoQueue();
    const events: string[] = [];
    const releaseActive = createDeferred<void>();

    const normalA = queue.run({ sessionId: 1 }, async () => {
      events.push('A-start');
      await releaseActive.promise;
      events.push('A-end');
    });

    await vi.waitFor(() => {
      expect(events).toEqual(['A-start']);
    });

    const criticalB = queue.run({ sessionId: 1, critical: true }, async () => {
      events.push('B');
    });

    await Promise.resolve();
    expect(events).toEqual(['A-start']);

    releaseActive.resolve(undefined);
    await Promise.all([normalA, criticalB]);

    expect(events).toEqual(['A-start', 'A-end', 'B']);
  });
});
