import { describe, expect, it, vi } from 'vitest';
import {
  RADIO_IO_SKIPPED,
  RadioIoQueue,
  type RadioIoQueueCongestionSnapshot,
  type RadioIoQueueLateResultSnapshot,
  type RadioIoQueueTimeoutSnapshot,
} from '../connections/RadioIoQueue.js';

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

  it('emits rate-limited congestion warnings when queued work exceeds the pending threshold', async () => {
    let now = 1_000;
    const warnings: RadioIoQueueCongestionSnapshot[] = [];
    const queue = new RadioIoQueue({
      label: 'test CAT',
      congestionPendingThreshold: 2,
      congestionWarnCooldownMs: 1_000,
      now: () => now,
      onCongestionWarning: (snapshot) => warnings.push(snapshot),
    });
    const releaseActive = createDeferred<void>();

    const active = queue.run({ sessionId: 1, name: 'active' }, async () => {
      await releaseActive.promise;
    });

    await vi.waitFor(() => {
      expect(queue.isBusy()).toBe(true);
    });

    const pendingA = queue.run({ sessionId: 1, name: 'pending-a' }, async () => 'a');
    now += 50;
    const pendingB = queue.run({ sessionId: 1, name: 'pending-b', critical: true }, async () => 'b');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      label: 'test CAT',
      sessionId: 1,
      activeCount: 1,
      activeTask: 'active',
      activeRunMs: 50,
      pendingCount: 2,
      criticalPendingCount: 1,
      normalPendingCount: 1,
      pendingThreshold: 2,
      oldestPendingTask: 'pending-a',
      oldestPendingWaitMs: 50,
      latestTask: 'pending-b',
      latestTaskCritical: true,
    });

    const pendingC = queue.run({ sessionId: 1, name: 'pending-c' }, async () => 'c');
    expect(warnings).toHaveLength(1);

    now += 1_000;
    const pendingD = queue.run({ sessionId: 1, name: 'pending-d' }, async () => 'd');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatchObject({
      pendingCount: 4,
      activeTask: 'active',
      oldestPendingTask: 'pending-a',
      latestTask: 'pending-d',
    });

    releaseActive.resolve(undefined);
    await expect(Promise.all([active, pendingA, pendingB, pendingC, pendingD])).resolves.toEqual([
      undefined,
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('times out a hung active task, warns, and continues with queued work', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const timeoutWarnings: RadioIoQueueTimeoutSnapshot[] = [];
      const queue = new RadioIoQueue({
        label: 'test CAT',
        now: () => now,
        onTaskTimeoutWarning: (snapshot) => timeoutWarnings.push(snapshot),
      });
      const hungTask = createDeferred<string>();

      const first = queue.run(
        { sessionId: 1, name: 'hung-task', id: 'hung', timeoutMs: 5_000, context: { connectionType: 'serial' } },
        async () => hungTask.promise,
      ).catch((error: Error) => error);

      await Promise.resolve();
      const second = queue.run({ sessionId: 1, name: 'next-task' }, async () => 'next');
      now += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      await expect(first).resolves.toMatchObject({
        message: 'hung-task timed out after 5000ms',
      });
      await expect(second).resolves.toBe('next');
      expect(timeoutWarnings).toHaveLength(1);
      expect(timeoutWarnings[0]).toMatchObject({
        label: 'test CAT',
        sessionId: 1,
        task: 'hung-task',
        taskId: 'hung',
        critical: false,
        runMs: 5_000,
        timeoutMs: 5_000,
        pendingCount: 1,
        oldestPendingTask: 'next-task',
        oldestPendingWaitMs: 5_000,
        action: 'skip-and-continue',
        context: { connectionType: 'serial' },
      });
      expect(queue.getSnapshot()).toMatchObject({
        busy: false,
        activeTask: null,
        pendingCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores late results from timed-out tasks without corrupting queue state', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const lateResults: RadioIoQueueLateResultSnapshot[] = [];
      const queue = new RadioIoQueue({
        now: () => now,
        onLateTaskResult: (snapshot) => lateResults.push(snapshot),
      });
      const releaseHungTask = createDeferred<string>();

      const first = queue.run(
        { sessionId: 1, name: 'late-task', timeoutMs: 100 },
        async () => releaseHungTask.promise,
      ).catch((error: Error) => error);
      await Promise.resolve();

      now += 100;
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({
        message: 'late-task timed out after 100ms',
      });

      releaseHungTask.resolve('late-ok');
      now += 25;
      await Promise.resolve();
      await Promise.resolve();

      expect(lateResults).toHaveLength(1);
      expect(lateResults[0]).toMatchObject({
        task: 'late-task',
        outcome: 'resolved',
        runMs: 125,
        timeoutMs: 100,
      });
      await expect(queue.run({ sessionId: 1, name: 'after-late' }, async () => 'ok')).resolves.toBe('ok');
      expect(queue.getSnapshot().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
