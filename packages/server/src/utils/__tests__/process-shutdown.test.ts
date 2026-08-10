import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  awaitWithShutdownDeadline,
  ShutdownDeadlineError,
} from '../process-shutdown.js';

describe('awaitWithShutdownDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a task result before the shutdown deadline', async () => {
    await expect(awaitWithShutdownDeadline(
      'logbook close',
      Promise.resolve('drained'),
      50,
    )).resolves.toBe('drained');
  });

  it('rejects a stalled task at the shutdown deadline', async () => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => undefined);
    const waiting = awaitWithShutdownDeadline('logbook close', stalled, 42_000);
    const assertion = expect(waiting).rejects.toEqual(expect.objectContaining({
      name: 'ShutdownDeadlineError',
      operation: 'logbook close',
      deadlineMs: 42_000,
    }));

    await vi.advanceTimersByTimeAsync(42_000);

    await assertion;
    await expect(waiting).rejects.toBeInstanceOf(ShutdownDeadlineError);
  });
});
