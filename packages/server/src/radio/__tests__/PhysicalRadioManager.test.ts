import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { PhysicalRadioManager } from '../PhysicalRadioManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

type TestRadioActor = {
  send: ReturnType<typeof vi.fn>;
};

type TestRadioConnection = {
  getMode?: ReturnType<typeof vi.fn>;
  setFrequency?: ReturnType<typeof vi.fn>;
  setMode?: ReturnType<typeof vi.fn>;
};

type PhysicalRadioManagerTestAccessor = {
  radioActor: TestRadioActor;
  connection: TestRadioConnection;
  markCoreCapabilityUnsupported: (capability: string, error: Error) => void;
  coreCapabilityStates: Record<string, 'unknown' | 'supported' | 'unsupported'>;
};

function asTestManager(manager: PhysicalRadioManager): PhysicalRadioManagerTestAccessor {
  return manager as unknown as PhysicalRadioManagerTestAccessor;
}

describe('PhysicalRadioManager', () => {
  let manager: PhysicalRadioManager;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new PhysicalRadioManager();
    send = vi.fn();
    asTestManager(manager).radioActor = { send };
  });

  it('does not report recoverable getMode failures as connection health failures', async () => {
    asTestManager(manager).connection = {
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

    asTestManager(manager).connection = { getMode };

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

    asTestManager(manager).connection = { setFrequency };

    await expect(manager.setFrequency(7100000)).resolves.toBe(false);
    await expect(manager.setFrequency(7100000)).resolves.toBe(false);

    expect(setFrequency).toHaveBeenCalledTimes(1);
    expect(manager.getCoreCapabilities().writeFrequency).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('stores diagnostic details for unsupported capabilities and preserves the first failure', async () => {
    const firstCause = new Error('rig_set_freq invalid parameter');
    const secondCause = new Error('another failure');
    const setFrequency = vi.fn()
      .mockRejectedValueOnce(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (setFrequency): invalid parameter',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        cause: firstCause,
        context: { operation: 'setFrequency', optional: true, recoverable: true },
      }))
      .mockRejectedValueOnce(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (setFrequency): protocol error',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        cause: secondCause,
        context: { operation: 'setFrequency', optional: true, recoverable: true },
      }));

    const testManager = asTestManager(manager);
    testManager.connection = { setFrequency };

    await expect(manager.setFrequency(7100000)).resolves.toBe(false);
    testManager.markCoreCapabilityUnsupported('writeFrequency', new Error('manual overwrite should be ignored'));

    const diagnostics = manager.getCoreCapabilityDiagnostics();

    expect(diagnostics.writeFrequency).toMatchObject({
      capability: 'writeFrequency',
      message: 'Optional radio operation unavailable (setFrequency): invalid parameter',
    });
    expect(diagnostics.writeFrequency?.recordedAt).toBeTypeOf('number');
    expect(diagnostics.writeFrequency?.stack).toContain('Optional radio operation unavailable (setFrequency): invalid parameter');
    expect(diagnostics.writeFrequency?.stack).toContain('Caused by: Error: rig_set_freq invalid parameter');
  });

  it('does not report recoverable setMode failures as connection health failures', async () => {
    asTestManager(manager).connection = {
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

    asTestManager(manager).connection = { setMode };

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
    asTestManager(manager).connection = { setMode };

    await expect(manager.setMode('USB', undefined, { intent: 'voice' })).resolves.toBeUndefined();

    expect(setMode).toHaveBeenCalledWith('USB', undefined, { intent: 'voice' });
    expect(manager.getCoreCapabilities().writeRadioMode).toBe(true);
  });

  it('passes nochange bandwidth selectors through to the active connection', async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    asTestManager(manager).connection = { setMode };

    await expect(manager.setMode('USB', 'nochange', { intent: 'digital' })).resolves.toBeUndefined();

    expect(setMode).toHaveBeenCalledWith('USB', 'nochange', { intent: 'digital' });
    expect(manager.getCoreCapabilities().writeRadioMode).toBe(true);
  });

  it('clears diagnostics when a capability becomes supported again', async () => {
    const setMode = vi.fn()
      .mockRejectedValueOnce(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (setMode): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'setMode', optional: true, recoverable: true },
      }))
      .mockResolvedValueOnce(undefined);

    const testManager = asTestManager(manager);
    testManager.connection = { setMode };

    await expect(manager.setMode('USB')).rejects.toThrow(
      'set mode failed: Optional radio operation unavailable (setMode): Feature not available'
    );
    expect(manager.getCoreCapabilityDiagnostics().writeRadioMode).toBeDefined();

    testManager.coreCapabilityStates.writeRadioMode = 'unknown';
    await expect(manager.setMode('USB')).resolves.toBeUndefined();

    expect(manager.getCoreCapabilityDiagnostics().writeRadioMode).toBeUndefined();
  });

  it('still reports real getMode failures to the connection health state machine', async () => {
    asTestManager(manager).connection = {
      getMode: vi.fn().mockRejectedValue(new Error('device disconnected')),
    };

    await expect(manager.getMode()).rejects.toThrow('get mode failed: device disconnected');
    expect(send).toHaveBeenCalledWith({
      type: 'HEALTH_CHECK_FAILED',
      error: expect.any(Error),
    });
  });
});
