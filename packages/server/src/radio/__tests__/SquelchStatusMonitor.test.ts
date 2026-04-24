import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SquelchStatusMonitor } from '../SquelchStatusMonitor.js';

function createRadioManager(overrides: Record<string, unknown> = {}) {
  const connection = {
    getDCD: vi.fn().mockResolvedValue(true),
  };
  const radioManager = {
    isConnected: vi.fn().mockReturnValue(true),
    isPTTActive: vi.fn().mockReturnValue(false),
    getCurrentConnection: vi.fn().mockReturnValue(connection),
    ...overrides,
  };
  return { radioManager, connection };
}

describe('SquelchStatusMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls and broadcasts DCD state in voice receive mode', async () => {
    const { radioManager, connection } = createRadioManager();
    const emitStatus = vi.fn();
    const monitor = new SquelchStatusMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      emitStatus,
    });

    monitor.reevaluate();
    await vi.runOnlyPendingTimersAsync();

    expect(connection.getDCD).toHaveBeenCalled();
    expect(emitStatus).toHaveBeenCalledWith(expect.objectContaining({
      supported: true,
      open: true,
      muted: false,
      source: 'hamlib-dcd',
    }));
    monitor.stop();
  });

  it('does not poll in digital mode', async () => {
    const { radioManager, connection } = createRadioManager();
    const emitStatus = vi.fn();
    const monitor = new SquelchStatusMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'digital',
      emitStatus,
    });

    monitor.reevaluate();
    await vi.runOnlyPendingTimersAsync();

    expect(connection.getDCD).not.toHaveBeenCalled();
    expect(emitStatus).toHaveBeenCalledWith(expect.objectContaining({ supported: false }));
    monitor.stop();
  });

  it('stops polling during PTT without clearing the last squelch state', async () => {
    const { radioManager, connection } = createRadioManager();
    const emitStatus = vi.fn();
    const monitor = new SquelchStatusMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      emitStatus,
    });

    monitor.reevaluate();
    await vi.runOnlyPendingTimersAsync();
    expect(emitStatus).toHaveBeenCalledWith(expect.objectContaining({
      supported: true,
      open: true,
    }));

    monitor.setPTTActive(true);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(600);

    expect(connection.getDCD).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(monitor.getSnapshot()).toMatchObject({
      supported: true,
      open: true,
      muted: false,
    });
    monitor.stop();
  });
});
