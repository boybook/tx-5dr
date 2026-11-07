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
    vi.restoreAllMocks();
  });

  it('holds Hamlib recovery while physical TX is uncertain and resumes once a retried release succeeds', async () => {
    vi.useFakeTimers();
    const radioManager = createRadioManagerStub();
    const operatorManager = { beginRadioRecovery: vi.fn(), confirmRadioRecovery: vi.fn(), cancelRadioRecovery: vi.fn(), stopAllOperators: vi.fn() };
    const lifecycle = { getIsRunning: vi.fn(() => true), getEngineState: vi.fn(() => 'running'), start: vi.fn(), sendRadioDisconnected: vi.fn() };
    let phase = 'unknown';
    const retryUnknownStop = vi.fn().mockResolvedValue({ success: false });
    const bridge = new RadioBridge({ engineEmitter: new EventEmitter() as any, radioManager: radioManager as any,
      frequencyManager: {} as any, slotPackManager: {} as any, operatorManager: operatorManager as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: () => false } as any),
      physicalTxCoordinator: { retryUnknownStop, getSnapshot: () => ({ phase }) } as any,
      getEngineLifecycle: () => lifecycle as any, getEngineMode: () => 'digital' });
    bridge.setupListeners();
    radioManager.emit('error', new RadioError({ code: RadioErrorCode.CONNECTION_LOST, message: 'worker stalled', context: { hamlibHostFatal: true } }));
    expect(operatorManager.beginRadioRecovery).toHaveBeenCalledTimes(1);
    radioManager.emit('connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(operatorManager.confirmRadioRecovery).not.toHaveBeenCalled();
    expect(operatorManager.cancelRadioRecovery).not.toHaveBeenCalled();
    // First retry still fails; the second succeeds and the flow continues.
    await vi.advanceTimersByTimeAsync(5000);
    expect(retryUnknownStop).toHaveBeenLastCalledWith('radio reconnected retry');
    expect(operatorManager.confirmRadioRecovery).not.toHaveBeenCalled();
    phase = 'idle';
    await vi.advanceTimersByTimeAsync(10000);
    expect(operatorManager.confirmRadioRecovery).toHaveBeenCalledTimes(1);
    expect(operatorManager.cancelRadioRecovery).not.toHaveBeenCalled();
    bridge.teardownListeners();
  });

  it('confirms Hamlib recovery while the restored engine is still starting and keeps it through restore cleanup', async () => {
    const radioManager = createRadioManagerStub();
    Object.assign(radioManager, { consumeIntentionalDisconnect: vi.fn(() => ({ active: false })) });
    const operatorManager = { beginRadioRecovery: vi.fn(), confirmRadioRecovery: vi.fn(), cancelRadioRecovery: vi.fn(), stopAllOperators: vi.fn() };
    let engineState = 'running';
    const lifecycle = {
      getIsRunning: vi.fn(() => engineState === 'running'),
      getEngineState: vi.fn(() => engineState),
      sendRadioDisconnected: vi.fn(() => { engineState = 'idle'; }),
      // Mirrors EngineLifecycle.start(): a failed previous stop is cleaned up
      // first (closing CAT), then START is accepted without waiting for RUNNING.
      start: vi.fn(async () => {
        radioManager.emit('disconnected', 'Engine stopped');
        engineState = 'starting';
      }),
    };
    const bridge = new RadioBridge({ engineEmitter: new EventEmitter() as any, radioManager: radioManager as any,
      frequencyManager: {} as any, slotPackManager: {} as any, operatorManager: operatorManager as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: () => false } as any),
      physicalTxCoordinator: { retryUnknownStop: vi.fn().mockResolvedValue(null), getSnapshot: () => ({ phase: 'idle' }) } as any,
      getEngineLifecycle: () => lifecycle as any, getEngineMode: () => 'digital' });
    bridge.setupListeners();

    radioManager.emit('error', new RadioError({ code: RadioErrorCode.CONNECTION_LOST, message: 'worker stalled', context: { hamlibHostFatal: true } }));
    radioManager.emit('reconnecting', 1, 5, 2000);
    await new Promise(resolve => setTimeout(resolve, 0));
    radioManager.emit('connected');
    await vi.waitFor(() => expect(operatorManager.confirmRadioRecovery).toHaveBeenCalledTimes(1));

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(operatorManager.stopAllOperators).toHaveBeenCalledWith(true);
    expect(operatorManager.stopAllOperators).not.toHaveBeenCalledWith(false);
    expect(operatorManager.cancelRadioRecovery).not.toHaveBeenCalled();
  });

  it('cancels Hamlib recovery when the engine is not restored after reconnect', async () => {
    const radioManager = createRadioManagerStub();
    const operatorManager = { beginRadioRecovery: vi.fn(), confirmRadioRecovery: vi.fn(), cancelRadioRecovery: vi.fn(), stopAllOperators: vi.fn() };
    const lifecycle = { getIsRunning: vi.fn(() => false), getEngineState: vi.fn(() => 'idle'), start: vi.fn(), sendRadioDisconnected: vi.fn() };
    const bridge = new RadioBridge({ engineEmitter: new EventEmitter() as any, radioManager: radioManager as any,
      frequencyManager: {} as any, slotPackManager: {} as any, operatorManager: operatorManager as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: () => false } as any),
      physicalTxCoordinator: { retryUnknownStop: vi.fn().mockResolvedValue(null), getSnapshot: () => ({ phase: 'idle' }) } as any,
      getEngineLifecycle: () => lifecycle as any, getEngineMode: () => 'digital' });
    bridge.setupListeners();
    radioManager.emit('connected');
    await vi.waitFor(() => expect(operatorManager.cancelRadioRecovery).toHaveBeenCalled());
    expect(operatorManager.confirmRadioRecovery).not.toHaveBeenCalled();
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

  it('projects each connection meter event once and refreshes observed meter capabilities', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const meterData = vi.fn();
    const radioStatusChanged = vi.fn();
    engineEmitter.on('meterData', meterData);
    engineEmitter.on('radioStatusChanged', radioStatusChanged);
    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({ getIsRunning: vi.fn().mockReturnValue(false) } as any),
      getEngineMode: () => 'digital',
    });
    bridge.setupListeners();
    const sample = {
      swr: null,
      alc: null,
      level: null,
      power: { raw: 10, percent: null, watts: 10, maxWatts: null },
    };
    radioManager.emit('meterData', sample);
    expect(meterData).toHaveBeenCalledTimes(1);
    expect(meterData).toHaveBeenCalledWith(sample);

    radioManager.emit('meterCapabilitiesChanged', {
      strength: true,
      swr: true,
      alc: false,
      power: true,
      powerWatts: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(radioStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
      meterCapabilities: {
        strength: true,
        swr: true,
        alc: false,
        power: true,
        powerWatts: true,
      },
    }));
  });

  it('retries an unknown physical TX release after the radio session reconnects', async () => {
    const radioManager = createRadioManagerStub();
    const retryUnknownStop = vi.fn().mockResolvedValue({
      success: true,
      reason: 'radio reconnected',
      physicalConfirmed: false,
    });

    const bridge = new RadioBridge({
      engineEmitter: new EventEmitter() as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(true) } as any),
      physicalTxCoordinator: { retryUnknownStop } as any,
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

    expect(retryUnknownStop).toHaveBeenCalledWith('radio reconnected');
  });

  it('does not restore automation while the physical TX lease remains unknown', async () => {
    const radioManager = createRadioManagerStub();
    const start = vi.fn();
    const retryUnknownStop = vi.fn().mockResolvedValue({
      success: false,
      reason: 'radio reconnected: PTT release unconfirmed',
      physicalConfirmed: true,
    });

    const bridge = new RadioBridge({
      engineEmitter: new EventEmitter() as any,
      radioManager: radioManager as any,
      frequencyManager: { findMatchingPreset: vi.fn() } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(true) } as any),
      physicalTxCoordinator: {
        retryUnknownStop,
        getSnapshot: vi.fn().mockReturnValue({ phase: 'unknown' }),
      } as any,
      getEngineLifecycle: () => ({
        getIsRunning: vi.fn().mockReturnValue(false),
        getEngineState: vi.fn().mockReturnValue('idle'),
        start,
        sendRadioDisconnected: vi.fn(),
      } as any),
      getEngineMode: () => 'digital',
    });

    bridge.wasRunningBeforeDisconnect = true;
    bridge.setupListeners();
    radioManager.emit('connected');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retryUnknownStop).toHaveBeenCalledWith('radio reconnected');
    expect(start).not.toHaveBeenCalled();
    expect(bridge.wasRunningBeforeDisconnect).toBe(true);
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
    radioManager.emit('radioFrequencyChanged', 7035000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastCWFrequency).toHaveBeenCalledWith({
      frequency: 7035000,
      radioMode: 'CW',
      band: '40m',
      description: '7.035 MHz 40m',
    });
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 7035000,
      mode: 'CW',
      band: '40m',
      radioMode: 'CW',
      source: 'radio',
    }));
  });

  it('uses the current digital mode for radio-origin digital frequency changes', async () => {
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

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 7047500);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 7047500,
      mode: 'FT4',
      band: '40m',
    }));
    expect(updateLastVoiceFrequency).not.toHaveBeenCalled();
    expect(updateLastCWFrequency).not.toHaveBeenCalled();
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 7047500,
      mode: 'FT4',
      source: 'radio',
    }));
  });

  it('drops stale radio frequency revisions after a newer event is queued', async () => {
    const radioManager = createRadioManagerStub();
    const engineEmitter = new EventEmitter();
    const frequencyChanged = vi.fn();
    engineEmitter.on('frequencyChanged', frequencyChanged);
    vi.spyOn(ConfigManager.getInstance(), 'updateLastSelectedFrequency').mockResolvedValue();
    const bridge = new RadioBridge({
      engineEmitter: engineEmitter as any,
      radioManager: radioManager as any,
      frequencyManager: { getPresets: vi.fn().mockReturnValue([]) } as any,
      slotPackManager: { clearInMemory: vi.fn() } as any,
      operatorManager: { stopAllOperators: vi.fn() } as any,
      getTransmissionPipeline: () => ({ getIsPTTActive: vi.fn().mockReturnValue(false) } as any),
      getEngineLifecycle: () => ({ getIsRunning: vi.fn().mockReturnValue(false) } as any),
      getEngineMode: () => 'digital',
      getCurrentModeName: () => 'FT4',
    });

    bridge.setupListeners();
    radioManager.emit('radioFrequencyChanged', 14_080_000, {
      revision: 2,
      connectionGeneration: 1,
      confirmation: 'confirmed',
    });
    radioManager.emit('radioFrequencyChanged', 14_074_000, {
      revision: 1,
      connectionGeneration: 1,
      confirmation: 'confirmed',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frequencyChanged).toHaveBeenCalledTimes(1);
    expect(frequencyChanged).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14_080_000,
      revision: 2,
    }));
  });
});
