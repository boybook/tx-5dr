import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HamlibConfig } from '@tx5dr/contracts';

vi.mock('icom-wlan-node', () => ({
  IcomControl: class MockIcomControl {},
  AUDIO_RATE: 48000,
}));

import { PhysicalRadioManager } from '../PhysicalRadioManager.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { RadioConnectionFactory } from '../connections/RadioConnectionFactory.js';
import { RadioConnectionType } from '../connections/IRadioConnection.js';

type TestRadioActor = {
  send: ReturnType<typeof vi.fn>;
};

type TestRadioConnection = {
  on?: ReturnType<typeof vi.fn>;
  off?: ReturnType<typeof vi.fn>;
  connect?: ReturnType<typeof vi.fn>;
  disconnect?: ReturnType<typeof vi.fn>;
  isHealthy?: ReturnType<typeof vi.fn>;
  isCriticalOperationActive?: ReturnType<typeof vi.fn>;
  startBackgroundTasks?: ReturnType<typeof vi.fn>;
  getType?: ReturnType<typeof vi.fn>;
  setKnownFrequency?: ReturnType<typeof vi.fn>;
  getTunerCapabilities?: ReturnType<typeof vi.fn>;
  getTunerStatus?: ReturnType<typeof vi.fn>;
  getFrequency?: ReturnType<typeof vi.fn>;
  getMode?: ReturnType<typeof vi.fn>;
  setFrequency?: ReturnType<typeof vi.fn>;
  setPTT?: ReturnType<typeof vi.fn>;
  setTuner?: ReturnType<typeof vi.fn>;
  setMode?: ReturnType<typeof vi.fn>;
  startTuning?: ReturnType<typeof vi.fn>;
  applyOperatingState?: ReturnType<typeof vi.fn>;
};

type PhysicalRadioManagerTestAccessor = {
  radioActor: TestRadioActor | null;
  connection: TestRadioConnection;
  lastKnownFrequency: number | null;
  configManager: {
    getLastEngineMode: ReturnType<typeof vi.fn>;
    getLastSelectedFrequency: ReturnType<typeof vi.fn>;
    getLastVoiceFrequency: ReturnType<typeof vi.fn>;
  };
  capabilityManager: {
    onConnected: ReturnType<typeof vi.fn>;
    onDisconnected: ReturnType<typeof vi.fn>;
    getCapabilitySnapshot: ReturnType<typeof vi.fn>;
    writeCapability: ReturnType<typeof vi.fn>;
    syncTunerStatus: ReturnType<typeof vi.fn>;
    setPTTActive: ReturnType<typeof vi.fn>;
    refreshAll: ReturnType<typeof vi.fn>;
  };
  postConnectSettleMs: number;
  checkFrequencyChange: () => Promise<void>;
  startFrequencyMonitoring: () => void;
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
    vi.restoreAllMocks();
    manager = new PhysicalRadioManager();
    send = vi.fn();
    asTestManager(manager).radioActor = { send };
    asTestManager(manager).postConnectSettleMs = 0;
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


  it('queues a serialized capability refresh after direct frequency writes', async () => {
    const refreshAll = vi.spyOn(asTestManager(manager).capabilityManager, 'refreshAll').mockResolvedValue(undefined);
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.HAMLIB),
      setFrequency: vi.fn().mockResolvedValue(undefined),
      setKnownFrequency: vi.fn(),
    };

    await expect(manager.setFrequency(7100000)).resolves.toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('skips post-frequency capability refreshes after ICOM WLAN direct frequency writes', async () => {
    const refreshAll = vi.spyOn(asTestManager(manager).capabilityManager, 'refreshAll').mockResolvedValue(undefined);
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      setFrequency: vi.fn().mockResolvedValue(undefined),
      setKnownFrequency: vi.fn(),
    };

    await expect(manager.setFrequency(7100000)).resolves.toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('bypasses the capability system while ICOM WLAN is active', async () => {
    const testManager = asTestManager(manager);
    testManager.connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      setTuner: vi.fn(),
    };
    const getSnapshot = vi.spyOn(testManager.capabilityManager, 'getCapabilitySnapshot');
    const refreshAll = vi.spyOn(testManager.capabilityManager, 'refreshAll').mockResolvedValue(undefined);

    expect(manager.getCapabilitySnapshot()).toEqual({ descriptors: [], capabilities: [] });
    await expect(manager.refreshCapabilities()).resolves.toBeUndefined();
    await expect(manager.writeCapability('tuner_switch', true)).rejects.toThrow(
      'radio capability system is disabled for ICOM WLAN'
    );

    expect(getSnapshot).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
    expect(testManager.connection.setTuner).not.toHaveBeenCalled();
  });

  it('does not notify capability runtime of PTT/tuner state while ICOM WLAN is active', async () => {
    const testManager = asTestManager(manager);
    testManager.connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      setTuner: vi.fn().mockResolvedValue(undefined),
      startTuning: vi.fn().mockResolvedValue(true),
      getTunerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        active: false,
        status: 'idle',
      }),
    };
    const setPTTActive = vi.spyOn(testManager.capabilityManager, 'setPTTActive');
    const syncTunerStatus = vi.spyOn(testManager.capabilityManager, 'syncTunerStatus');

    manager.setPTTActive(true);
    manager.setPTTActive(false);
    await expect(manager.setTuner(true)).resolves.toBeUndefined();
    await expect(manager.startTuning()).resolves.toBe(true);

    expect(setPTTActive).not.toHaveBeenCalled();
    expect(syncTunerStatus).not.toHaveBeenCalled();
    expect(manager.isPTTActive()).toBe(false);
  });

  it('queues capability refreshes serially after operating-state frequency changes', async () => {
    const order: string[] = [];
    let releaseFirstRefresh!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const refreshAll = vi.spyOn(asTestManager(manager).capabilityManager, 'refreshAll')
      .mockImplementationOnce(async () => {
        order.push('refresh-1-start');
        await firstRefresh;
        order.push('refresh-1-end');
      })
      .mockImplementationOnce(async () => {
        order.push('refresh-2');
      });
    const applyOperatingState = vi.fn().mockResolvedValue({
      frequencyApplied: true,
      modeApplied: false,
    });
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.HAMLIB),
      applyOperatingState,
      setKnownFrequency: vi.fn(),
    };

    await manager.applyOperatingState({ frequency: 7100000 });
    await manager.applyOperatingState({ frequency: 7200000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['refresh-1-start']);
    expect(refreshAll).toHaveBeenCalledTimes(1);

    releaseFirstRefresh();
    await vi.waitFor(() => {
      expect(order).toEqual(['refresh-1-start', 'refresh-1-end', 'refresh-2']);
    });
    expect(refreshAll).toHaveBeenCalledTimes(2);
  });

  it('skips post-frequency capability refreshes after ICOM WLAN operating-state frequency changes', async () => {
    const refreshAll = vi.spyOn(asTestManager(manager).capabilityManager, 'refreshAll').mockResolvedValue(undefined);
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      applyOperatingState: vi.fn().mockResolvedValue({
        frequencyApplied: true,
        modeApplied: false,
      }),
      setKnownFrequency: vi.fn(),
    };

    await manager.applyOperatingState({ frequency: 7100000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('applies frequency and mode through the connection-level operating state helper', async () => {
    const applyOperatingState = vi.fn().mockResolvedValue({
      frequencyApplied: true,
      modeApplied: false,
      modeError: new Error('mode unavailable'),
    });
    const setKnownFrequency = vi.fn();
    asTestManager(manager).connection = {
      applyOperatingState,
      setKnownFrequency,
    };

    const result = await manager.applyOperatingState({
      frequency: 14074000,
      mode: 'USB',
      tolerateModeFailure: true,
    });

    expect(result.frequencyApplied).toBe(true);
    expect(result.modeApplied).toBe(false);
    expect(result.modeError?.message).toBe('mode unavailable');
    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 14074000,
      mode: 'USB',
      tolerateModeFailure: true,
    });
    expect(setKnownFrequency).toHaveBeenCalledWith(14074000);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not treat tolerated mode failures as connection health failures', async () => {
    const applyOperatingState = vi.fn().mockResolvedValue({
      frequencyApplied: true,
      modeApplied: false,
      modeError: new Error('protocol error'),
    });
    asTestManager(manager).connection = {
      applyOperatingState,
      setKnownFrequency: vi.fn(),
    };

    const result = await manager.applyOperatingState({
      frequency: 14074000,
      mode: 'USB',
      tolerateModeFailure: true,
    });

    expect(result.frequencyApplied).toBe(true);
    expect(result.modeApplied).toBe(false);
    expect(result.modeError?.message).toBe('protocol error');
    expect(send).not.toHaveBeenCalled();
  });

  it('routes tuner action capability writes through the manager tuning flow', async () => {
    const startTuning = vi.spyOn(manager, 'startTuning').mockResolvedValue(true);
    const capabilityWrite = vi.spyOn(asTestManager(manager).capabilityManager, 'writeCapability');

    await expect(manager.writeCapability('tuner_tune', undefined, true)).resolves.toBeUndefined();

    expect(startTuning).toHaveBeenCalledTimes(1);
    expect(capabilityWrite).not.toHaveBeenCalled();
  });

  it('fails tuner action capability writes when tuning does not complete successfully', async () => {
    vi.spyOn(manager, 'startTuning').mockResolvedValue(false);
    const capabilityWrite = vi.spyOn(asTestManager(manager).capabilityManager, 'writeCapability');

    await expect(manager.writeCapability('tuner_tune', undefined, true)).rejects.toThrow('manual tuning failed');

    expect(capabilityWrite).not.toHaveBeenCalled();
  });

  it('routes tuner switch capability writes through the manager tuner control flow', async () => {
    const setTuner = vi.spyOn(manager, 'setTuner').mockResolvedValue(undefined);
    const capabilityWrite = vi.spyOn(asTestManager(manager).capabilityManager, 'writeCapability');

    await expect(manager.writeCapability('tuner_switch', true)).resolves.toBeUndefined();

    expect(setTuner).toHaveBeenCalledWith(true);
    expect(capabilityWrite).not.toHaveBeenCalled();
  });

  it('skips frequency polling while a critical radio operation is active', async () => {
    const getFrequency = vi.fn();
    asTestManager(manager).connection = {
      isCriticalOperationActive: vi.fn().mockReturnValue(true),
      getFrequency,
      setKnownFrequency: vi.fn(),
    };
    vi.spyOn(manager, 'isConnected').mockReturnValue(true);

    await asTestManager(manager).checkFrequencyChange();

    expect(getFrequency).not.toHaveBeenCalled();
  });

  it('emits frequency change during polling even though getFrequency updates the known frequency cache', async () => {
    const setKnownFrequency = vi.fn();
    asTestManager(manager).lastKnownFrequency = 14074000;
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.HAMLIB),
      isCriticalOperationActive: vi.fn().mockReturnValue(false),
      getFrequency: vi.fn().mockResolvedValue(14075000),
      setKnownFrequency,
    };
    vi.spyOn(manager, 'isConnected').mockReturnValue(true);
    const emitSpy = vi.spyOn(manager as unknown as { emit: (event: string, payload: number) => void }, 'emit');

    await asTestManager(manager).checkFrequencyChange();

    expect(asTestManager(manager).connection.getFrequency).toHaveBeenCalledTimes(1);
    expect(setKnownFrequency).toHaveBeenCalledWith(14075000);
    expect(asTestManager(manager).lastKnownFrequency).toBe(14075000);
    expect(emitSpy).toHaveBeenCalledWith('radioFrequencyChanged', 14075000);
  });

  it('skips post-frequency capability refreshes for ICOM WLAN frequency monitor changes', async () => {
    const refreshAll = vi.spyOn(asTestManager(manager).capabilityManager, 'refreshAll').mockResolvedValue(undefined);
    asTestManager(manager).lastKnownFrequency = 14074000;
    asTestManager(manager).connection = {
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      isCriticalOperationActive: vi.fn().mockReturnValue(false),
      getFrequency: vi.fn().mockResolvedValue(14075000),
      setKnownFrequency: vi.fn(),
    };
    vi.spyOn(manager, 'isConnected').mockReturnValue(true);

    await asTestManager(manager).checkFrequencyChange();
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('completes conservative post-connect bootstrap before emitting connected', async () => {
    const order: string[] = [];
    const testManager = asTestManager(manager);
    const connection: TestRadioConnection = {
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn().mockImplementation(async () => {
        order.push('connect');
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
      isCriticalOperationActive: vi.fn().mockReturnValue(false),
      startBackgroundTasks: vi.fn().mockImplementation(() => {
        order.push('background');
      }),
      setPTT: vi.fn().mockImplementation(async () => {
        order.push('ptt-off');
      }),
      setKnownFrequency: vi.fn(),
      getTunerCapabilities: vi.fn().mockImplementation(async () => {
        order.push('tuner');
        return { supported: true, hasSwitch: true, hasManualTune: true };
      }),
      setFrequency: vi.fn().mockImplementation(async () => {
        order.push('restore');
      }),
      getFrequency: vi.fn().mockResolvedValue(14074000),
    };

    vi.spyOn(RadioConnectionFactory, 'create').mockReturnValue(connection as never);
    vi.spyOn(testManager.configManager, 'getLastEngineMode').mockReturnValue('digital');
    vi.spyOn(testManager.configManager, 'getLastSelectedFrequency').mockReturnValue({
      frequency: 14074000,
      mode: 'FT8',
      band: '20m',
      description: '20m FT8',
    });
    vi.spyOn(testManager.configManager, 'getLastVoiceFrequency').mockReturnValue(null);
    vi.spyOn(testManager.capabilityManager, 'onConnected').mockImplementation(async () => {
      order.push('capability');
    });
    vi.spyOn(testManager, 'startFrequencyMonitoring').mockImplementation(() => {
      order.push('monitor');
    });
    testManager.radioActor = null;

    manager.on('connected', () => {
      order.push('connected');
    });
    manager.on('radioFrequencyChanged', (frequency) => {
      order.push(`frequency:${frequency}`);
    });

    await manager.applyConfig({
      type: 'network',
      network: { host: '127.0.0.1', port: 4532 },
    } as HamlibConfig);

    expect(order).toEqual([
      'connect',
      'ptt-off',
      'tuner',
      'restore',
      'capability',
      'frequency:14074000',
      'background',
      'monitor',
      'connected',
    ]);
    expect(connection.startBackgroundTasks).toHaveBeenCalledTimes(1);
    expect(connection.setPTT).toHaveBeenCalledWith(false);
    expect(connection.setFrequency).toHaveBeenCalledWith(14074000);
    expect(testManager.capabilityManager.onConnected).toHaveBeenCalledTimes(1);

    await manager.disconnect('test cleanup');
  });

  it('skips capability bootstrap probes for ICOM WLAN connections', async () => {
    const order: string[] = [];
    const testManager = asTestManager(manager);
    const connection: TestRadioConnection = {
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn().mockImplementation(async () => {
        order.push('connect');
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockReturnValue(true),
      isCriticalOperationActive: vi.fn().mockReturnValue(false),
      getType: vi.fn().mockReturnValue(RadioConnectionType.ICOM_WLAN),
      startBackgroundTasks: vi.fn().mockImplementation(() => {
        order.push('background');
      }),
      setPTT: vi.fn().mockImplementation(async () => {
        order.push('ptt-off');
      }),
      setKnownFrequency: vi.fn(),
      getTunerCapabilities: vi.fn().mockImplementation(async () => {
        order.push('tuner');
        return { supported: true, hasSwitch: true, hasManualTune: true };
      }),
      setFrequency: vi.fn().mockImplementation(async () => {
        order.push('restore');
      }),
      getFrequency: vi.fn().mockResolvedValue(21074000),
    };

    vi.spyOn(RadioConnectionFactory, 'create').mockReturnValue(connection as never);
    vi.spyOn(testManager.configManager, 'getLastEngineMode').mockReturnValue('digital');
    vi.spyOn(testManager.configManager, 'getLastSelectedFrequency').mockReturnValue({
      frequency: 21074000,
      mode: 'FT8',
      band: '15m',
      description: '15m FT8',
    });
    vi.spyOn(testManager.configManager, 'getLastVoiceFrequency').mockReturnValue(null);
    const onConnected = vi.spyOn(testManager.capabilityManager, 'onConnected').mockResolvedValue(undefined);
    const onDisconnected = vi.spyOn(testManager.capabilityManager, 'onDisconnected');
    vi.spyOn(testManager, 'startFrequencyMonitoring').mockImplementation(() => {
      order.push('monitor');
    });
    testManager.radioActor = null;

    await manager.applyConfig({
      type: 'icom-wlan',
      icomWlan: {
        ip: '192.168.31.253',
        port: 50001,
        userName: 'icom',
        password: 'icomicom',
        dataMode: false,
      },
    } as HamlibConfig);

    expect(order).toEqual([
      'connect',
      'ptt-off',
      'tuner',
      'restore',
      'background',
      'monitor',
    ]);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await manager.disconnect('test cleanup');
  });

  it('syncs tuner capability status before and after manual tuning completes', async () => {
    const syncTunerStatus = vi.spyOn(asTestManager(manager).capabilityManager, 'syncTunerStatus');
    asTestManager(manager).connection = {
      startTuning: vi.fn().mockResolvedValue(true),
      getTunerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        active: false,
        status: 'idle',
      }),
    };

    await expect(manager.startTuning()).resolves.toBe(true);

    expect(syncTunerStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      enabled: true,
      active: true,
      status: 'tuning',
    }));
    expect(syncTunerStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({
      enabled: true,
      active: false,
      status: 'success',
    }));
  });

  it('syncs failed tuner capability status when manual tuning reports failure', async () => {
    const syncTunerStatus = vi.spyOn(asTestManager(manager).capabilityManager, 'syncTunerStatus');
    asTestManager(manager).connection = {
      startTuning: vi.fn().mockResolvedValue(false),
      getTunerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        active: false,
        status: 'idle',
      }),
    };

    await expect(manager.startTuning()).resolves.toBe(false);

    expect(syncTunerStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      enabled: true,
      active: true,
      status: 'tuning',
    }));
    expect(syncTunerStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({
      enabled: true,
      active: false,
      status: 'failed',
    }));
  });

  it('syncs tuner capability status after toggling tuner state', async () => {
    const syncTunerStatus = vi.spyOn(asTestManager(manager).capabilityManager, 'syncTunerStatus');
    asTestManager(manager).connection = {
      setTuner: vi.fn().mockResolvedValue(undefined),
      getTunerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        active: false,
        status: 'idle',
      }),
    };

    await expect(manager.setTuner(true)).resolves.toBeUndefined();

    expect(syncTunerStatus).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      active: false,
      status: 'idle',
    }));
  });
});
