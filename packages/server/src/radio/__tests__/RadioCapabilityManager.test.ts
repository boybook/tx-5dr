import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityState, HamlibConfig } from '@tx5dr/contracts';
import { RadioCapabilityManager } from '../RadioCapabilityManager.js';
import {
  RadioConnectionState,
  RadioConnectionType,
  type IRadioConnectionEvents,
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

  async setMode(_mode: string, _bandwidth?: 'narrow' | 'wide'): Promise<void> {}

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
});
