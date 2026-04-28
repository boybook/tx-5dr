import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { EngineState } from '../state-machines/types.js';

describe('DigitalRadioEngine mode switching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
});
