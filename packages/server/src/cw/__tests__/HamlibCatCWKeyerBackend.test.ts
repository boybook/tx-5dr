import { describe, expect, it, vi, afterEach } from 'vitest';
import { HamlibConnection } from '../../radio/connections/HamlibConnection.js';
import { HamlibCatCWKeyerBackend } from '../HamlibCatCWKeyerBackend.js';
import type { CWBackendPlaybackSignal } from '../CWKeyerBackend.js';

function createBackend() {
  const connection = new HamlibConnection();
  const sendCWMessage = vi.fn().mockResolvedValue(undefined);
  const waitCWMessage = vi.fn().mockResolvedValue(undefined);
  const stopCWMessage = vi.fn().mockResolvedValue(undefined);

  Object.assign(connection, {
    supportsCWMessageKeyer: () => true,
    sendCWMessage,
    waitCWMessage,
    stopCWMessage,
  });

  const backend = new HamlibCatCWKeyerBackend(() => ({
    getActiveConnection: () => connection,
  }) as any);

  return { backend, sendCWMessage, waitCWMessage, stopCWMessage };
}

function createSignal(): CWBackendPlaybackSignal {
  let stopped = false;
  return {
    isStopped: () => stopped,
    wait: vi.fn(async (ms: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return !stopped;
    }),
    onKeyDown: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HamlibCatCWKeyerBackend', () => {
  it('keeps playback pending for the estimated CW duration and does not wait on Hamlib waitMorse', async () => {
    vi.useFakeTimers();
    const { backend, sendCWMessage, waitCWMessage } = createBackend();
    const signal = createSignal();
    let settled = false;

    const playback = backend.sendText('EE', 20, signal).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sendCWMessage).toHaveBeenCalledWith('EE', 20);
    expect(waitCWMessage).not.toHaveBeenCalled();
    expect(signal.wait).toHaveBeenCalledWith(400);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await playback;
    expect(settled).toBe(true);
  });

  it('applies a small minimum status duration for very short messages', async () => {
    vi.useFakeTimers();
    const { backend } = createBackend();
    const signal = createSignal();

    const playback = backend.sendText('E', 60, signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(signal.wait).toHaveBeenCalledWith(250);
    await vi.advanceTimersByTimeAsync(250);
    await playback;
  });

  it('uses stopMorse only for explicit stopActive', async () => {
    const { backend, stopCWMessage } = createBackend();

    await backend.stopActive();

    expect(stopCWMessage).toHaveBeenCalledTimes(1);
  });
});
