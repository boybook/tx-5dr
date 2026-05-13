import { afterEach, describe, expect, it, vi } from 'vitest';
import { SerialCWKeyerBackend } from '../SerialCWKeyerBackend.js';

function createBackendWithFakeHardware(options: { transitionLatencyMs?: number } = {}) {
  const calls: string[] = [];
  const backend = new SerialCWKeyerBackend();
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  const advance = (ms: number) => {
    now += ms;
  };

  (backend as unknown as { hardware: unknown }).hardware = {
    get isKeyDown() { return false; },
    keyDown: vi.fn().mockImplementation(async () => {
      calls.push('keyDown');
      advance(options.transitionLatencyMs ?? 0);
    }),
    keyUp: vi.fn().mockImplementation(async () => {
      calls.push('keyUp');
      advance(options.transitionLatencyMs ?? 0);
    }),
  };
  return { backend, calls, advance };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SerialCWKeyerBackend', () => {
  it('plays shared CW segments as serial keyDown/keyUp transitions', async () => {
    const { backend, calls, advance } = createBackendWithFakeHardware();
    const signal = {
      isStopped: vi.fn(() => false),
      wait: vi.fn().mockImplementation(async (ms: number) => {
        calls.push(`wait:${ms}`);
        advance(ms);
        return true;
      }),
      onKeyDown: vi.fn(),
    };

    await backend.sendText('EE', 20, signal);

    expect(calls).toEqual([
      'keyDown',
      'wait:60',
      'keyUp',
      'wait:180',
      'keyDown',
      'wait:60',
      'keyUp',
    ]);
    expect(signal.onKeyDown).toHaveBeenCalledTimes(2);
  });

  it('subtracts serial transition latency from subsequent waits to avoid cumulative slowdown', async () => {
    const { backend, calls, advance } = createBackendWithFakeHardware({ transitionLatencyMs: 5 });
    const signal = {
      isStopped: vi.fn(() => false),
      wait: vi.fn().mockImplementation(async (ms: number) => {
        calls.push(`wait:${ms}`);
        advance(ms);
        return true;
      }),
      onKeyDown: vi.fn(),
    };

    await backend.sendText('EE', 20, signal);

    expect(calls).toEqual([
      'keyDown',
      'wait:55',
      'keyUp',
      'wait:175',
      'keyDown',
      'wait:55',
      'keyUp',
    ]);
  });
});
