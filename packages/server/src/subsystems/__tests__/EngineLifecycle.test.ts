import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { EngineLifecycle } from '../EngineLifecycle.js';

function createLifecycle(initialModeName: 'FT8' | 'VOICE' = 'FT8') {
  let currentModeName = initialModeName;
  const resourceManager = {
    clear: vi.fn(),
    register: vi.fn(),
  };
  const voiceSessionManager = {
    start: vi.fn(),
    stop: vi.fn(),
  };

  const lifecycle = new EngineLifecycle({
    engineEmitter: new EventEmitter(),
    resourceManager: resourceManager as any,
    slotClock: {} as any,
    slotScheduler: {} as any,
    audioStreamManager: {} as any,
    radioManager: {} as any,
    spectrumScheduler: {} as any,
    operatorManager: {} as any,
    audioMixer: {} as any,
    clockSource: {} as any,
    subsystems: {
      transmissionPipeline: { forceStopPTT: vi.fn() } as any,
      clockCoordinator: {} as any,
    },
    getCurrentMode: () => ({ name: currentModeName } as any),
    getVoiceSessionManager: () => voiceSessionManager as any,
    getAudioVolumeController: () => ({ restoreGainForCurrentSlot: vi.fn() } as any),
    getStatus: () => ({}),
  });

  return {
    lifecycle,
    resourceManager,
    setModeName: (modeName: 'FT8' | 'VOICE') => {
      currentModeName = modeName;
    },
  };
}

describe('EngineLifecycle', () => {
  it('rebuilds the digital resource plan from a single lifecycle entrypoint', () => {
    const { lifecycle, resourceManager } = createLifecycle('FT8');

    lifecycle.rebuildResourcePlan();

    expect(resourceManager.clear).toHaveBeenCalledTimes(1);
    expect(resourceManager.register.mock.calls.map(([config]) => config.name)).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'audioInputStream',
      'audioOutputStream',
      'audioMonitorService',
      'clock',
      'slotScheduler',
      'spectrumScheduler',
      'operatorManager',
    ]);
  });

  it('reuses the same rebuild path when switching to the voice resource plan', () => {
    const { lifecycle, resourceManager, setModeName } = createLifecycle('FT8');

    lifecycle.rebuildResourcePlan();
    setModeName('VOICE');
    lifecycle.rebuildResourcePlan();

    expect(resourceManager.clear).toHaveBeenCalledTimes(2);
    const secondPlanNames = resourceManager.register.mock.calls
      .slice(10)
      .map(([config]) => config.name);

    expect(secondPlanNames).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'audioInputStream',
      'audioOutputStream',
      'audioMonitorService',
      'spectrumScheduler',
      'voiceSessionManager',
    ]);
  });
});
