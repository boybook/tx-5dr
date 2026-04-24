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
  it('disables polling only for the failing connection and resumes after reconnect', async () => {
    const failingConnection = {
      getDCD: vi.fn().mockRejectedValue(new Error('getDCD unavailable')),
    };
    const recoveredConnection = {
      getDCD: vi.fn().mockResolvedValue(false),
    };
    const radioManager = {
      isConnected: vi.fn().mockReturnValue(true),
      isPTTActive: vi.fn().mockReturnValue(false),
      getCurrentConnection: vi.fn().mockReturnValue(failingConnection),
    };
    const emitStatus = vi.fn();
    const monitor = new SquelchStatusMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      emitStatus,
    });

    monitor.reevaluate();
    await vi.advanceTimersByTimeAsync(900);

    expect(failingConnection.getDCD).toHaveBeenCalledTimes(3);
    expect(emitStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      supported: false,
      source: 'unsupported',
    }));

    vi.clearAllMocks();
    monitor.reevaluate();
    await vi.advanceTimersByTimeAsync(600);
    expect(failingConnection.getDCD).not.toHaveBeenCalled();

    radioManager.getCurrentConnection.mockReturnValue(recoveredConnection);
    monitor.reevaluate();
    await vi.runOnlyPendingTimersAsync();

    expect(recoveredConnection.getDCD).toHaveBeenCalled();
    expect(emitStatus).toHaveBeenCalledWith(expect.objectContaining({
      supported: true,
      open: false,
      muted: true,
      source: 'hamlib-dcd',
    }));
    monitor.stop();
  });

  it('publishes unsupported on disconnect but preserves squelch state while only PTT pauses polling', async () => {
    const { radioManager, connection } = createRadioManager();
    const emitStatus = vi.fn();
    const monitor = new SquelchStatusMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      emitStatus,
    });

    monitor.reevaluate();
    await vi.runOnlyPendingTimersAsync();
    expect(emitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ supported: true }));

    vi.clearAllMocks();
    radioManager.isPTTActive.mockReturnValue(true);
    monitor.reevaluate();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(monitor.getSnapshot()).toMatchObject({ supported: true, open: true });

    vi.clearAllMocks();
    radioManager.isPTTActive.mockReturnValue(false);
    radioManager.isConnected.mockReturnValue(false);
    monitor.reevaluate();
    expect(connection.getDCD).not.toHaveBeenCalled();
    expect(emitStatus).toHaveBeenCalledWith(expect.objectContaining({ supported: false }));
    monitor.stop();
  });

});
