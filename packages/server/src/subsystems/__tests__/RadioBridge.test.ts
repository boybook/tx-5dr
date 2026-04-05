import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { RadioBridge } from '../RadioBridge.js';

function createRadioManagerStub() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getRadioInfo: vi.fn().mockResolvedValue({ manufacturer: 'ICOM', model: 'IC-M710' }),
    getConfig: vi.fn().mockReturnValue({ type: 'serial' }),
    getTunerCapabilities: vi.fn().mockResolvedValue({ supported: true, hasSwitch: false, hasManualTune: false }),
    getConnectionHealth: vi.fn().mockReturnValue({ connectionHealthy: true }),
    getCoreCapabilities: vi.fn().mockReturnValue({
      readFrequency: true,
      writeFrequency: true,
      readRadioMode: true,
      writeRadioMode: true,
    }),
    getCoreCapabilityDiagnostics: vi.fn().mockReturnValue({}),
    getMeterCapabilities: vi.fn().mockReturnValue(undefined),
    getConnectionStatus: vi.fn().mockReturnValue(RadioConnectionStatus.CONNECTED),
    isConnected: vi.fn().mockReturnValue(true),
    setFrequency: vi.fn(),
  });
}

describe('RadioBridge', () => {
  it('projects connected state without performing connection-time frequency writes', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const radioStatusChanged = vi.fn();
    engineEmitter.on('radioStatusChanged', radioStatusChanged);

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({
        getIsRunning: vi.fn().mockReturnValue(false),
        getEngineState: vi.fn().mockReturnValue('idle'),
        start: vi.fn(),
        sendRadioDisconnected: vi.fn(),
      } as any),
    });

    bridge.setupListeners();
    radioManager.emit('connected');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(radioManager.setFrequency).not.toHaveBeenCalled();
    expect(radioStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
      status: RadioConnectionStatus.CONNECTED,
      tunerCapabilities: { supported: true, hasSwitch: false, hasManualTune: false },
    }));
  });
});
