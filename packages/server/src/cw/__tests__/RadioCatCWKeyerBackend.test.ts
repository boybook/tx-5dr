import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { RadioConnectionState, RadioConnectionType, type IRadioConnection } from '../../radio/connections/IRadioConnection.js';
import { RadioCatCWKeyerBackend } from '../RadioCatCWKeyerBackend.js';
import type { CWBackendPlaybackSignal } from '../CWKeyerBackend.js';

function createConnection(overrides: Record<string, unknown> = {}): IRadioConnection {
  return Object.assign(new EventEmitter(), {
    getType: () => RadioConnectionType.HAMLIB,
    getState: () => RadioConnectionState.CONNECTED,
    isHealthy: () => true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    isCriticalOperationActive: () => false,
    setFrequency: vi.fn(),
    getFrequency: vi.fn(),
    setPTT: vi.fn(),
    setMode: vi.fn(),
    applyOperatingState: vi.fn(),
    getMode: vi.fn(),
    getMeterData: vi.fn(),
    getMeterCapabilities: vi.fn(),
    getAudioSampleRate: vi.fn(),
    sendAudio: vi.fn(),
    testConnection: vi.fn(),
    getConnectionInfo: vi.fn(),
    ...overrides,
  }) as unknown as IRadioConnection;
}

function createBackend(options: { type?: RadioConnectionType; supported?: boolean } = {}) {
  const sendCWMessage = vi.fn().mockResolvedValue(undefined);
  const waitCWMessage = vi.fn().mockResolvedValue(undefined);
  const stopCWMessage = vi.fn().mockResolvedValue(undefined);
  const connection = createConnection({
    getType: () => options.type ?? RadioConnectionType.HAMLIB,
    supportsCWMessageKeyer: () => options.supported ?? true,
    sendCWMessage,
    waitCWMessage,
    stopCWMessage,
  });

  const backend = new RadioCatCWKeyerBackend(() => ({
    getActiveConnection: () => connection,
  }) as any);

  return { backend, connection, sendCWMessage, waitCWMessage, stopCWMessage };
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

describe('RadioCatCWKeyerBackend', () => {
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

  it('supports an ICOM WLAN connection through the same CAT backend', async () => {
    vi.useFakeTimers();
    const { backend, sendCWMessage } = createBackend({ type: RadioConnectionType.ICOM_WLAN });
    const signal = createSignal();

    const playback = backend.sendText('CQ', 20, signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(backend.getAvailability()).toEqual({ available: true, error: null });
    expect(sendCWMessage).toHaveBeenCalledWith('CQ', 20);
    await vi.runAllTimersAsync();
    await playback;
  });

  it('reports unavailable when the active radio lacks CW text sending support', () => {
    const { backend } = createBackend({ supported: false });

    expect(backend.getAvailability()).toMatchObject({
      available: false,
      error: expect.stringContaining('CAT/radio CW text sending support'),
    });
  });
});
