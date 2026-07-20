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
    getCurrentRadioSessionContext: vi.fn().mockReturnValue({
      profileId: 'profile-a',
      sessionGeneration: 1,
    }),
    isCurrentRadioSessionContext: vi.fn((context: { profileId: string | null; sessionGeneration: number }) => (
      context.profileId === 'profile-a' && context.sessionGeneration === 1
    )),
    setFrequency: vi.fn(),
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it('drops a connected handler that completes after its radio session is replaced', async () => {
    const radioManager = createRadioManagerStub();
    const radioInfo = createDeferred<{ manufacturer: string; model: string }>();
    radioManager.getRadioInfo.mockReturnValueOnce(radioInfo.promise);
    let sessionCurrent = true;
    radioManager.isCurrentRadioSessionContext.mockImplementation(() => sessionCurrent);
    const engineEmitter = new EventEmitter();
    const radioStatusChanged = vi.fn();
    engineEmitter.on('radioStatusChanged', radioStatusChanged);
    const lifecycle = {
      getIsRunning: vi.fn().mockReturnValue(false),
      getEngineState: vi.fn().mockReturnValue('idle'),
      start: vi.fn().mockResolvedValue(undefined),
      sendRadioDisconnected: vi.fn(),
    };
    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => lifecycle as any,
      getEngineMode: () => 'digital',
    });
    bridge.wasRunningBeforeDisconnect = true;
    bridge.setupListeners();

    radioManager.emit('connected');
    await vi.waitFor(() => expect(radioManager.getRadioInfo).toHaveBeenCalledTimes(1));
    sessionCurrent = false;
    radioInfo.resolve({ manufacturer: 'ICOM', model: 'IC-9700' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(radioStatusChanged).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    expect(radioManager.getTunerCapabilities).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  it('does not retry engine restore on audio failure (handled by AudioSidecarController)', async () => {
    vi.useFakeTimers();

    const radioManager = createRadioManagerStub();
    let startAttempts = 0;
    const lifecycle = {
      getIsRunning: vi.fn().mockReturnValue(false),
      getEngineState: vi.fn().mockReturnValue('idle'),
      start: vi.fn(async () => {
        startAttempts += 1;
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

    // RadioBridge now surfaces engine start failures directly to logs and
    // clears the pending-restore flag. Audio-device retries are owned by
    // AudioSidecarController and never loop back through RadioBridge.
    expect(startAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(startAttempts).toBe(1);
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
    radioManager.emit('radioFrequencyChanged', 14270000, {
      profileId: 'profile-a',
      sessionGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastVoiceFrequency).toHaveBeenCalledWith({
      frequency: 14270000,
      radioMode: 'USB',
      band: '20m',
      description: '14.270 MHz 20m Calling',
    }, 'profile-a');
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
    radioManager.emit('radioFrequencyChanged', 14123456, {
      profileId: 'profile-a',
      sessionGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastVoiceFrequency).toHaveBeenCalledWith({
      frequency: 14123456,
      radioMode: 'USB',
      band: '20m',
      description: '14.123 MHz 20m',
    }, 'profile-a');
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14123456,
      mode: 'VOICE',
      band: '20m',
      radioMode: 'USB',
      source: 'radio',
    }));
  });

  it('persists custom CW frequencies without overwriting digital history', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);

    const configManager = ConfigManager.getInstance();
    const updateLastCWFrequency = vi.spyOn(configManager, 'updateLastCWFrequency').mockResolvedValue();
    const updateLastSelectedFrequency = vi.spyOn(configManager, 'updateLastSelectedFrequency').mockResolvedValue();
    vi.spyOn(configManager, 'getLastCWFrequency').mockReturnValue({
      frequency: 7030000,
      radioMode: 'CW',
      band: '40m',
      description: '7.030 MHz 40m',
    });

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: {
        getPresets: vi.fn().mockReturnValue([
          { frequency: 7074000, mode: 'FT8', band: '40m', radioMode: 'USB', description: '7.074 MHz 40m' },
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
      getEngineMode: () => 'cw',
      getCurrentModeName: () => 'CW',
    });

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 7035000, {
      profileId: 'profile-a',
      sessionGeneration: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastCWFrequency).toHaveBeenCalledWith({
      frequency: 7035000,
      radioMode: 'CW',
      band: '40m',
      description: '7.035 MHz 40m',
    }, 'profile-a');
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 7035000,
      mode: 'CW',
      band: '40m',
      radioMode: 'CW',
      source: 'radio',
    }));
  });

  it('drops radio events from a stale Profile session before persistence or broadcast', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);

    const configManager = ConfigManager.getInstance();
    const updateLastSelectedFrequency = vi.spyOn(configManager, 'updateLastSelectedFrequency').mockResolvedValue();
    const updateLastVoiceFrequency = vi.spyOn(configManager, 'updateLastVoiceFrequency').mockResolvedValue();
    const updateLastCWFrequency = vi.spyOn(configManager, 'updateLastCWFrequency').mockResolvedValue();

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: {
        getPresets: vi.fn().mockReturnValue([]),
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
      getEngineMode: () => 'digital',
      getCurrentModeName: () => 'FT4',
    });

    vi.spyOn(configManager, 'getActiveProfileId').mockReturnValue('profile-new');

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 7047500, {
      profileId: 'profile-old',
      sessionGeneration: 7,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(updateLastVoiceFrequency).not.toHaveBeenCalled();
    expect(updateLastCWFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).not.toHaveBeenCalled();
  });

  it('drops global side effects when the radio session changes during persistence', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    const clearInMemory = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);

    const persistence = createDeferred<void>();
    const configManager = ConfigManager.getInstance();
    const updateLastSelectedFrequency = vi.spyOn(configManager, 'updateLastSelectedFrequency')
      .mockReturnValueOnce(persistence.promise);

    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: {
        getPresets: vi.fn().mockReturnValue([
          { frequency: 14074000, mode: 'FT8', band: '20m', radioMode: 'USB', description: '14.074 MHz 20m' },
        ]),
      } as any,
      slotPackManager: { clearInMemory } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({
        getIsRunning: vi.fn().mockReturnValue(false),
        getEngineState: vi.fn().mockReturnValue('idle'),
        start: vi.fn(),
        sendRadioDisconnected: vi.fn(),
      } as any),
      getEngineMode: () => 'digital',
      getCurrentModeName: () => 'FT8',
    });

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 14074000, {
      profileId: 'profile-a',
      sessionGeneration: 1,
    });
    await vi.waitFor(() => {
      expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
        frequency: 14074000,
      }), 'profile-a');
    });

    radioManager.isCurrentRadioSessionContext.mockReturnValue(false);
    persistence.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(radioManager.isCurrentRadioSessionContext).toHaveBeenCalledTimes(2);
    expect(clearInMemory).not.toHaveBeenCalled();
    expect(frequencyChanged).not.toHaveBeenCalled();
  });
});
