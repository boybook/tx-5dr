import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '@tx5dr/contracts';
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

    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getCustomFrequencyPresets: vi.fn(() => options.customFrequencyPresets ?? null),
      getLastSelectedFrequency: vi.fn(() => options.lastFrequency ?? null),
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
        getAllOperators: vi.fn(() => []),
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

    const fakeEngine = {
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
    };

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

    const fakeEngine = {
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
    };

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

    const fakeEngine = {
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
      resetVoicePttState: vi.fn(() => undefined),
      squelchStatusMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
      physicalPttMonitor: {
        reevaluate: vi.fn(() => undefined),
      },
    };

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
  });

  it('keeps the engine running when switching from running CW to FT8', async () => {
    const { fakeEngine, setLastDigitalModeName } = createEngineModeSwitchHarness({
      initialEngineMode: 'cw',
      initialMode: MODES.CW,
      engineState: EngineState.RUNNING,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'digital', targetMode: typeof MODES.FT8) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'digital', MODES.FT8);

    expect(fakeEngine.stop).toHaveBeenCalledOnce();
    expect(fakeEngine.applyDecodeWindowOverrides).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
    expect(fakeEngine.engineLifecycle.startAndWaitForRunning).toHaveBeenCalledOnce();
    expect(setLastDigitalModeName).toHaveBeenCalledWith('FT8');
  });

  it('keeps the engine running when switching from running CW to voice', async () => {
    const { fakeEngine } = createEngineModeSwitchHarness({
      initialEngineMode: 'cw',
      initialMode: MODES.CW,
      engineState: EngineState.RUNNING,
    });

    await (DigitalRadioEngine.prototype as unknown as {
      switchEngineMode: (targetEngineMode: 'voice', targetMode: typeof MODES.VOICE) => Promise<void>;
    }).switchEngineMode.call(fakeEngine, 'voice', MODES.VOICE);

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
      expect(fakeEngine.engineLifecycle.rebuildResourcePlan).toHaveBeenCalledOnce();
      expect(fakeEngine.engineLifecycle.startAndWaitForRunning).not.toHaveBeenCalled();
    }
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
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'digital' },
      tolerateModeFailure: true,
    });
    expect(updateLastSelectedFrequency).toHaveBeenCalledWith(expect.objectContaining({
      frequency: 14_080_000,
      mode: 'FT4',
      band: '20m',
      radioMode: 'USB',
    }));
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
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'digital' },
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
