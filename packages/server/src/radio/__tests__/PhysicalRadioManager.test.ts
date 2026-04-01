import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hamlib', () => ({
  HamLib: class MockHamLib {},
}));

vi.mock('hamlib/spectrum', () => ({
  SpectrumController: class MockSpectrumController {},
}));

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { PhysicalRadioManager } from '../PhysicalRadioManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

describe('PhysicalRadioManager', () => {
  let manager: PhysicalRadioManager;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new PhysicalRadioManager();
    send = vi.fn();
    (manager as any).radioActor = { send };
  });

  it('does not report recoverable getMode failures as connection health failures', async () => {
    (manager as any).connection = {
      getMode: vi.fn().mockRejectedValue(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (getMode): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'getMode', optional: true, recoverable: true },
      })),
    };

    await expect(manager.getMode()).rejects.toThrow(
      'get mode failed: Optional radio operation unavailable (getMode): Feature not available'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('marks read radio mode unsupported and short-circuits repeated reads', async () => {
    const getMode = vi.fn().mockRejectedValue(new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Optional radio operation unavailable (getMode): Feature not available',
      userMessage: 'Radio operation is not supported by this model',
      severity: RadioErrorSeverity.WARNING,
      context: { operation: 'getMode', optional: true, recoverable: true },
    }));

    (manager as any).connection = { getMode };

    await expect(manager.getMode()).rejects.toThrow(
      'get mode failed: Optional radio operation unavailable (getMode): Feature not available'
    );
    await expect(manager.getMode()).rejects.toThrow(
      'get mode failed: radio mode read not supported'
    );

    expect(getMode).toHaveBeenCalledTimes(1);
    expect(manager.getCoreCapabilities().readRadioMode).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks write frequency unsupported and short-circuits repeated writes', async () => {
    const setFrequency = vi.fn().mockRejectedValue(new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Optional radio operation unavailable (setFrequency): Feature not available',
      userMessage: 'Radio operation is not supported by this model',
      severity: RadioErrorSeverity.WARNING,
      context: { operation: 'setFrequency', optional: true, recoverable: true },
    }));

    (manager as any).connection = { setFrequency };

    await expect(manager.setFrequency(7100000)).resolves.toBe(false);
    await expect(manager.setFrequency(7100000)).resolves.toBe(false);

    expect(setFrequency).toHaveBeenCalledTimes(1);
    expect(manager.getCoreCapabilities().writeFrequency).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report recoverable setMode failures as connection health failures', async () => {
    (manager as any).connection = {
      setMode: vi.fn().mockRejectedValue(new RadioError({
        code: RadioErrorCode.UNKNOWN_ERROR,
        message: 'Hamlib unknown error (setMode): rig_set_mode returning(-11) Feature not available',
        userMessage: 'Radio operation failed',
        cause: new Error('rig_set_mode returning(-11) Feature not available'),
        context: { operation: 'setMode' },
      })),
    };

    await expect(manager.setMode('USB')).rejects.toThrow(
      'set mode failed: Hamlib unknown error (setMode): rig_set_mode returning(-11) Feature not available'
    );
    expect(manager.getCoreCapabilities().writeRadioMode).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('marks write radio mode unsupported and short-circuits repeated writes', async () => {
    const setMode = vi.fn().mockRejectedValue(new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: 'Optional radio operation unavailable (setMode): Feature not available',
      userMessage: 'Radio operation is not supported by this model',
      severity: RadioErrorSeverity.WARNING,
      context: { operation: 'setMode', optional: true, recoverable: true },
    }));

    (manager as any).connection = { setMode };

    await expect(manager.setMode('USB')).rejects.toThrow(
      'set mode failed: Optional radio operation unavailable (setMode): Feature not available'
    );
    await expect(manager.setMode('USB')).rejects.toThrow(
      'set mode failed: radio mode control not supported'
    );

    expect(setMode).toHaveBeenCalledTimes(1);
    expect(manager.getCoreCapabilities().writeRadioMode).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('passes mode intent through to the active connection', async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    (manager as any).connection = { setMode };

    await expect(manager.setMode('USB', undefined, { intent: 'voice' })).resolves.toBeUndefined();

    expect(setMode).toHaveBeenCalledWith('USB', undefined, { intent: 'voice' });
    expect(manager.getCoreCapabilities().writeRadioMode).toBe(true);
  });

  it('still reports real getMode failures to the connection health state machine', async () => {
    (manager as any).connection = {
      getMode: vi.fn().mockRejectedValue(new Error('device disconnected')),
    };

    await expect(manager.getMode()).rejects.toThrow('get mode failed: device disconnected');
    expect(send).toHaveBeenCalledWith({
      type: 'HEALTH_CHECK_FAILED',
      error: expect.any(Error),
    });
  });
});
