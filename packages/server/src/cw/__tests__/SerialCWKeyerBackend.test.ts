import { describe, expect, it, vi } from 'vitest';
import { SerialCWKeyerBackend } from '../SerialCWKeyerBackend.js';

function createBackendWithFakeHardware() {
  const calls: string[] = [];
  const backend = new SerialCWKeyerBackend();
  (backend as unknown as { hardware: unknown }).hardware = {
    get isKeyDown() { return false; },
    keyDown: vi.fn().mockImplementation(async () => { calls.push('keyDown'); }),
    keyUp: vi.fn().mockImplementation(async () => { calls.push('keyUp'); }),
  };
  return { backend, calls };
}

describe('SerialCWKeyerBackend', () => {
  it('plays shared CW key events as serial keyDown/keyUp transitions', async () => {
    const { backend, calls } = createBackendWithFakeHardware();
    const signal = {
      isStopped: vi.fn(() => false),
      wait: vi.fn().mockImplementation(async (ms: number) => {
        calls.push(`wait:${ms}`);
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
});
