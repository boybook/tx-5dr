import { describe, expect, it, vi } from 'vitest';
import { OperatorIntentCoordinator } from '../OperatorIntentCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('OperatorIntentCoordinator', () => {
  it('runs different operators independently', async () => {
    const coordinator = new OperatorIntentCoordinator();
    const a = deferred<string>();
    const results: string[] = [];
    const aRun = coordinator.submit('a', 'slot-auto', async () => {
      results.push('a-start');
      return a.promise;
    });
    const bRun = coordinator.submit('b', 'slot-auto', () => {
      results.push('b');
      return 'b-done';
    });

    await expect(bRun).resolves.toMatchObject({ status: 'completed', value: 'b-done' });
    expect(results).toEqual(['a-start', 'b']);
    a.resolve('a-done');
    await expect(aRun).resolves.toMatchObject({ status: 'completed', value: 'a-done' });
  });

  it('coalesces automatic work and rejects stale completion', async () => {
    const coordinator = new OperatorIntentCoordinator();
    const first = deferred<string>();
    const firstRun = coordinator.submit('a', 'slot-auto', () => first.promise);
    const secondRun = coordinator.submit('a', 'slot-auto', () => 'latest');

    first.resolve('stale');
    await expect(firstRun).resolves.toMatchObject({ status: 'superseded' });
    await expect(secondRun).resolves.toMatchObject({ status: 'completed', value: 'latest' });
  });

  it('lets a manual command revoke an automatic command before commit', async () => {
    const coordinator = new OperatorIntentCoordinator();
    const first = deferred<void>();
    let automaticTokenCurrent = true;
    const automatic = coordinator.submit('a', 'slot-auto', async (token, signal) => {
      await first.promise;
      automaticTokenCurrent = coordinator.isCurrent(token) && !signal.aborted;
    });
    const manual = coordinator.submit('a', 'manual', () => 'manual');

    first.resolve();
    await expect(automatic).resolves.toMatchObject({ status: 'superseded' });
    await expect(manual).resolves.toMatchObject({ status: 'completed', value: 'manual' });
    expect(automaticTokenCurrent).toBe(false);
  });

  it('places assisted queue work below manual and above decode automation', async () => {
    const coordinator = new OperatorIntentCoordinator();
    const first = deferred<void>();
    const late = coordinator.submit('a', 'late-decode', () => first.promise);
    const assisted = coordinator.submit('a', 'assisted-queue', () => 'assisted');

    first.resolve();
    await expect(late).resolves.toMatchObject({ status: 'superseded' });
    await expect(assisted).resolves.toMatchObject({ status: 'completed', value: 'assisted' });

    const held = deferred<void>();
    const activeAssisted = coordinator.submit('a', 'assisted-queue', () => held.promise);
    const queuedLate = coordinator.submit('a', 'late-decode', () => 'late');
    held.resolve();
    await expect(activeAssisted).resolves.toMatchObject({ status: 'completed' });
    await expect(queuedLate).resolves.toMatchObject({ status: 'completed', value: 'late' });
  });

  it('continues after quarantining work that ignores abort', async () => {
    vi.useFakeTimers();
    const onAbortTimeout = vi.fn();
    const coordinator = new OperatorIntentCoordinator({ abortGraceMs: 1_000, onAbortTimeout });
    void coordinator.submit('a', 'slot-auto', () => new Promise(() => {}));
    const manual = coordinator.submit('a', 'manual', () => 'manual');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manual).resolves.toMatchObject({ status: 'completed', value: 'manual' });
    expect(onAbortTimeout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
