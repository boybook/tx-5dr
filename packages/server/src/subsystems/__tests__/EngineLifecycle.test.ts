import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { EngineLifecycle } from '../EngineLifecycle.js';
import { ConfigManager } from '../../config/config-manager.js';

function createLifecycle(initialModeName: 'FT8' | 'VOICE' | 'CW' = 'FT8') {
  let currentModeName = initialModeName;
  const resourceManager = {
    stopAll: vi.fn(async () => undefined),
    clear: vi.fn(),
    register: vi.fn(),
  };
  const voiceSessionManager = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const decodeQueue = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };

  const audioSidecar = {
    start: vi.fn(),
    stop: vi.fn(),
    isConnected: () => false,
    getStatus: () => 'idle',
    buildStatusPayload: () => ({
      status: 'idle',
      isConnected: false,
      retryAttempt: 0,
      nextRetryMs: null,
      longRunning: false,
      lastError: null,
      deviceName: null,
    }),
  };

  vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
    getCWDecoderConfig: vi.fn(() => ({ enabled: false })),
  } as unknown as ConfigManager);

  const lifecycle = new EngineLifecycle({
    engineEmitter: new EventEmitter(),
    resourceManager: resourceManager as any,
    slotClock: {} as any,
    slotScheduler: {} as any,
    audioStreamManager: {} as any,
    radioManager: {} as any,
    spectrumScheduler: {} as any,
    decodeQueue: decodeQueue as any,
    operatorManager: {} as any,
    audioMixer: {} as any,
    clockSource: {} as any,
    subsystems: {
      transmissionPipeline: { forceStopPTT: vi.fn() } as any,
      clockCoordinator: {} as any,
    },
    getCurrentMode: () => ({ name: currentModeName } as any),
    getVoiceSessionManager: () => voiceSessionManager as any,
    getCWKeyerManager: () => ({ start: vi.fn(), stop: vi.fn() } as any),
    getCWDecoderManager: () => ({ start: vi.fn(), stop: vi.fn(), getConfig: () => ({}) } as any),
    getAudioVolumeController: () => ({ restoreGainForCurrentSlot: vi.fn() } as any),
    getAudioSidecar: () => audioSidecar as any,
    getStatus: () => ({}),
  });

  return {
    lifecycle,
    resourceManager,
    decodeQueue,
    setModeName: (modeName: 'FT8' | 'VOICE' | 'CW') => {
      currentModeName = modeName;
    },
  };
}

describe('EngineLifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rebuilds the digital resource plan from a single lifecycle entrypoint', async () => {
    const { lifecycle, resourceManager } = createLifecycle('FT8');

    await lifecycle.rebuildResourcePlan();

    expect(resourceManager.stopAll).toHaveBeenCalledTimes(1);
    expect(resourceManager.clear).toHaveBeenCalledTimes(1);
    expect(resourceManager.register.mock.calls.map(([config]) => config.name)).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'decodeWorkerPool',
      'clock',
      'slotScheduler',
      'spectrumScheduler',
      'operatorManager',
    ]);
  });

  it('reuses the same rebuild path when switching to the voice resource plan', async () => {
    const { lifecycle, resourceManager, setModeName } = createLifecycle('FT8');

    await lifecycle.rebuildResourcePlan();
    setModeName('VOICE');
    await lifecycle.rebuildResourcePlan();

    expect(resourceManager.stopAll).toHaveBeenCalledTimes(2);
    expect(resourceManager.clear).toHaveBeenCalledTimes(2);
    const firstPlanCount = 8; // radio + icom + openwebrx + decodeWorkerPool + clock + slotScheduler + spectrumScheduler + operatorManager
    const secondPlanNames = resourceManager.register.mock.calls
      .slice(firstPlanCount)
      .map(([config]) => config.name);

    expect(secondPlanNames).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'spectrumScheduler',
      'voiceSessionManager',
    ]);
  });

  it('starts and stops decode workers through the digital resource plan', async () => {
    const { lifecycle, resourceManager, decodeQueue } = createLifecycle('FT8');

    await lifecycle.rebuildResourcePlan();
    const decodeResource = resourceManager.register.mock.calls
      .map(([config]) => config)
      .find((config) => config.name === 'decodeWorkerPool');
    const slotSchedulerResource = resourceManager.register.mock.calls
      .map(([config]) => config)
      .find((config) => config.name === 'slotScheduler');

    expect(decodeResource).toEqual(expect.objectContaining({
      priority: 5,
      dependencies: [],
    }));
    expect(slotSchedulerResource).toEqual(expect.objectContaining({
      dependencies: ['decodeWorkerPool', 'clock'],
    }));

    await decodeResource.start();
    await decodeResource.stop();

    expect(decodeQueue.start).toHaveBeenCalledWith('digital-engine-start');
    expect(decodeQueue.stop).toHaveBeenCalledWith('digital-engine-stop');
  });

  it('does not include decode workers in the voice resource plan', async () => {
    const { lifecycle, resourceManager } = createLifecycle('VOICE');

    await lifecycle.rebuildResourcePlan();

    const names = resourceManager.register.mock.calls.map(([config]) => config.name);
    expect(names).not.toContain('decodeWorkerPool');
    expect(names).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'spectrumScheduler',
      'voiceSessionManager',
    ]);
  });

  it('uses the CW resource plan without digital decode, slot, or operator resources', async () => {
    const { lifecycle, resourceManager } = createLifecycle('CW');

    await lifecycle.rebuildResourcePlan();

    const names = resourceManager.register.mock.calls.map(([config]) => config.name);
    expect(names).toEqual([
      'radio',
      'icomWlanAudioAdapter',
      'openwebrxAudioAdapter',
      'spectrumScheduler',
    ]);
    expect(names).not.toContain('decodeWorkerPool');
    expect(names).not.toContain('clock');
    expect(names).not.toContain('slotScheduler');
    expect(names).not.toContain('operatorManager');
  });
});
