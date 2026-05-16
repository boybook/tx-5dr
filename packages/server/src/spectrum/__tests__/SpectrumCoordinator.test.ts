import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpectrumCoordinator } from '../SpectrumCoordinator.js';
import type { IcomScopeFrame } from 'icom-wlan-node';
import { PhysicalRadioManager } from '../../radio/PhysicalRadioManager.js';

class MockEngine extends EventEmitter {
  readonly spectrumScheduler = new EventEmitter() as EventEmitter & {
    setSubscriptionActive: ReturnType<typeof vi.fn>;
  };

  readonly radioManager = {
    getConfig: vi.fn(() => ({ type: 'icom-wlan' })),
    getIcomWlanManager: vi.fn(() => null),
    getActiveConnection: vi.fn(() => null),
    isConnected: vi.fn(() => true),
  };

  constructor() {
    super();
    this.spectrumScheduler.setSubscriptionActive = vi.fn();
  }

  getSpectrumScheduler() {
    return this.spectrumScheduler;
  }

  getRadioManager() {
    return this.radioManager;
  }

  getOpenWebRXAudioAdapter() {
    return null;
  }
}

function createScopeFrame(): IcomScopeFrame {
  return {
    startFreqHz: 7_050_000,
    endFreqHz: 7_150_000,
    pixels: Int16Array.from([1, 2, 3, 4]),
    segments: [],
    transport: 'lan-civ',
    timestamp: Date.now(),
  } as unknown as IcomScopeFrame;
}

describe('SpectrumCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles emitted ICOM WLAN scope frames before they reach websocket clients', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    const coordinator = new SpectrumCoordinator(new MockEngine() as any);
    const frames: unknown[] = [];
    coordinator.on('frame', (frame) => frames.push(frame));

    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(100);
    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(149);
    (coordinator as any).onScopeFrame(createScopeFrame());
    vi.advanceTimersByTime(1);
    (coordinator as any).onScopeFrame(createScopeFrame());

    expect(frames).toHaveLength(2);
  });

  it('keeps radio SDR available and skips Hamlib support probing while the CAT queue is busy', async () => {
    vi.spyOn(PhysicalRadioManager, 'listSupportedRigs').mockResolvedValue([
      { rigModel: 3073, mfgName: 'Icom', modelName: 'IC-7300' },
    ] as any);
    const engine = new MockEngine();
    const getSpectrumSupportSummary = vi.fn().mockResolvedValue({ supported: true });
    (engine.radioManager.getConfig as any).mockReturnValue({ type: 'serial', serial: { rigModel: 3073 } });
    engine.radioManager.isConnected.mockReturnValue(true);
    (engine.radioManager.getActiveConnection as any).mockReturnValue({
      type: 'hamlib',
      getConnectionInfo: () => ({ connectionType: 'serial' }),
      getSpectrumSupportSummary,
      getRadioIoQueueSnapshot: () => ({
        busy: true,
        backpressure: true,
        criticalActive: false,
        activeCount: 1,
        activeTask: 'getFrequency',
        activeRunMs: 6000,
        pendingCount: 2,
        criticalPendingCount: 0,
        normalPendingCount: 2,
        oldestPendingTask: 'getLockMode',
        oldestPendingWaitMs: 1000,
        dedupedTaskCount: 0,
      }),
    });

    const coordinator = new SpectrumCoordinator(engine as any);
    vi.spyOn(coordinator as any, 'isHamlibSerialScopeConnection').mockReturnValue(true);

    const capabilities = await coordinator.getCapabilities();
    const radioSource = capabilities.sources.find((source) => source.kind === 'radio-sdr');

    expect(radioSource).toMatchObject({
      supported: true,
      available: true,
    });
    expect(radioSource?.reason).toBeUndefined();
    expect(getSpectrumSupportSummary).not.toHaveBeenCalled();
  });

  it('reuses cached Hamlib radio SDR availability while the CAT queue is busy', async () => {
    vi.spyOn(PhysicalRadioManager, 'listSupportedRigs').mockResolvedValue([
      { rigModel: 3073, mfgName: 'Icom', modelName: 'IC-7300' },
    ] as any);
    const engine = new MockEngine();
    let busy = false;
    const getSpectrumSupportSummary = vi.fn().mockResolvedValue({ supported: true });
    const connection = {
      type: 'hamlib',
      getConnectionInfo: () => ({ connectionType: 'serial' }),
      getSpectrumSupportSummary,
      getRadioIoQueueSnapshot: () => ({
        busy,
        backpressure: busy,
        criticalActive: false,
        activeCount: busy ? 1 : 0,
        activeTask: busy ? 'getFrequency' : null,
        activeRunMs: busy ? 6000 : null,
        pendingCount: 0,
        criticalPendingCount: 0,
        normalPendingCount: 0,
        oldestPendingTask: null,
        oldestPendingWaitMs: null,
        dedupedTaskCount: 0,
      }),
    };
    (engine.radioManager.getConfig as any).mockReturnValue({ type: 'serial', serial: { rigModel: 3073 } });
    engine.radioManager.isConnected.mockReturnValue(true);
    (engine.radioManager.getActiveConnection as any).mockReturnValue(connection);

    const coordinator = new SpectrumCoordinator(engine as any);
    vi.spyOn(coordinator as any, 'isHamlibSerialScopeConnection').mockReturnValue(true);

    const first = await coordinator.getCapabilities();
    busy = true;
    const second = await coordinator.getCapabilities();
    const firstRadioSource = first.sources.find((source) => source.kind === 'radio-sdr');
    const secondRadioSource = second.sources.find((source) => source.kind === 'radio-sdr');

    expect(getSpectrumSupportSummary).toHaveBeenCalledTimes(1);
    expect(firstRadioSource).toMatchObject({ supported: true, available: true });
    expect(secondRadioSource).toMatchObject({ supported: true, available: true });
    expect(secondRadioSource?.reason).toBeUndefined();
  });
});
