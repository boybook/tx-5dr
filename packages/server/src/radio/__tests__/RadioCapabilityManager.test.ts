import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityDescriptor, CapabilityState, HamlibConfig } from '@tx5dr/contracts';
import { RadioCapabilityManager } from '../RadioCapabilityManager.js';
import {
  RadioConnectionState,
  RadioConnectionType,
  type IRadioConnectionEvents,
  type RadioModeBandwidth,
} from '../connections/IRadioConnection.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';

class MockConnection extends EventEmitter<IRadioConnectionEvents> {
  constructor(
    private readonly type: RadioConnectionType,
    overrides: Record<string, unknown> = {},
  ) {
    super();
    Object.assign(this, overrides);
  }

  getType(): RadioConnectionType {
    return this.type;
  }

  getState(): RadioConnectionState {
    return RadioConnectionState.CONNECTED;
  }

  isHealthy(): boolean {
    return true;
  }

  async connect(_config: HamlibConfig): Promise<void> {}

  async disconnect(_reason?: string): Promise<void> {}

  async setFrequency(_frequency: number): Promise<void> {}

  async getFrequency(): Promise<number> {
    return 7100000;
  }

  async setPTT(_enabled: boolean): Promise<void> {}

  async setMode(_mode: string, _bandwidth?: RadioModeBandwidth, _options?: { intent?: 'voice' | 'digital' }): Promise<void> {}

  async getMode(): Promise<{ mode: string; bandwidth: string }> {
    return { mode: 'USB', bandwidth: 'wide' };
  }
}

function getCapability(snapshot: CapabilityState[], id: string): CapabilityState {
  const capability = snapshot.find((item) => item.id === id);
  if (!capability) {
    throw new Error(`Capability ${id} not found`);
  }
  return capability;
}

function getDescriptor(snapshot: CapabilityDescriptor[], id: string): CapabilityDescriptor {
  const descriptor = snapshot.find((item) => item.id === id);
  if (!descriptor) {
    throw new Error(`Descriptor ${id} not found`);
  }
  return descriptor;
}

describe('RadioCapabilityManager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('handles unsupported optional probe errors without rejecting onConnected', async () => {
    const manager = new RadioCapabilityManager();
    const getSQL = vi.fn().mockRejectedValue(new Error('SQL level not supported by this radio'));
    const connection = new MockConnection(RadioConnectionType.ICOM_WLAN, {
      getSQL,
    });

    let snapshot: CapabilityState[] = [];
    manager.on('capabilityList', ({ capabilities }) => {
      snapshot = capabilities;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getSQL).toHaveBeenCalledTimes(1);
    expect(getCapability(snapshot, 'sql')).toMatchObject({
      id: 'sql',
      supported: false,
      value: null,
    });

    manager.onDisconnected();
  });

  it('marks a statically supported hamlib capability unavailable when the first read fails recoverably', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'SQL'),
      getSQL: vi.fn().mockRejectedValue(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (getSQL): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'getSQL', optional: true, recoverable: true },
      })),
    });

    let snapshot: CapabilityState[] = [];
    manager.on('capabilityList', ({ capabilities }) => {
      snapshot = capabilities;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getCapability(snapshot, 'sql')).toMatchObject({
      id: 'sql',
      supported: true,
      availability: 'unavailable',
      availabilityReason: 'runtime_error',
      value: null,
    });

    manager.onDisconnected();
  });

  it('recovers an unavailable supported capability after a later successful read', async () => {
    const manager = new RadioCapabilityManager();
    const getSQL = vi.fn()
      .mockRejectedValueOnce(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (getSQL): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'getSQL', optional: true, recoverable: true },
      }))
      .mockResolvedValue(0.25);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'SQL'),
      getSQL,
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    expect(getCapability(manager.getCapabilityStates(), 'sql')).toMatchObject({
      supported: true,
      availability: 'unavailable',
      value: null,
    });

    await expect(manager.refreshAll()).resolves.toBeUndefined();

    expect(getCapability(manager.getCapabilityStates(), 'sql')).toMatchObject({
      supported: true,
      availability: 'available',
      value: 0.25,
    });

    manager.onDisconnected();
  });

  it('skips capability reads while the radio I/O queue is busy and resumes afterward', async () => {
    const manager = new RadioCapabilityManager();
    let busy = true;
    const getSQL = vi.fn().mockResolvedValue(0.25);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'SQL'),
      getSQL,
      getRadioIoQueueSnapshot: vi.fn(() => ({
        busy,
        backpressure: busy,
        criticalActive: false,
        activeCount: busy ? 1 : 0,
        activeTask: busy ? 'startManagedSpectrum' : null,
        activeRunMs: busy ? 5000 : null,
        pendingCount: busy ? 2 : 0,
        criticalPendingCount: 0,
        normalPendingCount: busy ? 2 : 0,
        oldestPendingTask: busy ? 'getLockMode' : null,
        oldestPendingWaitMs: busy ? 1000 : null,
        dedupedTaskCount: 0,
      })),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    expect(getSQL).not.toHaveBeenCalled();

    busy = false;
    await expect(manager.refreshAll()).resolves.toBeUndefined();
    expect(getSQL).toHaveBeenCalledTimes(1);

    manager.onDisconnected();
  });

  it('still polls split_enabled while the radio I/O queue reports backpressure', async () => {
    const manager = new RadioCapabilityManager();
    const getSplitEnabled = vi.fn().mockResolvedValue(true);
    const getSplitFrequency = vi.fn().mockResolvedValue(14_275_000);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getSplitEnabled,
      setSplitEnabled: vi.fn().mockResolvedValue(undefined),
      getSplitFrequency,
      setSplitFrequency: vi.fn().mockResolvedValue(undefined),
      getRadioIoQueueSnapshot: vi.fn(() => ({
        busy: true,
        backpressure: true,
        criticalActive: false,
        activeCount: 1,
        activeTask: 'getSupportedModeBandwidths',
        activeRunMs: 5,
        pendingCount: 0,
        criticalPendingCount: 0,
        normalPendingCount: 0,
        oldestPendingTask: null,
        oldestPendingWaitMs: null,
        dedupedTaskCount: 0,
      })),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getSplitEnabled).toHaveBeenCalledTimes(2);
    expect(getSplitFrequency).toHaveBeenCalledTimes(1);
    expect(getCapability(manager.getCapabilityStates(), 'split_enabled')).toMatchObject({
      value: true,
      meta: { txFrequency: 14_275_000 },
    });

    manager.onDisconnected();
  });

  it('dedupes overlapping split_enabled polls', async () => {
    const manager = new RadioCapabilityManager();
    let releaseSplitRead!: (value: boolean) => void;
    const splitRead = new Promise<boolean>((resolve) => {
      releaseSplitRead = resolve;
    });
    const getSplitEnabled = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(splitRead)
      .mockResolvedValue(true);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getSplitEnabled,
      setSplitEnabled: vi.fn().mockResolvedValue(undefined),
      getSplitFrequency: vi.fn().mockResolvedValue(14_275_000),
      setSplitFrequency: vi.fn().mockResolvedValue(undefined),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    const firstPoll = (manager as any).runtime.pollCapabilityOnce('split_enabled');
    await Promise.resolve();
    const secondPoll = (manager as any).runtime.pollCapabilityOnce('split_enabled');
    await Promise.resolve();

    expect(getSplitEnabled).toHaveBeenCalledTimes(3);

    releaseSplitRead(true);
    await expect(firstPoll).resolves.toBeUndefined();
    await expect(secondPoll).resolves.toBeUndefined();

    expect(getSplitEnabled).toHaveBeenCalledTimes(3);

    manager.onDisconnected();
  });

  it('rejects writes to a supported capability while it is currently unavailable', async () => {
    const manager = new RadioCapabilityManager();
    const setSQL = vi.fn().mockResolvedValue(undefined);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'SQL'),
      getSQL: vi.fn().mockRejectedValue(new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Optional radio operation unavailable (getSQL): Feature not available',
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        context: { operation: 'getSQL', optional: true, recoverable: true },
      })),
      setSQL,
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    await expect(manager.writeCapability('sql', 0.5)).rejects.toThrow('currently unavailable');
    expect(setSQL).not.toHaveBeenCalled();

    manager.onDisconnected();
  });

  it('emits runtime descriptors and richer capability values for dynamically resolved hamlib capabilities', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getTuningStep: vi.fn().mockResolvedValue(50),
      getSupportedTuningSteps: vi.fn().mockResolvedValue([10, 50, 100]),
      getAgcMode: vi.fn().mockResolvedValue('fast'),
      getSupportedAgcModes: vi.fn().mockResolvedValue(['off', 'fast', 'auto']),
      isSupportedLevel: vi.fn((level: string) => level === 'RFPOWER'),
      getRFPower: vi.fn().mockResolvedValue(0.5),
      getSupportedRFPowerSteps: vi.fn().mockResolvedValue([
        { value: 0.1, label: '1 W (10%)' },
        { value: 0.5, label: '5 W (50%)' },
      ]),
      getPreampLevel: vi.fn().mockResolvedValue(10),
      getSupportedPreampLevels: vi.fn().mockResolvedValue([10, 20]),
      getAttenuatorLevel: vi.fn().mockResolvedValue(6),
      getSupportedAttenuatorLevels: vi.fn().mockResolvedValue([6, 12]),
    });

    let descriptors: CapabilityDescriptor[] = [];
    let capabilities: CapabilityState[] = [];
    manager.on('capabilityList', (snapshot) => {
      descriptors = snapshot.descriptors;
      capabilities = snapshot.capabilities;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getDescriptor(descriptors, 'tuning_step')).toMatchObject({
      id: 'tuning_step',
      valueType: 'enum',
      options: [{ value: 10 }, { value: 50 }, { value: 100 }],
    });
    expect(getCapability(capabilities, 'tuning_step')).toMatchObject({
      id: 'tuning_step',
      supported: true,
      value: 50,
    });

    expect(getDescriptor(descriptors, 'rf_power')).toMatchObject({
      id: 'rf_power',
      valueType: 'number',
      discreteOptions: [
        { value: 0.1, label: '1 W (10%)' },
        { value: 0.5, label: '5 W (50%)' },
      ],
    });
    expect(getCapability(capabilities, 'rf_power')).toMatchObject({
      id: 'rf_power',
      supported: true,
      value: 0.5,
    });

    // power_state has been moved out of the capability system; the
    // RadioPowerController now owns power transitions, so it is no
    // longer expected as a capability descriptor or state.

    expect(getDescriptor(descriptors, 'agc_mode')).toMatchObject({
      id: 'agc_mode',
      valueType: 'enum',
      options: [
        { value: 'off', labelI18nKey: 'radio:capability.options.agc_mode.off' },
        { value: 'fast', labelI18nKey: 'radio:capability.options.agc_mode.fast' },
        { value: 'auto', labelI18nKey: 'radio:capability.options.agc_mode.auto' },
      ],
    });
    expect(getCapability(capabilities, 'agc_mode')).toMatchObject({
      id: 'agc_mode',
      supported: true,
      value: 'fast',
    });

    expect(getDescriptor(descriptors, 'preamp')).toMatchObject({
      id: 'preamp',
      valueType: 'enum',
      options: [
        { value: 0, labelI18nKey: 'radio:capability.options.common.off' },
        { value: 10, label: '10 dB' },
        { value: 20, label: '20 dB' },
      ],
    });
    expect(getCapability(capabilities, 'preamp')).toMatchObject({
      id: 'preamp',
      supported: true,
      value: 10,
    });

    expect(getDescriptor(descriptors, 'attenuator')).toMatchObject({
      id: 'attenuator',
      valueType: 'enum',
      options: [
        { value: 0, labelI18nKey: 'radio:capability.options.common.off' },
        { value: 6, label: '6 dB' },
        { value: 12, label: '12 dB' },
      ],
    });
    expect(getCapability(capabilities, 'attenuator')).toMatchObject({
      id: 'attenuator',
      supported: true,
      value: 6,
    });

    manager.onDisconnected();
  });

  it('probes ICOM WLAN 0.6.2 profile-gated capability methods through generic descriptors', async () => {
    const manager = new RadioCapabilityManager();
    const setMonitorEnabled = vi.fn().mockResolvedValue(undefined);
    const setApfEnabled = vi.fn().mockResolvedValue(undefined);
    const setNBEnabled = vi.fn().mockResolvedValue(undefined);
    const setNRLevel = vi.fn().mockResolvedValue(undefined);
    const setDigiSelEnabled = vi.fn().mockResolvedValue(undefined);
    const setRFGain = vi.fn().mockResolvedValue(undefined);
    const setSpectrumSpeed = vi.fn().mockResolvedValue(undefined);
    const connection = new MockConnection(RadioConnectionType.ICOM_WLAN, {
      getMonitorEnabled: vi.fn().mockResolvedValue(true),
      setMonitorEnabled,
      getApfEnabled: vi.fn().mockResolvedValue(true),
      setApfEnabled,
      getApfLevel: vi.fn().mockResolvedValue(0.5),
      setApfLevel: vi.fn().mockResolvedValue(undefined),
      getNBEnabled: vi.fn().mockResolvedValue(true),
      setNBEnabled,
      getNBLevel: vi.fn().mockResolvedValue(0.35),
      setNBLevel: vi.fn().mockResolvedValue(undefined),
      getNREnabled: vi.fn().mockResolvedValue(false),
      setNREnabled: vi.fn().mockResolvedValue(undefined),
      getNRLevel: vi.fn().mockResolvedValue(0.6),
      setNRLevel,
      getVoxDelay: vi.fn().mockResolvedValue(12),
      setVoxDelay: vi.fn().mockResolvedValue(undefined),
      getAgcTime: vi.fn().mockResolvedValue(4),
      setAgcTime: vi.fn().mockResolvedValue(undefined),
      getBalance: vi.fn().mockResolvedValue(0.45),
      setBalance: vi.fn().mockResolvedValue(undefined),
      getDigiSelEnabled: vi.fn().mockResolvedValue(true),
      setDigiSelEnabled,
      getDigiSelLevel: vi.fn().mockResolvedValue(0.7),
      setDigiSelLevel: vi.fn().mockResolvedValue(undefined),
      getRFGain: vi.fn().mockResolvedValue(0.4),
      setRFGain,
      getRitEnabled: vi.fn().mockResolvedValue(false),
      setRitEnabled: vi.fn().mockResolvedValue(undefined),
      getTuningStep: vi.fn().mockResolvedValue(50),
      setTuningStep: vi.fn().mockResolvedValue(undefined),
      getSupportedTuningSteps: vi.fn().mockResolvedValue([10, 50, 100]),
      getAudioIfMode: vi.fn().mockResolvedValue('wlan'),
      setAudioIfMode: vi.fn().mockResolvedValue(undefined),
      getSupportedAudioIfModes: vi.fn().mockResolvedValue(['default', 'wlan']),
      getSpectrumDataOutput: vi.fn().mockResolvedValue(true),
      setSpectrumDataOutput: vi.fn().mockResolvedValue(undefined),
      getSpectrumSpeed: vi.fn().mockResolvedValue('fast'),
      setSpectrumSpeed,
      getSupportedSpectrumSpeeds: vi.fn().mockResolvedValue(['slow', 'fast']),
    });

    let latestSnapshot = manager.getCapabilitySnapshot();
    manager.on('capabilityList', (snapshot) => {
      latestSnapshot = snapshot;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getCapability(latestSnapshot.capabilities, 'monitor_enabled')).toMatchObject({
      supported: true,
      value: true,
    });
    expect(getCapability(latestSnapshot.capabilities, 'apf_enabled')).toMatchObject({
      supported: true,
      value: true,
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'apf_level')).toMatchObject({
      compoundGroup: 'apf',
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'nb')).toMatchObject({
      valueType: 'boolean',
      compoundGroup: 'nb',
    });
    expect(getCapability(latestSnapshot.capabilities, 'nb')).toMatchObject({
      supported: true,
      value: true,
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'nb_level')).toMatchObject({
      valueType: 'number',
      compoundGroup: 'nb',
    });
    expect(getCapability(latestSnapshot.capabilities, 'nb_level')).toMatchObject({
      supported: true,
      value: 0.35,
    });
    expect(getCapability(latestSnapshot.capabilities, 'nr')).toMatchObject({
      supported: true,
      value: false,
    });
    expect(getCapability(latestSnapshot.capabilities, 'nr_level')).toMatchObject({
      supported: true,
      value: 0.6,
    });
    expect(getCapability(latestSnapshot.capabilities, 'vox_delay')).toMatchObject({
      supported: true,
      value: 12,
    });
    expect(getCapability(latestSnapshot.capabilities, 'agc_time')).toMatchObject({
      supported: true,
      value: 4,
    });
    expect(getCapability(latestSnapshot.capabilities, 'balance')).toMatchObject({
      supported: true,
      value: 0.45,
    });
    expect(getCapability(latestSnapshot.capabilities, 'digi_sel_enabled')).toMatchObject({
      supported: true,
      value: true,
    });
    expect(getCapability(latestSnapshot.capabilities, 'digi_sel_level')).toMatchObject({
      supported: true,
      value: 0.7,
    });
    expect(getCapability(latestSnapshot.capabilities, 'rf_gain')).toMatchObject({
      supported: true,
      value: 0.4,
    });
    expect(getCapability(latestSnapshot.capabilities, 'rit_enabled')).toMatchObject({
      supported: true,
      value: false,
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'tuning_step')).toMatchObject({
      options: [{ value: 10 }, { value: 50 }, { value: 100 }],
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'audio_if_mode')).toMatchObject({
      options: [{ value: 'default' }, { value: 'wlan' }],
    });
    expect(getDescriptor(latestSnapshot.descriptors, 'spectrum_speed')).toMatchObject({
      options: [{ value: 'slow' }, { value: 'fast' }],
    });

    await expect(manager.writeCapability('monitor_enabled', false)).resolves.toBeUndefined();
    await expect(manager.writeCapability('apf_enabled', false)).resolves.toBeUndefined();
    await expect(manager.writeCapability('nb', false)).resolves.toBeUndefined();
    await expect(manager.writeCapability('nr_level', 0.25)).resolves.toBeUndefined();
    await expect(manager.writeCapability('digi_sel_enabled', false)).resolves.toBeUndefined();
    await expect(manager.writeCapability('rf_gain', 0.8)).resolves.toBeUndefined();
    await expect(manager.writeCapability('spectrum_speed', 'slow')).resolves.toBeUndefined();
    expect(setMonitorEnabled).toHaveBeenCalledWith(false);
    expect(setApfEnabled).toHaveBeenCalledWith(false);
    expect(setNBEnabled).toHaveBeenCalledWith(false);
    expect(setNRLevel).toHaveBeenCalledWith(0.25);
    expect(setDigiSelEnabled).toHaveBeenCalledWith(false);
    expect(setRFGain).toHaveBeenCalledWith(0.8);
    expect(setSpectrumSpeed).toHaveBeenCalledWith('slow');

    manager.onDisconnected();
  });

  it('emits tuner capability updates when only tuner meta changes', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.ICOM_WLAN, {
      getTunerCapabilities: vi.fn().mockResolvedValue({
        supported: true,
        hasSwitch: true,
        hasManualTune: true,
      }),
      getTunerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        active: false,
        status: 'idle',
      }),
    });

    const tunerEvents: CapabilityState[] = [];
    manager.on('capabilityChanged', (state) => {
      if (state.id === 'tuner_switch') {
        tunerEvents.push(state);
      }
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    tunerEvents.length = 0;
    manager.syncTunerStatus({
      enabled: true,
      active: true,
      status: 'tuning',
    });
    manager.syncTunerStatus({
      enabled: true,
      active: false,
      status: 'success',
    });

    expect(tunerEvents).toHaveLength(2);
    expect(tunerEvents[0]).toMatchObject({
      id: 'tuner_switch',
      supported: true,
      value: true,
      meta: { status: 'tuning' },
    });
    expect(tunerEvents[1]).toMatchObject({
      id: 'tuner_switch',
      supported: true,
      value: true,
      meta: { status: 'success' },
    });

    manager.onDisconnected();
  });

  it('negotiates mode_bandwidth for hamlib and refreshes descriptor options when mode changes', async () => {
    const manager = new RadioCapabilityManager();
    let currentMode = 'USB';
    const setModeBandwidth = vi.fn().mockResolvedValue(undefined);
    const getSupportedModeBandwidths = vi.fn().mockImplementation(async () => (
      currentMode === 'USB' ? [1800, 2400, 3000] : [6000, 10000, 12000]
    ));
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getMode: vi.fn().mockImplementation(async () => ({
        mode: currentMode,
        bandwidth: currentMode === 'USB' ? 2400 : 12000,
      })),
      getModeBandwidth: vi.fn().mockImplementation(async () => (currentMode === 'USB' ? 2400 : 12000)),
      setModeBandwidth,
      getSupportedModeBandwidths,
    });

    let latestSnapshot = manager.getCapabilitySnapshot();
    manager.on('capabilityList', (snapshot) => {
      latestSnapshot = snapshot;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    const usbDescriptor = getDescriptor(latestSnapshot.descriptors, 'mode_bandwidth');
    expect(usbDescriptor).toMatchObject({
      id: 'mode_bandwidth',
      valueType: 'enum',
      options: [{ value: 1800 }, { value: 2400 }, { value: 3000 }],
    });
    expect(getCapability(latestSnapshot.capabilities, 'mode_bandwidth')).toMatchObject({
      id: 'mode_bandwidth',
      supported: true,
      value: 2400,
    });

    currentMode = 'FM';
    await (manager as any).runtime.pollCapabilityOnce('mode_bandwidth');

    const staleDescriptor = getDescriptor(latestSnapshot.descriptors, 'mode_bandwidth');
    expect(staleDescriptor).toMatchObject({
      id: 'mode_bandwidth',
      options: [{ value: 1800 }, { value: 2400 }, { value: 3000 }],
    });
    expect(getSupportedModeBandwidths).toHaveBeenCalledTimes(2);
    expect(getCapability(manager.getCapabilityStates(), 'mode_bandwidth')).toMatchObject({
      id: 'mode_bandwidth',
      supported: true,
      value: 12000,
    });

    await expect(manager.refreshDescriptor('mode_bandwidth')).resolves.toBeUndefined();

    const fmDescriptor = getDescriptor(latestSnapshot.descriptors, 'mode_bandwidth');
    expect(fmDescriptor).toMatchObject({
      id: 'mode_bandwidth',
      options: [{ value: 6000 }, { value: 10000 }, { value: 12000 }],
    });
    expect(getCapability(manager.getCapabilityStates(), 'mode_bandwidth')).toMatchObject({
      id: 'mode_bandwidth',
      supported: true,
      value: 12000,
    });

    await expect(manager.writeCapability('mode_bandwidth', 10000)).resolves.toBeUndefined();
    expect(setModeBandwidth).toHaveBeenCalledWith(10000);

    manager.onDisconnected();
  });

  it('refreshes the RF power descriptor when discrete steps change', async () => {
    const manager = new RadioCapabilityManager();
    let currentSteps = [{ value: 0.1, label: '1 W (10%)' }, { value: 0.5, label: '5 W (50%)' }];
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'RFPOWER'),
      getRFPower: vi.fn().mockResolvedValue(0.5),
      getSupportedRFPowerSteps: vi.fn().mockImplementation(async () => currentSteps),
    });

    let latestSnapshot = manager.getCapabilitySnapshot();
    manager.on('capabilityList', (snapshot) => {
      latestSnapshot = snapshot;
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    expect(getDescriptor(latestSnapshot.descriptors, 'rf_power').discreteOptions).toEqual(currentSteps);

    currentSteps = [{ value: 0.2, label: '2 W (20%)' }, { value: 0.8, label: '8 W (80%)' }];
    await expect(manager.refreshDescriptor('rf_power')).resolves.toBeUndefined();

    expect(getDescriptor(latestSnapshot.descriptors, 'rf_power').discreteOptions).toEqual(currentSteps);
  });

  it('exposes Split TX frequency through split_enabled metadata', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getSplitEnabled: vi.fn().mockResolvedValue(true),
      setSplitEnabled: vi.fn().mockResolvedValue(undefined),
      getSplitFrequency: vi.fn().mockResolvedValue(14_275_000),
      setSplitFrequency: vi.fn().mockResolvedValue(undefined),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    const snapshot = manager.getCapabilitySnapshot();
    expect(snapshot.descriptors.some((descriptor) => descriptor.id === 'split')).toBe(false);
    expect(getCapability(snapshot.capabilities, 'split_enabled')).toMatchObject({
      id: 'split_enabled',
      supported: true,
      value: true,
      meta: {
        txFrequency: 14_275_000,
        txFrequencyWritable: true,
      },
    });

    manager.onDisconnected();
  });

  it('polls split_enabled metadata and emits TX frequency changes', async () => {
    vi.useFakeTimers();
    const manager = new RadioCapabilityManager();
    let splitEnabled = true;
    let txFrequency = 14_275_000;
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getSplitEnabled: vi.fn().mockImplementation(async () => splitEnabled),
      setSplitEnabled: vi.fn().mockResolvedValue(undefined),
      getSplitFrequency: vi.fn().mockImplementation(async () => (splitEnabled ? txFrequency : null)),
      setSplitFrequency: vi.fn().mockResolvedValue(undefined),
    });
    const changes: CapabilityState[] = [];
    manager.on('capabilityChanged', (state) => {
      if (state.id === 'split_enabled') changes.push(state);
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    expect(getDescriptor(manager.getCapabilityDescriptors(), 'split_enabled').pollIntervalMs).toBe(2000);

    txFrequency = 14_276_500;
    await vi.advanceTimersByTimeAsync(2000);

    expect(changes.at(-1)).toMatchObject({
      id: 'split_enabled',
      value: true,
      meta: {
        txFrequency: 14_276_500,
        txFrequencyWritable: true,
      },
    });

    splitEnabled = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(changes.at(-1)).toMatchObject({
      id: 'split_enabled',
      value: false,
      meta: {
        txFrequency: null,
        txFrequencyWritable: true,
      },
    });

    manager.onDisconnected();
  });

  it('refreshes split_enabled metadata immediately after writing Split', async () => {
    const manager = new RadioCapabilityManager();
    let splitEnabled = false;
    const getSplitFrequency = vi.fn().mockResolvedValue(14_275_000);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getSplitEnabled: vi.fn().mockImplementation(async () => splitEnabled),
      setSplitEnabled: vi.fn().mockImplementation(async (value: boolean) => {
        splitEnabled = value;
      }),
      getSplitFrequency,
      setSplitFrequency: vi.fn().mockResolvedValue(undefined),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    await expect(manager.writeCapability('split_enabled', true)).resolves.toBeUndefined();

    expect(getCapability(manager.getCapabilityStates(), 'split_enabled')).toMatchObject({
      id: 'split_enabled',
      value: true,
      meta: {
        txFrequency: 14_275_000,
        txFrequencyWritable: true,
      },
    });
    expect(getSplitFrequency).toHaveBeenCalled();

    manager.onDisconnected();
  });

  it('keeps split_enabled available without TX frequency controls when the connection cannot read TX frequency', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.ICOM_WLAN, {
      getSplitEnabled: vi.fn().mockResolvedValue(true),
      setSplitEnabled: vi.fn().mockResolvedValue(undefined),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();

    expect(getCapability(manager.getCapabilityStates(), 'split_enabled')).toMatchObject({
      id: 'split_enabled',
      supported: true,
      value: true,
      meta: {
        txFrequency: null,
        txFrequencyWritable: false,
      },
    });

    manager.onDisconnected();
  });

  it('allows rf_power percent writes even when Hamlib discrete steps are present', async () => {
    const manager = new RadioCapabilityManager();
    const setRFPower = vi.fn().mockResolvedValue(undefined);
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      isSupportedLevel: vi.fn((level: string) => level === 'RFPOWER'),
      getRFPower: vi.fn().mockResolvedValue(0.5),
      setRFPower,
      getSupportedRFPowerSteps: vi.fn().mockResolvedValue([
        { value: 0.1, label: '10 W' },
        { value: 0.5, label: '50 W' },
        { value: 1, label: '100 W' },
      ]),
    });

    await expect(manager.onConnected(connection as never)).resolves.toBeUndefined();
    await expect(manager.writeCapability('rf_power', 0.57)).resolves.toBeUndefined();
    expect(setRFPower).toHaveBeenCalledWith(0.57);
  });
});
