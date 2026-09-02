import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpectrumCoordinator } from '../SpectrumCoordinator.js';
import type { IcomScopeFrame } from 'icom-wlan-node';
import { PhysicalRadioManager } from '../../radio/PhysicalRadioManager.js';
import { HamlibConnection } from '../../radio/connections/HamlibConnection.js';
import { IcomWlanConnection } from '../../radio/connections/IcomWlanConnection.js';

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

  it('throttles provider-emitted ICOM WLAN scope frames before they reach websocket clients', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'));
    const engine = new MockEngine();
    const connection = new IcomWlanConnection();
    let scopeListener: ((frame: IcomScopeFrame) => void) | null = null;
    vi.spyOn(connection, 'addScopeFrameListener').mockImplementation((listener) => { scopeListener = listener; });
    vi.spyOn(connection, 'removeScopeFrameListener').mockImplementation(() => { scopeListener = null; });
    vi.spyOn(connection, 'enableScopeStream').mockResolvedValue();
    vi.spyOn(connection, 'disableScopeStream').mockResolvedValue();
    engine.radioManager.getIcomWlanManager.mockReturnValue(connection as any);
    engine.radioManager.getActiveConnection.mockReturnValue(connection as any);
    const coordinator = new SpectrumCoordinator(engine as any);
    const frames: unknown[] = [];
    coordinator.on('frame', (frame) => frames.push(frame));
    await coordinator.setConnectionSubscription('test', 'radio-sdr');

    scopeListener!(createScopeFrame());
    vi.advanceTimersByTime(100);
    scopeListener!(createScopeFrame());
    vi.advanceTimersByTime(149);
    scopeListener!(createScopeFrame());
    vi.advanceTimersByTime(1);
    scopeListener!(createScopeFrame());

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      meta: {
        level: {
          domain: 'raw',
          unit: 'Level',
          min: 0,
          max: 255,
        },
      },
    });
    await (coordinator as any).stopRadioScope();
  });

  it('keeps radio SDR available and skips Hamlib support probing while the CAT queue is busy', async () => {
    vi.spyOn(PhysicalRadioManager, 'listSupportedRigs').mockResolvedValue([
      { rigModel: 3073, mfgName: 'Icom', modelName: 'IC-7300' },
    ] as any);
    const engine = new MockEngine();
    const connection = new HamlibConnection();
    const getSpectrumSupportSummary = vi.spyOn(connection, 'getSpectrumSupportSummary').mockResolvedValue({ supported: true } as any);
    (engine.radioManager.getConfig as any).mockReturnValue({ type: 'serial', serial: { rigModel: 3073 } });
    engine.radioManager.isConnected.mockReturnValue(true);
    vi.spyOn(connection, 'getRadioIoQueueSnapshot').mockReturnValue({
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
      } as any);
    (engine.radioManager.getActiveConnection as any).mockReturnValue(connection);

    const coordinator = new SpectrumCoordinator(engine as any);

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
    const connection = new HamlibConnection();
    const getSpectrumSupportSummary = vi.spyOn(connection, 'getSpectrumSupportSummary').mockResolvedValue({ supported: true } as any);
    vi.spyOn(connection, 'getRadioIoQueueSnapshot').mockImplementation(() => ({
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
      } as any));
    (engine.radioManager.getConfig as any).mockReturnValue({ type: 'serial', serial: { rigModel: 3073 } });
    engine.radioManager.isConnected.mockReturnValue(true);
    (engine.radioManager.getActiveConnection as any).mockReturnValue(connection);

    const coordinator = new SpectrumCoordinator(engine as any);

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

  it('stops a registered radio source two seconds after the last subscriber leaves', async () => {
    vi.useFakeTimers();
    const coordinator = new SpectrumCoordinator(new MockEngine() as any);
    const source = {
      key: {},
      getAvailability: vi.fn().mockResolvedValue({
        kind: 'radio-sdr',
        supported: true,
        available: true,
        defaultSelected: true,
        sourceBinCount: 4096,
        displayBinCount: 1024,
        supportsWaterfall: true,
        frequencyRangeMode: 'absolute',
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn((coordinator as any).registeredSourceRegistry, 'resolve').mockResolvedValue({
      source,
      availability: await source.getAvailability(),
    });

    await coordinator.setConnectionSubscription('client', 'radio-sdr');
    expect(source.start).toHaveBeenCalledTimes(1);
    await coordinator.removeConnection('client');
    await vi.advanceTimersByTimeAsync(1999);
    expect(source.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves the native audio FFT bin count for display clients', async () => {
    const engine = new MockEngine();
    const coordinator = new SpectrumCoordinator(engine as any);
    const frames: any[] = [];
    coordinator.on('frame', (frame) => frames.push(frame));
    await coordinator.setConnectionSubscription('audio-client', 'audio');

    const values = Int16Array.from({ length: 4097 }, (_, index) => index);
    engine.spectrumScheduler.emit('spectrumReady', {
      timestamp: 1,
      kind: 'audio',
      frequencyRange: { min: 0, max: 3000 },
      binaryData: {
        data: Buffer.from(values.buffer).toString('base64'),
        format: { type: 'int16', length: values.length, scale: 1, offset: 0 },
      },
      meta: {
        sourceBinCount: values.length,
        displayBinCount: values.length,
      },
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].binaryData.format.length).toBe(4097);
    expect(frames[0].meta.displayBinCount).toBe(4097);
  });
});
