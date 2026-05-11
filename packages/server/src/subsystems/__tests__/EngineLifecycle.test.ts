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
      'decodeWorkerPool',
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

    lifecycle.rebuildResourcePlan();
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

  it('does not include decode workers in the voice resource plan', () => {
    const { lifecycle, resourceManager } = createLifecycle('VOICE');

    lifecycle.rebuildResourcePlan();

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
});
