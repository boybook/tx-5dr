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

  it('downgrades a statically supported hamlib capability when the first read fails recoverably', async () => {
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
      supported: false,
      value: null,
    });

    manager.onDisconnected();
  });

  it('emits runtime descriptors and richer capability values for dynamically resolved hamlib capabilities', async () => {
    const manager = new RadioCapabilityManager();
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getTuningStep: vi.fn().mockResolvedValue(50),
      getSupportedTuningSteps: vi.fn().mockResolvedValue([10, 50, 100]),
      getAgcMode: vi.fn().mockResolvedValue('fast'),
      getSupportedAgcModes: vi.fn().mockResolvedValue(['off', 'fast', 'auto']),
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
    const connection = new MockConnection(RadioConnectionType.HAMLIB, {
      getMode: vi.fn().mockImplementation(async () => ({
        mode: currentMode,
        bandwidth: currentMode === 'USB' ? 2400 : 12000,
      })),
      getModeBandwidth: vi.fn().mockImplementation(async () => (currentMode === 'USB' ? 2400 : 12000)),
      setModeBandwidth,
      getSupportedModeBandwidths: vi.fn().mockImplementation(async () => (
        currentMode === 'USB' ? [1800, 2400, 3000] : [6000, 10000, 12000]
      )),
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
});
