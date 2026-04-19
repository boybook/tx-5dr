import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { RadioBridge } from '../RadioBridge.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { ConfigManager } from '../../config/config-manager.js';

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
  afterEach(() => {
    vi.useRealTimers();
  });

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
      getEngineMode: () => 'digital',
    });

    bridge.setupListeners();
    radioManager.emit('connected');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(radioManager.setFrequency).not.toHaveBeenCalled();
    expect(radioStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
      status: RadioConnectionStatus.CONNECTED,
      meterCapabilities: {
        strength: false,
        swr: false,
        alc: false,
        power: false,
        powerWatts: false,
      },
      tunerCapabilities: { supported: true, hasSwitch: false, hasManualTune: false },
    }));
  });

  it('retries automatic engine restore when the configured audio device is temporarily unavailable', async () => {
    vi.useFakeTimers();

    const radioManager = createRadioManagerStub();
    let startAttempts = 0;
    const lifecycle = {
      getIsRunning: vi.fn().mockReturnValue(false),
      getEngineState: vi.fn().mockReturnValue('idle'),
      start: vi.fn(async () => {
        startAttempts += 1;
        if (startAttempts === 1) {
          throw new RadioError({
            code: RadioErrorCode.DEVICE_NOT_FOUND,
            message: 'Configured audio input device "IC-705" is temporarily unavailable after USB reconnect',
            userMessage: 'Configured audio input device "IC-705" is temporarily unavailable.',
            severity: RadioErrorSeverity.ERROR,
            context: {
              temporaryUnavailable: true,
              recoverable: true,
              direction: 'input',
              deviceName: 'IC-705',
            },
          });
        }
      }),
      sendRadioDisconnected: vi.fn(),
    };

    const bridge = new RadioBridge({
      engineEmitter: new EventEmitter() as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => lifecycle as any,
      getEngineMode: () => 'digital',
    });

    bridge.wasRunningBeforeDisconnect = true;
    await (bridge as any).restoreRunningStateIfNeeded();

    expect(startAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(startAttempts).toBe(2);
    expect(bridge.wasRunningBeforeDisconnect).toBe(false);
  });

  it('persists and broadcasts restored voice preset frequencies with voice semantics', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);

    const configManager = ConfigManager.getInstance();
    const updateLastVoiceFrequency = vi.spyOn(configManager, 'updateLastVoiceFrequency').mockResolvedValue();
    const updateLastSelectedFrequency = vi.spyOn(configManager, 'updateLastSelectedFrequency').mockResolvedValue();

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: {
        getPresets: vi.fn().mockReturnValue([
          { frequency: 14074000, mode: 'FT8', band: '20m', radioMode: 'USB', description: '14.074 MHz 20m' },
          { frequency: 14270000, mode: 'VOICE', band: '20m', radioMode: 'USB', description: '14.270 MHz 20m Calling' },
        ]),
      } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({
        getIsRunning: vi.fn().mockReturnValue(false),
        getEngineState: vi.fn().mockReturnValue('idle'),
        start: vi.fn(),
        sendRadioDisconnected: vi.fn(),
      } as any),
      getEngineMode: () => 'voice',
    });

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 14270000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastVoiceFrequency).toHaveBeenCalledWith({
      frequency: 14270000,
      radioMode: 'USB',
      band: '20m',
      description: '14.270 MHz 20m Calling',
    });
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14270000,
      mode: 'VOICE',
      band: '20m',
      radioMode: 'USB',
      source: 'radio',
    }));
  });

  it('persists custom voice frequencies without overwriting digital history', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);

    const configManager = ConfigManager.getInstance();
    const updateLastVoiceFrequency = vi.spyOn(configManager, 'updateLastVoiceFrequency').mockResolvedValue();
    const updateLastSelectedFrequency = vi.spyOn(configManager, 'updateLastSelectedFrequency').mockResolvedValue();
    vi.spyOn(configManager, 'getLastVoiceFrequency').mockReturnValue({
      frequency: 14270000,
      radioMode: 'USB',
      band: '20m',
      description: '14.270 MHz 20m Calling',
    });

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: {
        getPresets: vi.fn().mockReturnValue([
          { frequency: 14074000, mode: 'FT8', band: '20m', radioMode: 'USB', description: '14.074 MHz 20m' },
        ]),
      } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({
        getIsRunning: vi.fn().mockReturnValue(false),
        getEngineState: vi.fn().mockReturnValue('idle'),
        start: vi.fn(),
        sendRadioDisconnected: vi.fn(),
      } as any),
      getEngineMode: () => 'voice',
    });

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 14123456);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastVoiceFrequency).toHaveBeenCalledWith({
      frequency: 14123456,
      radioMode: 'USB',
      band: '20m',
      description: '14.123 MHz 20m',
    });
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14123456,
      mode: 'VOICE',
      band: '20m',
      radioMode: 'USB',
      source: 'radio',
    }));
  });
});
