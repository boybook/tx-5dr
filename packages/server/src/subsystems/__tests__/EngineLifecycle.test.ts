import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { EngineLifecycle } from '../EngineLifecycle.js';
import { ConfigManager } from '../../config/config-manager.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';

const lifecycles: EngineLifecycle[] = [];

function createLifecycle(
  initialModeName: 'FT8' | 'VOICE' | 'CW' | 'SSTV' | 'FAX' = 'FT8',
) {
  let currentModeName = initialModeName;
  const resourceManager = {
    stopAll: vi.fn(async () => undefined),
    startAll: vi.fn(async () => undefined),
    clear: vi.fn(),
    register: vi.fn(),
  };
  const radioManager = {
    isConnected: vi.fn(() => true),
    applyConfig: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
  const voiceSessionManager = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const decodeQueue = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const setPTT = vi.fn(async (_active: boolean) => {});
  const physicalTxCoordinator = new PhysicalTxCoordinator({
    isRadioConnected: radioManager.isConnected,
    setPTT,
    playAudio: async () => {},
    stopCurrentPlayback: async () => 0,
  });
  const imageRadioService = { start: vi.fn(), stop: vi.fn() };

  const audioSidecar = {
    start: vi.fn(async () => {}),
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
    getRadioConfig: vi.fn(() => ({ type: 'none' })),
    getActiveProfile: vi.fn(() => null),
  } as unknown as ConfigManager);

  const lifecycle = new EngineLifecycle({
    engineEmitter: new EventEmitter(),
    resourceManager: resourceManager as any,
    slotClock: {} as any,
    slotScheduler: {} as any,
    audioStreamManager: {} as any,
    radioManager: radioManager as any,
    spectrumScheduler: {} as any,
    decodeQueue: decodeQueue as any,
    operatorManager: {} as any,
    physicalTxCoordinator: physicalTxCoordinator as any,
    audioMixer: {} as any,
    clockSource: {} as any,
    subsystems: {
      transmissionPipeline: {
        forceStopPTT: vi.fn(),
        setup: vi.fn(),
        teardown: vi.fn(),
      } as any,
      clockCoordinator: { setup: vi.fn(), teardown: vi.fn() } as any,
    },
    getCurrentMode: () => ({ name: currentModeName } as any),
    getVoiceSessionManager: () => voiceSessionManager as any,
    getCWKeyerManager: () => ({ start: vi.fn(), stop: vi.fn() } as any),
    getCWDecoderManager: () => ({ start: vi.fn(), stop: vi.fn(), getConfig: () => ({}) } as any),
    getAudioVolumeController: () => ({ restoreGainForCurrentSlot: vi.fn() } as any),
    getAudioSidecar: () => audioSidecar as any,
    getImageRadioService: () => imageRadioService as any,
    getStatus: () => ({}),
  });
  lifecycles.push(lifecycle);

  return {
    lifecycle,
    resourceManager,
    decodeQueue,
    radioManager,
    physicalTxCoordinator,
    setPTT,
    audioSidecar,
    setModeName: (modeName: 'FT8' | 'VOICE' | 'CW' | 'SSTV' | 'FAX') => {
      currentModeName = modeName;
    },
  };
}

describe('EngineLifecycle', () => {
  afterEach(() => {
    lifecycles.splice(0).forEach(lifecycle => lifecycle.destroyStateMachine());
    vi.restoreAllMocks();
  });

  it('rebuilds the digital resource plan from a single lifecycle entrypoint', async () => {
    const { lifecycle, resourceManager } = createLifecycle('FT8');

    await lifecycle.rebuildResourcePlan();

    expect(resourceManager.stopAll).toHaveBeenCalledTimes(1);
    expect(resourceManager.clear).toHaveBeenCalledTimes(1);
    expect(resourceManager.register.mock.calls.map(([config]) => config.name)).toEqual([
      'icomWlanAudioAdapter',
      'tciAudioAdapter',
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
    const firstPlanCount = 8;
    const secondPlanNames = resourceManager.register.mock.calls
      .slice(firstPlanCount)
      .map(([config]) => config.name);

    expect(secondPlanNames).toEqual([
      'icomWlanAudioAdapter',
      'tciAudioAdapter',
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

  it('starts the normal audio sidecar with the shared radio resource plan', async () => {
    const { lifecycle, audioSidecar } = createLifecycle('FT8');
    audioSidecar.start.mockResolvedValue(undefined);

    await (lifecycle as any).doStart();

    expect(audioSidecar.start).toHaveBeenCalledOnce();
  });

  it('does not include decode workers in the voice resource plan', async () => {
    const { lifecycle, resourceManager } = createLifecycle('VOICE');

    await lifecycle.rebuildResourcePlan();

    const names = resourceManager.register.mock.calls.map(([config]) => config.name);
    expect(names).not.toContain('decodeWorkerPool');
    expect(names).toEqual([
      'icomWlanAudioAdapter',
      'tciAudioAdapter',
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
      'icomWlanAudioAdapter',
      'tciAudioAdapter',
      'openwebrxAudioAdapter',
      'spectrumScheduler',
    ]);
    expect(names).not.toContain('decodeWorkerPool');
    expect(names).not.toContain('cwDecoderManager');
    expect(names).not.toContain('clock');
    expect(names).not.toContain('slotScheduler');
    expect(names).not.toContain('operatorManager');
  });

  it('uses image resources without digital workers and keeps voice PTT only for SSTV', async () => {
    const sstv = createLifecycle('SSTV');
    await sstv.lifecycle.rebuildResourcePlan();
    expect(sstv.resourceManager.register.mock.calls.map(([config]) => config.name)).toEqual([
      'icomWlanAudioAdapter', 'tciAudioAdapter', 'openwebrxAudioAdapter',
      'spectrumScheduler', 'imageRadioService', 'voiceSessionManager',
    ]);

    const fax = createLifecycle('FAX');
    await fax.lifecycle.rebuildResourcePlan();
    expect(fax.resourceManager.register.mock.calls.map(([config]) => config.name)).toEqual([
      'icomWlanAudioAdapter', 'tciAudioAdapter', 'openwebrxAudioAdapter',
      'spectrumScheduler', 'imageRadioService',
    ]);
  });

  it('stops only mode runtime resources without disconnecting the CAT session', async () => {
    const { lifecycle, radioManager, resourceManager } = createLifecycle('FT8');
    (lifecycle as any).requestedStopScope = 'mode-runtime';

    await (lifecycle as any).doStop();

    expect(resourceManager.stopAll).toHaveBeenCalledOnce();
    expect(radioManager.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects the CAT session during a full engine stop', async () => {
    const { lifecycle, radioManager } = createLifecycle('FT8');
    (lifecycle as any).requestedStopScope = 'full';

    await (lifecycle as any).doStop();

    expect(radioManager.disconnect).toHaveBeenCalledWith('Engine stopped');
  });

  it('rejects all stop callers when cleanup fails and retries cleanup from idle', async () => {
    const { lifecycle, audioSidecar, radioManager } = createLifecycle();
    lifecycle.initializeStateMachine();
    await lifecycle.startAndWaitForRunning();
    audioSidecar.stop.mockRejectedValueOnce(new Error('audio close failed'));

    const results = await Promise.allSettled([lifecycle.stop(), lifecycle.stop()]);
    expect(results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'audio close failed' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'audio close failed' }) },
    ]);
    expect(lifecycle.getEngineState()).toBe('idle');
    expect(radioManager.disconnect).not.toHaveBeenCalled();

    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(lifecycle.getEngineContext()?.error).toBeUndefined();
    expect(radioManager.disconnect).toHaveBeenCalledOnce();
  });

  it('retains CAT and rejects restart until the unknown physical lease is released', async () => {
    const { lifecycle, radioManager, physicalTxCoordinator, setPTT } = createLifecycle();
    lifecycle.initializeStateMachine();
    await lifecycle.startAndWaitForRunning();
    await physicalTxCoordinator.acquireLease({ source: 'manual', reason: 'regression fixture' });
    let releaseFails = true;
    setPTT.mockImplementation(async active => {
      if (!active && releaseFails) throw new Error('PTT release failed');
    });

    await expect(lifecycle.stop()).rejects.toThrow('PTT release failed');
    expect(physicalTxCoordinator.getSnapshot().phase).toBe('unknown');
    expect(radioManager.disconnect).not.toHaveBeenCalled();
    await expect(lifecycle.start()).rejects.toThrow('PTT release failed');
    expect(radioManager.applyConfig).toHaveBeenCalledOnce();

    releaseFails = false;
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(physicalTxCoordinator.getSnapshot().phase).toBe('idle');
    expect(radioManager.disconnect).toHaveBeenCalledOnce();
    await lifecycle.startAndWaitForRunning();
    expect(radioManager.applyConfig).toHaveBeenCalledTimes(2);
  });

  it('propagates resource cleanup errors without disconnecting CAT', async () => {
    const { lifecycle, resourceManager, radioManager } = createLifecycle();
    lifecycle.initializeStateMachine();
    await lifecycle.startAndWaitForRunning();
    resourceManager.stopAll.mockRejectedValueOnce(new Error('decoder stop failed'));
    await expect(lifecycle.stop()).rejects.toThrow('decoder stop failed');
    expect(radioManager.disconnect).not.toHaveBeenCalled();
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  it('keeps CAT while a late hardware operation is still settling', async () => {
    const { lifecycle, physicalTxCoordinator, radioManager } = createLifecycle();
    lifecycle.initializeStateMachine();
    let finish!: () => void;
    const pending = physicalTxCoordinator.runIdleMaintenance({ reason: 'pending CAT write' }, () => new Promise<void>(resolve => { finish = resolve; }));
    await expect(lifecycle.stop()).rejects.toThrow('maintenance');
    expect(radioManager.disconnect).not.toHaveBeenCalled();
    finish();
    await pending;
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });
});
