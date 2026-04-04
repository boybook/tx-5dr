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
      getPowerState: vi.fn().mockResolvedValue('operate'),
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

    expect(getDescriptor(descriptors, 'power_state')).toMatchObject({
      id: 'power_state',
      valueType: 'enum',
    });
    expect(getCapability(capabilities, 'power_state')).toMatchObject({
      id: 'power_state',
      supported: true,
      value: 'operate',
    });

    manager.onDisconnected();
  });
});
