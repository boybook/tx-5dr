import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineMode } from '@tx5dr/contracts';
import { PhysicalPttMonitor } from '../PhysicalPttMonitor.js';

function createRadioManager(overrides: Record<string, unknown> = {}) {
  const connection = {
    getPTT: vi.fn().mockResolvedValue(false),
  };
  const radioManager = {
    isConnected: vi.fn().mockReturnValue(true),
    getCurrentConnection: vi.fn().mockReturnValue(connection),
    ...overrides,
  };
  return { radioManager, connection };
}

describe('PhysicalPttMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls and broadcasts physical PTT state in voice mode', async () => {
    const { radioManager, connection } = createRadioManager();
    connection.getPTT.mockResolvedValueOnce(true);
    const emitStatus = vi.fn();
    const monitor = new PhysicalPttMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      isSoftwarePttActive: () => false,
      emitStatus,
    });

    monitor.reevaluate();
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(true));
    monitor.stop();
  });

  it('does not poll outside voice mode', async () => {
    const { radioManager, connection } = createRadioManager();
    const emitStatus = vi.fn();
    const monitor = new PhysicalPttMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'digital',
      isSoftwarePttActive: () => false,
      emitStatus,
    });

    monitor.reevaluate();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.getPTT).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('pauses polling while software PTT is active and performs an immediate read after release', async () => {
    let softwarePttActive = true;
    const { radioManager, connection } = createRadioManager();
    connection.getPTT.mockResolvedValue(true);
    const emitStatus = vi.fn();
    const monitor = new PhysicalPttMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      isSoftwarePttActive: () => softwarePttActive,
      emitStatus,
    });

    monitor.reevaluate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.getPTT).not.toHaveBeenCalled();

    softwarePttActive = false;
    monitor.setSoftwarePttActive(false);
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(true));
    expect(connection.getPTT).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('preserves last state when low-priority polling is skipped as busy', async () => {
    const { radioManager, connection } = createRadioManager();
    connection.getPTT
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('PTT poll skipped because radio I/O is busy'))
      .mockResolvedValueOnce(false);
    const emitStatus = vi.fn();
    const monitor = new PhysicalPttMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice',
      isSoftwarePttActive: () => false,
      emitStatus,
    });

    monitor.reevaluate();
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(true));
    vi.clearAllMocks();

    await vi.advanceTimersByTimeAsync(300);
    expect(connection.getPTT).toHaveBeenCalledTimes(1);
    expect(emitStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(emitStatus).toHaveBeenCalledWith(false));
    monitor.stop();
  });

  it('does not poll unsupported connections', async () => {
    const unsupportedConnection = {};
    const { radioManager } = createRadioManager({
      getCurrentConnection: vi.fn().mockReturnValue(unsupportedConnection),
    });
    const emitStatus = vi.fn();
    const monitor = new PhysicalPttMonitor({
      radioManager: radioManager as any,
      getEngineMode: () => 'voice' as EngineMode,
      isSoftwarePttActive: () => false,
      emitStatus,
    });

    monitor.reevaluate();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(emitStatus).not.toHaveBeenCalled();
    monitor.stop();
  });
});
