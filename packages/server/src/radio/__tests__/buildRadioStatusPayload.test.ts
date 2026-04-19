import { describe, expect, it, vi } from 'vitest';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { buildRadioStatusPayload } from '../buildRadioStatusPayload.js';

function createRadioManagerStub() {
  return {
    getConfig: vi.fn().mockReturnValue({ type: 'serial' }),
    getConnectionHealth: vi.fn().mockReturnValue({ connectionHealthy: true }),
    getCoreCapabilities: vi.fn().mockReturnValue({
      readFrequency: true,
      writeFrequency: true,
      readRadioMode: true,
      writeRadioMode: true,
    }),
    getCoreCapabilityDiagnostics: vi.fn().mockReturnValue({}),
    getMeterCapabilities: vi.fn().mockReturnValue(undefined),
  };
}

describe('buildRadioStatusPayload', () => {
  it('fills connected payloads with an explicit unsupported meter capability snapshot when the source is missing one', () => {
    const radioManager = createRadioManagerStub();

    const payload = buildRadioStatusPayload({
      connected: true,
      status: RadioConnectionStatus.CONNECTED,
      radioInfo: null,
      radioManager,
    });

    expect(payload.meterCapabilities).toEqual({
      strength: false,
      swr: false,
      alc: false,
      power: false,
      powerWatts: false,
    });
  });

  it('omits meter capabilities for disconnected payloads', () => {
    const radioManager = createRadioManagerStub();

    const payload = buildRadioStatusPayload({
      connected: false,
      status: RadioConnectionStatus.DISCONNECTED,
      radioInfo: null,
      radioManager,
    });

    expect(payload.meterCapabilities).toBeUndefined();
  });
});
