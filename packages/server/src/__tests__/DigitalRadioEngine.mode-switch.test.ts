import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODES, type DigitalModeRadioModePreference } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { EngineState } from '../state-machines/types.js';

describe('DigitalRadioEngine mode switching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createDigitalSwitchHarness(options: {
    initialMode?: typeof MODES.FT8 | typeof MODES.FT4;
    knownFrequency?: number | null;
    lastFrequency?: { frequency: number; mode?: string } | null;
    radioConnected?: boolean;
    digitalModeRadioMode?: DigitalModeRadioModePreference;
    customFrequencyPresets?: Array<{
      frequency: number;
      mode: string;
      band: string;
      radioMode?: string;
      description?: string;
    }> | null;
  } = {}) {
    const applyOperatingState = vi.fn(async () => ({
      frequencyApplied: true,
      modeApplied: true,
    }));
    const updateLastSelectedFrequency = vi.fn(async () => undefined);
    const setLastDigitalModeName = vi.fn(async () => undefined);
    const emit = vi.fn();
    const clearInMemory = vi.fn();
    const operatorSetMode = vi.fn();

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getCustomFrequencyPresets: vi.fn(() => options.customFrequencyPresets ?? null),
      getLastSelectedFrequency: vi.fn(() => options.lastFrequency ?? null),
      getRadioConfig: vi.fn(() => ({ type: 'none', digitalModeRadioMode: options.digitalModeRadioMode })),
      updateLastSelectedFrequency,
      setLastDigitalModeName,
      getDecodeWindowSettings: vi.fn(() => ({})),
    } as unknown as ConfigManager);

    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      modeSwitchTail: Promise.resolve(),
      engineMode: 'digital',
      currentMode: options.initialMode ?? MODES.FT8,
      stopTuneTone: vi.fn(async () => undefined),
      radioManager: {
        getKnownFrequency: vi.fn(() => options.knownFrequency ?? null),
        isConnected: vi.fn(() => options.radioConnected ?? true),
        applyOperatingState,
        applyRepeaterDuplexConfig: vi.fn(async () => ({ warning: false })),
        applyToneSquelchConfig: vi.fn(async () => ({ warning: false })),
      },
      applyDecodeWindowOverrides: vi.fn(() => undefined),
      slotClock: {
        setMode: vi.fn(() => undefined),
      },
      slotPackManager: {
        setMode: vi.fn(() => undefined),
        clearInMemory,
      },
      clockCoordinator: {
        onModeChanged: vi.fn(() => undefined),
      },
      _operatorManager: {
        getAllOperators: vi.fn(() => [{ setMode: operatorSetMode }]),
      },
      emit,
      emitModeAndStatusSnapshot: vi.fn(() => undefined),
      emitStatusSnapshot: vi.fn(() => undefined),
    });

    return {
      fakeEngine,
      applyOperatingState,
      updateLastSelectedFrequency,
      setLastDigitalModeName,
      emit,
      clearInMemory,
      operatorSetMode,
    };
  }

  it('waits for startup to settle before rebuilding the resource plan', async () => {
    const sequence: string[] = [];
    let engineState = EngineState.STARTING;

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      setLastEngineMode: vi.fn(async () => {
        sequence.push('setLastEngineMode');
      }),
      setLastDigitalModeName: vi.fn(async () => {
        sequence.push('setLastDigitalModeName');
      }),
    } as unknown as ConfigManager);

    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      engineMode: 'digital',
      currentMode: MODES.FT8,
      radioBridge: { wasRunningBeforeDisconnect: true },
      engineLifecycle: {
        getEngineState: vi.fn(() => engineState),
        waitForStartupToSettle: vi.fn(async () => {
          sequence.push('waitForStartupToSettle');
          engineState = EngineState.RUNNING;
          return EngineState.RUNNING;
        }),
        stop: vi.fn(async () => {
          sequence.push('engineLifecycle.stop');
        }),
        rebuildResourcePlan: vi.fn(() => {
          sequence.push('rebuildResourcePlan');
        }),
        startAndWaitForRunning: vi.fn(async () => {
          sequence.push('startAndWaitForRunning');
          engineState = EngineState.RUNNING;
        }),
      },
      stop: vi.fn(async () => {
        sequence.push('stop');
        engineState = EngineState.IDLE;
      }),
      applyDecodeWindowOverrides: vi.fn(() => {
        sequence.push('applyDecodeWindowOverrides');
      }),
      slotClock: {
        setMode: vi.fn(() => {
          sequence.push('slotClock.setMode');
        }),
      },
      slotPackManager: {
        setMode: vi.fn(() => {
          sequence.push('slotPackManager.setMode');
        }),
      },
      clockCoordinator: {
        onModeChanged: vi.fn(() => {
          sequence.push('clockCoordinator.onModeChanged');
        }),
      },
      emitModeAndStatusSnapshot: vi.fn(() => {
        sequence.push('emitModeAndStatusSnapshot');
      }),
      emitStatusSnapshot: vi.fn(() => {
        sequence.push('emitStatusSnapshot');
      }),
      restoreLastVoiceOperatingState: vi.fn(async () => {
        sequence.push('restoreLastVoiceOperatingState');
      }),
      resetVoicePttState: vi.fn(() => {
        sequence.push('resetVoicePttState');
      }),
      squelchStatusMonitor: {
        reevaluate: vi.fn(() => {
          sequence.push('squelchStatusMonitor.reevaluate');
        }),
      },
      physicalPttMonitor: {
        reevaluate: vi.fn(() => {
          sequence.push('physicalPttMonitor.reevaluate');
        }),
      },
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'digital' | 'voice', targetMode: typeof MODES.VOICE) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'voice', MODES.VOICE);

    expect(fakeEngine.engineLifecycle.waitForStartupToSettle).toHaveBeenCalledOnce();
    expect(fakeEngine.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(sequence.indexOf('waitForStartupToSettle')).toBeLessThan(sequence.indexOf('rebuildResourcePlan'));
    expect(sequence.indexOf('stop')).toBeLessThan(sequence.indexOf('rebuildResourcePlan'));
  });

  it('skips restart when startup settles back to idle', async () => {
    let engineState = EngineState.STARTING;

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      setLastEngineMode: vi.fn(async () => undefined),
      setLastDigitalModeName: vi.fn(async () => undefined),
    } as unknown as ConfigManager);

    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      engineMode: 'digital',
      currentMode: MODES.FT8,
      radioBridge: { wasRunningBeforeDisconnect: true },
      engineLifecycle: {
        getEngineState: vi.fn(() => engineState),
        waitForStartupToSettle: vi.fn(async () => {
          engineState = EngineState.IDLE;
          return EngineState.IDLE;
        }),
        stop: vi.fn(async () => undefined),
        rebuildResourcePlan: vi.fn(() => undefined),
        startAndWaitForRunning: vi.fn(async () => undefined),
      },
      stop: vi.fn(async () => undefined),
      applyDecodeWindowOverrides: vi.fn(() => undefined),
      slotClock: null,
      slotPackManager: {
        setMode: vi.fn(() => undefined),
      },
      clockCoordinator: null,
      emitModeAndStatusSnapshot: vi.fn(() => undefined),
      emitStatusSnapshot: vi.fn(() => undefined),
      restoreLastVoiceOperatingState: vi.fn(async () => undefined),
      resetVoicePttState: vi.fn(() => undefined),
      squelchStatusMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
      physicalPttMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'digital' | 'voice', targetMode: typeof MODES.VOICE) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'voice', MODES.VOICE);

    expect(fakeEngine.stop).not.toHaveBeenCalled();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).not.toHaveBeenCalled();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
  });


  function createEngineModeSwitchHarness(options: {
    initialEngineMode: 'digital' | 'voice' | 'cw';
    initialMode: typeof MODES.FT8 | typeof MODES.FT4 | typeof MODES.VOICE | typeof MODES.CW;
    engineState: EngineState;
  }) {
    let engineState = options.engineState;
    const sequence: string[] = [];
    const setLastEngineMode = vi.fn(async () => undefined);
    const setLastDigitalModeName = vi.fn(async () => undefined);

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      setLastEngineMode,
      setLastDigitalModeName,
    } as unknown as ConfigManager);

    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      engineMode: options.initialEngineMode,
      currentMode: options.initialMode,
      radioBridge: { wasRunningBeforeDisconnect: true },
      engineLifecycle: {
        preserveRadioConnection: false,
        getEngineState: vi.fn(() => engineState),
        waitForStartupToSettle: vi.fn(async () => engineState),
        stop: vi.fn(async () => undefined),
        rebuildResourcePlan: vi.fn(async () => {
          sequence.push('rebuildResourcePlan');
        }),
        startAndWaitForRunning: vi.fn(async () => {
          sequence.push('startAndWaitForRunning');
          engineState = EngineState.RUNNING;
        }),
      },
      stop: vi.fn(async () => {
        sequence.push('stop');
        engineState = EngineState.IDLE;
      }),
      stopCWDecoderRuntime: vi.fn(async (reason: string) => {
        sequence.push(`stopCWDecoderRuntime:${reason}`);
      }),
      applyDecodeWindowOverrides: vi.fn(() => undefined),
      slotClock: {
        setMode: vi.fn(() => undefined),
      },
      slotPackManager: {
        setMode: vi.fn(() => undefined),
      },
      clockCoordinator: {
        onModeChanged: vi.fn(() => undefined),
      },
      _operatorManager: {
        getAllOperators: vi.fn(() => []),
      },
      emitModeAndStatusSnapshot: vi.fn(() => undefined),
      emitStatusSnapshot: vi.fn(() => undefined),
      restoreLastVoiceOperatingState: vi.fn(async () => undefined),
      restoreLastCWOperatingState: vi.fn(async () => undefined),
      restoreLastDigitalOperatingState: vi.fn(async () => undefined),
      resetVoicePttState: vi.fn(() => undefined),
      squelchStatusMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
      physicalPttMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
    });

    return { fakeEngine, sequence, setLastEngineMode, setLastDigitalModeName };
  }

  it('keeps the engine running when switching from running FT8 to CW', async () => {
    const { fakeEngine, sequence, setLastEngineMode } = createEngineModeSwitchHarness({
      initialEngineMode: 'digital',
      initialMode: MODES.FT8,
      engineState: EngineState.RUNNING,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'cw', targetMode: typeof MODES.CW) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'cw', MODES.CW);

    expect(fakeEngine.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(fakeEngine.emitStatusSnapshot).toHaveBeenCalledOnce();
    expect(fakeEngine.restoreLastCWOperatingState).toHaveBeenCalledOnce();
    expect(setLastEngineMode).toHaveBeenCalledWith('cw');
    expect(fakeEngine.stopCWDecoderRuntime).not.toHaveBeenCalled();
    expect(sequence).toEqual(['stop', 'rebuildResourcePlan', 'startAndWaitForRunning']);
  });

  it('does not start the engine when switching from idle FT8 to CW', async () => {
    const { fakeEngine } = createEngineModeSwitchHarness({
      initialEngineMode: 'digital',
      initialMode: MODES.FT8,
      engineState: EngineState.IDLE,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'cw', targetMode: typeof MODES.CW) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'cw', MODES.CW);

    expect(fakeEngine.stop).not.toHaveBeenCalled();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).not.toHaveBeenCalled();
    expect(fakeEngine.emitStatusSnapshot).not.toHaveBeenCalled();
    expect(fakeEngine.restoreLastCWOperatingState).toHaveBeenCalledOnce();
    expect(fakeEngine.stopCWDecoderRuntime).not.toHaveBeenCalled();
  });

  it('stops the CW decoder worker runtime when switching from running CW to FT8', async () => {
    const { fakeEngine, setLastDigitalModeName } = createEngineModeSwitchHarness({
      initialEngineMode: 'cw',
      initialMode: MODES.CW,
      engineState: EngineState.RUNNING,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'digital', targetMode: typeof MODES.FT8) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'digital', MODES.FT8);

    expect(fakeEngine.stopCWDecoderRuntime).toHaveBeenCalledWith('leaving-cw-mode');
    expect(fakeEngine.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.applyDecodeWindowOverrides).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(setLastDigitalModeName).toHaveBeenCalledWith('FT8');
  });

  it('stops the CW decoder worker runtime when switching from running CW to voice', async () => {
    const { fakeEngine } = createEngineModeSwitchHarness({
      initialEngineMode: 'cw',
      initialMode: MODES.CW,
      engineState: EngineState.RUNNING,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'voice', targetMode: typeof MODES.VOICE) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'voice', MODES.VOICE);

    expect(fakeEngine.stopCWDecoderRuntime).toHaveBeenCalledWith('leaving-cw-mode');
    expect(fakeEngine.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(fakeEngine.restoreLastVoiceOperatingState).toHaveBeenCalledOnce();
  });

  it('does not start the engine when switching from idle CW to FT8 or voice', async () => {
    for (const target of [
      { engineMode: 'digital' as const, mode: MODES.FT8 },
      { engineMode: 'voice' as const, mode: MODES.VOICE },
    ]) {
      vi.restoreAllMocks();
      const { fakeEngine } = createEngineModeSwitchHarness({
        initialEngineMode: 'cw',
        initialMode: MODES.CW,
        engineState: EngineState.IDLE,
      });

      await (DigitalRadioEngine.prototype as unknown as {
        switchEngineMode: (targetEngineMode: 'digital' | 'voice', targetMode: typeof MODES.FT8 | typeof MODES.VOICE) => Promise<void>;
      }).switchEngineMode.call(fakeEngine, target.engineMode, target.mode);

      expect(fakeEngine.stop).not.toHaveBeenCalled();
      expect(fakeEngine.stopCWDecoderRuntime).toHaveBeenCalledWith('leaving-cw-mode');
      expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
      expect(fakeEngine.engineLifecycle.startAndWaitForRunning).not.toHaveBeenCalled();
    }
  });

  it('routes startCWDecoder through the CW decoder runtime reconciler', async () => {
    const savedConfig = {
      enabled: false,
      backend: 'deepcw-onnx',
      runtimeBackend: 'cpu',
      modelSize: 'tiny',
      language: 'en',
      mode: 'streaming',
      targetFreqHz: 800,
      filterWidthHz: 800,
      windowSeconds: 12,
      decodeIntervalMs: 1000,
      muteWhileTransmitting: true,
      workerCount: 1,
      minCommitChars: 1,
      commitStability: 2,
      maxPendingAgeMs: 4000,
    };
    const expectedStatus = { enabled: true, state: 'listening' };
    const fakeEngine = {
      updateCWDecoderConfig: vi.fn(async () => savedConfig),
      startCWDecoderRuntime: vi.fn(async () => expectedStatus),
    };

    const status = await (DigitalRadioEngine.prototype as unknown as {
      startCWDecoder: (update?: Record<string, unknown>) => Promise<unknown>;
    }).startCWDecoder.call(fakeEngine, { enabled: true, modelSize: 'small' });

    expect(fakeEngine.updateCWDecoderConfig).toHaveBeenCalledWith({ modelSize: 'small' });
    expect(fakeEngine.startCWDecoderRuntime).toHaveBeenCalledWith({ ...savedConfig, enabled: true }, 'cw-decoder-start');
    expect(status).toBe(expectedStatus);
  });

  it('startCWDecoderRuntime switches to CW, starts the engine if needed, and starts the manager', async () => {
    const manager = {
      start: vi.fn(async () => undefined),
    };
    const expectedStatus = { enabled: true, state: 'listening' };
    const fakeEngine = {
      engineMode: 'digital',
      cwDecoderStartedEngine: false,
      setMode: vi.fn(async () => undefined),
      configureAudioProcessingForCurrentMode: vi.fn(),
      engineLifecycle: {
        getIsRunning: vi.fn(() => false),
        startAndWaitForRunning: vi.fn(async () => undefined),
      },
      getCWDecoderManager: vi.fn(() => manager),
      toServerCWDecoderConfig: vi.fn((config) => ({ ...config, server: true })),
      emitStatusSnapshot: vi.fn(),
      getCWDecoderStatus: vi.fn(() => expectedStatus),
    };

    const status = await (DigitalRadioEngine.prototype as unknown as {
      startCWDecoderRuntime: (config: Record<string, unknown>, reason: string) => Promise<unknown>;
    }).startCWDecoderRuntime.call(fakeEngine, { enabled: true }, 'cw-decoder-start');

    expect(fakeEngine.setMode).toHaveBeenCalledWith(MODES.CW);
    expect(fakeEngine.configureAudioProcessingForCurrentMode).toHaveBeenCalledWith('cw-decoder-start');
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(fakeEngine.cwDecoderStartedEngine).toBe(true);
    expect(manager.start).toHaveBeenCalledWith({ enabled: true, server: true });
    expect(fakeEngine.emitStatusSnapshot).toHaveBeenCalledOnce();
    expect(status).toBe(expectedStatus);
  });

  it('stopCWDecoder stops the runtime and stops the engine only when the decoder started it', async () => {
    const savedConfig = {
      enabled: false,
      backend: 'deepcw-onnx',
      runtimeBackend: 'cpu',
      modelSize: 'tiny',
      language: 'en',
      mode: 'streaming',
      targetFreqHz: 800,
      filterWidthHz: 800,
      windowSeconds: 12,
      decodeIntervalMs: 1000,
      muteWhileTransmitting: true,
      workerCount: 1,
      minCommitChars: 1,
      commitStability: 2,
      maxPendingAgeMs: 4000,
    };
    const expectedStatus = { enabled: false, state: 'disabled' };
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      updateCWDecoderConfig: vi.fn(async () => savedConfig),
    } as unknown as ConfigManager);
    const fakeEngine = {
      cwDecoderStartedEngine: true,
      engineMode: 'cw',
      stopCWDecoderRuntime: vi.fn(async () => undefined),
      engineLifecycle: {
        stop: vi.fn(async () => undefined),
      },
      emitStatusSnapshot: vi.fn(),
      getCWDecoderManager: vi.fn(() => ({ getStatus: vi.fn(() => ({ state: 'stopped' })) })),
      toContractCWDecoderStatus: vi.fn(() => expectedStatus),
    };

    const status = await (DigitalRadioEngine.prototype as unknown as {
      stopCWDecoder: () => Promise<unknown>;
    }).stopCWDecoder.call(fakeEngine);

    expect(fakeEngine.stopCWDecoderRuntime).toHaveBeenCalledWith('user-disabled', savedConfig);
    expect(fakeEngine.engineLifecycle.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.cwDecoderStartedEngine).toBe(false);
    expect(fakeEngine.emitStatusSnapshot).toHaveBeenCalledOnce();
    expect(status).toBe(expectedStatus);
  });

  it('restores voice frequency and radio mode when entering voice mode', async () => {
    const applyOperatingState = vi.fn(async () => ({
      frequencyApplied: true,
      modeApplied: true,
    }));
    const emit = vi.fn();
    const configManager = {
      getLastVoiceFrequency: vi.fn(() => ({
        frequency: 14270000,
        radioMode: 'USB',
        band: '20m',
        description: '14.270 MHz 20m Calling',
      })),
    };
    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      radioManager: {
        isConnected: vi.fn(() => true),
        applyOperatingState,
        applyRepeaterDuplexConfig: vi.fn(async () => ({ warning: false })),
        applyToneSquelchConfig: vi.fn(async () => ({ warning: false })),
      },
      emit,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      restoreLastVoiceOperatingState: (configManager: ConfigManager) => Promise<void>;
    }).restoreLastVoiceOperatingState.call(fakeEngine, configManager as unknown as ConfigManager);

    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 14270000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'voice' },
      tolerateModeFailure: true,
    });
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      frequency: 14270000,
      mode: 'VOICE',
      radioMode: 'USB',
      source: 'program',
    }));
  });

  it('restores CW frequency and radio mode when entering CW mode', async () => {
    const applyOperatingState = vi.fn(async () => ({
      frequencyApplied: true,
      modeApplied: true,
    }));
    const emit = vi.fn();
    const configManager = {
      getLastCWFrequency: vi.fn(() => ({
        frequency: 7030000,
        radioMode: 'CW',
        band: '40m',
        description: '7.030 MHz 40m',
      })),
    };
    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      radioManager: {
        isConnected: vi.fn(() => true),
        applyOperatingState,
      },
      emit,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      restoreLastCWOperatingState: (configManager: ConfigManager) => Promise<void>;
    }).restoreLastCWOperatingState.call(fakeEngine, configManager as unknown as ConfigManager);

    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 7030000,
      mode: 'CW',
      bandwidth: 'nochange',
      options: { intent: 'cw' },
      tolerateModeFailure: true,
    });
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      frequency: 7030000,
      mode: 'CW',
      radioMode: 'CW',
      source: 'program',
    }));
  });

  it('restores saved digital frequency when returning from CW to the same digital mode', async () => {
    const applyOperatingState = vi.fn(async () => ({
      frequencyApplied: true,
      modeApplied: true,
    }));
    const updateLastSelectedFrequency = vi.fn(async () => undefined);
    const emit = vi.fn();
    const configManager = {
      getLastSelectedFrequency: vi.fn(() => ({
        frequency: 14074000,
        mode: 'FT8',
        radioMode: 'USB',
        band: '20m',
        description: '14.074 MHz 20m',
      })),
      getCustomFrequencyPresets: vi.fn(() => null),
      getRadioConfig: vi.fn(() => ({ type: 'none' })),
      updateLastSelectedFrequency,
    };
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue(configManager as unknown as ConfigManager);
    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      radioManager: {
        isConnected: vi.fn(() => true),
        applyOperatingState,
        applyRepeaterDuplexConfig: vi.fn(async () => ({ warning: false })),
        applyToneSquelchConfig: vi.fn(async () => ({ warning: false })),
      },
      slotPackManager: { clearInMemory: vi.fn() },
      emit,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      restoreLastDigitalOperatingState: (configManager: ConfigManager, targetMode: typeof MODES.FT8) => Promise<void>;
    }).restoreLastDigitalOperatingState.call(fakeEngine, configManager as unknown as ConfigManager, MODES.FT8);

    expect(applyOperatingState).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14074000,
      tolerateModeFailure: true,
    }));
    expect(applyOperatingState.mock.calls[0]?.[0]).not.toHaveProperty('mode');
    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14074000,
      mode: 'FT8',
    }));
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      frequency: 14074000,
      mode: 'FT8',
      source: 'program',
    }));
  });

  it('uses nearest target digital preset when returning to a different digital mode', async () => {
    const applyOperatingState = vi.fn(async () => ({
      frequencyApplied: true,
      modeApplied: true,
    }));
    const configManager = {
      getLastSelectedFrequency: vi.fn(() => ({
        frequency: 14074000,
        mode: 'FT8',
        radioMode: 'USB',
        band: '20m',
        description: '14.074 MHz 20m',
      })),
      getCustomFrequencyPresets: vi.fn(() => null),
      getRadioConfig: vi.fn(() => ({ type: 'none' })),
      updateLastSelectedFrequency: vi.fn(async () => undefined),
    };
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue(configManager as unknown as ConfigManager);
    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      radioManager: {
        isConnected: vi.fn(() => true),
        applyOperatingState,
        applyRepeaterDuplexConfig: vi.fn(async () => ({ warning: false })),
        applyToneSquelchConfig: vi.fn(async () => ({ warning: false })),
      },
      slotPackManager: { clearInMemory: vi.fn() },
      emit: vi.fn(),
    });

    await (DigitalRadioEngine.prototype as unknown as {
      restoreLastDigitalOperatingState: (configManager: ConfigManager, targetMode: typeof MODES.FT4) => Promise<void>;
    }).restoreLastDigitalOperatingState.call(fakeEngine, configManager as unknown as ConfigManager, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14080000,
      tolerateModeFailure: true,
    }));
    expect(applyOperatingState.mock.calls[0]?.[0]).not.toHaveProperty('mode');
  });

  it('syncs restored FT4 mode to operators during startup restore', () => {
    const operatorSetMode = vi.fn();
    const slotClockSetMode = vi.fn();
    const slotPackSetMode = vi.fn();
    const onModeChanged = vi.fn();

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getLastEngineMode: vi.fn(() => 'digital'),
      getLastDigitalModeName: vi.fn(() => 'FT4'),
    } as unknown as ConfigManager);

    const fakeEngine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      engineMode: 'digital',
      currentMode: MODES.FT8,
      applyDecodeWindowOverrides: vi.fn(() => undefined),
      slotClock: { setMode: slotClockSetMode },
      slotPackManager: { setMode: slotPackSetMode },
      clockCoordinator: { onModeChanged },
      _operatorManager: {
        getAllOperators: vi.fn(() => [{ setMode: operatorSetMode }]),
      },
      configureAudioProcessingForCurrentMode: vi.fn(() => undefined),
    });

    (DigitalRadioEngine.prototype as unknown as {
      restorePersistedModePhase: () => void;
    }).restorePersistedModePhase.call(fakeEngine);

    expect(fakeEngine.currentMode.name).toBe('FT4');
    expect(slotClockSetMode).toHaveBeenCalledWith(MODES.FT4);
    expect(slotPackSetMode).toHaveBeenCalledWith(MODES.FT4);
    expect(onModeChanged).toHaveBeenCalledWith(MODES.FT4);
    expect(operatorSetMode).toHaveBeenCalledWith(MODES.FT4);
  });

  it('resyncs stale operators when setting the already-active FT4 mode', async () => {
    const { fakeEngine, applyOperatingState, setLastDigitalModeName, operatorSetMode } = createDigitalSwitchHarness({
      initialMode: MODES.FT4,
      knownFrequency: 14_080_000,
      radioConnected: true,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).not.toHaveBeenCalled();
    expect(setLastDigitalModeName).not.toHaveBeenCalled();
    expect(operatorSetMode).toHaveBeenCalledWith(MODES.FT4);
  });

  it('switches from FT8 to the nearest FT4 preset frequency', async () => {
    const { fakeEngine, applyOperatingState, updateLastSelectedFrequency, emit } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 14_074_000,
      radioConnected: true,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 14_080_000,
      tolerateModeFailure: true,
    });
    const savedFrequency = updateLastSelectedFrequency.mock.calls[0]?.[0];
    expect(savedFrequency).toMatchObject({
      frequency: 14_080_000,
      mode: 'FT4',
      band: '20m',
    });
    expect(savedFrequency).not.toHaveProperty('radioMode');
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      frequency: 14_080_000,
      mode: 'FT4',
      source: 'program',
      radioConnected: true,
    }));
  });

  it('switches from FT4 to the nearest FT8 preset frequency', async () => {
    const { fakeEngine, applyOperatingState } = createDigitalSwitchHarness({
      initialMode: MODES.FT4,
      knownFrequency: 14_080_000,
      radioConnected: true,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT8) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT8);

    expect(applyOperatingState).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14_074_000,
      tolerateModeFailure: true,
    }));
    expect(applyOperatingState.mock.calls[0]?.[0]).not.toHaveProperty('mode');
  });

  it('uses the active profile USB preference when switching digital preset frequency', async () => {
    const { fakeEngine, applyOperatingState, updateLastSelectedFrequency, emit } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 14_074_000,
      radioConnected: true,
      digitalModeRadioMode: 'usb',
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 14_080_000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'voice' },
      tolerateModeFailure: true,
    });
    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      radioMode: 'USB',
    }));
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      radioMode: 'USB',
    }));
  });

  it('uses the active profile USB-DATA preference when switching digital preset frequency', async () => {
    const { fakeEngine, applyOperatingState, updateLastSelectedFrequency, emit } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 14_074_000,
      radioConnected: true,
      digitalModeRadioMode: 'usb-data',
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith({
      frequency: 14_080_000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'digital' },
      tolerateModeFailure: true,
    });
    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      radioMode: 'USB-DATA',
    }));
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      radioMode: 'USB-DATA',
    }));
  });

  it('chooses the nearest target-mode preset instead of the first FT4 preset', async () => {
    const { fakeEngine, applyOperatingState } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 7_074_000,
      radioConnected: true,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 7_047_500,
    }));
  });

  it('chooses the lower frequency when nearest presets are tied', async () => {
    const { fakeEngine, applyOperatingState } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 14_075_000,
      radioConnected: true,
      customFrequencyPresets: [
        { frequency: 14_074_000, mode: 'FT4', band: '20m', radioMode: 'USB', description: 'low tie' },
        { frequency: 14_076_000, mode: 'FT4', band: '20m', radioMode: 'USB', description: 'high tie' },
      ],
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14_074_000,
    }));
  });

  it('records and broadcasts the nearest preset when radio is disconnected', async () => {
    const { fakeEngine, applyOperatingState, updateLastSelectedFrequency, emit } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: null,
      lastFrequency: { frequency: 14_074_000, mode: 'FT8' },
      radioConnected: false,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).not.toHaveBeenCalled();
    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14_080_000,
      mode: 'FT4',
      band: '20m',
    }));
    expect(emit).toHaveBeenCalledWith('frequencyChanged', expect.objectContaining({
      frequency: 14_080_000,
      mode: 'FT4',
      radioConnected: false,
    }));
  });

  it('switches digital mode without applying frequency when target mode has no presets', async () => {
    const { fakeEngine, applyOperatingState, updateLastSelectedFrequency, emit } = createDigitalSwitchHarness({
      initialMode: MODES.FT8,
      knownFrequency: 14_074_000,
      radioConnected: true,
      customFrequencyPresets: [
        { frequency: 14_074_000, mode: 'FT8', band: '20m', radioMode: 'USB', description: '14.074 MHz 20m' },
      ],
    });

    await (DigitalRadioEngine.prototype as unknown as {
      setMode: (mode: typeof MODES.FT4) => Promise<void>;
    }).setMode.call(fakeEngine, MODES.FT4);

    expect(applyOperatingState).not.toHaveBeenCalled();
    expect(updateLastSelectedFrequency).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('frequencyChanged', expect.anything());
    expect(fakeEngine.currentMode.name).toBe('FT4');
  });
});
