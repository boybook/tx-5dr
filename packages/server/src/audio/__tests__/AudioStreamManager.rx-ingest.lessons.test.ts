import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';

const { mockConfigManager, mockResampleAudioProfessional, MockRtAudio } = vi.hoisted(() => {
  class HoistedMockRtAudio {
    constructor(_api: number) {}
    getDevices() { return []; }
    getDefaultInputDevice() { return 0; }
    getDefaultOutputDevice() { return 0; }
    openStream() {}
    start() {}
    stop() {}
    closeStream() {}
  }

  return {
    mockConfigManager: {
      getAudioConfig: vi.fn(),
      getOpenWebRXStations: vi.fn((): Array<{ id: string; name: string; url: string }> => []),
      getRadioConfig: vi.fn(() => ({ type: 'icom-wlan' })),
    },
    mockResampleAudioProfessional: vi.fn(),
    MockRtAudio: HoistedMockRtAudio,
  };
});

vi.mock('audify', () => ({
  default: {
    RtAudio: MockRtAudio,
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => mockConfigManager,
  },
}));

vi.mock('../../utils/audioUtils.js', () => ({
  clearResamplerCache: vi.fn(),
  resampleAudioProfessional: mockResampleAudioProfessional,
}));

import { AudioStreamManager } from '../AudioStreamManager.js';
import { clearResamplerCache } from '../../utils/audioUtils.js';

/** Source frames arrive at 48 kHz so every chunk goes through the async resampler into 12 kHz. */
const SOURCE_SAMPLE_RATE = 48_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createInputAdapter() {
  return Object.assign(new EventEmitter(), {
    sendAudio: vi.fn().mockResolvedValue(undefined),
    getSampleRate: vi.fn().mockReturnValue(SOURCE_SAMPLE_RATE),
    startReceiving: vi.fn(),
    stopReceiving: vi.fn(),
  });
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type RingStatus = { totalSamplesWritten: number; anchorWallMs: number | null };

function ringStatus(manager: AudioStreamManager): RingStatus {
  return manager.getAudioProvider().getStatus() as unknown as RingStatus;
}

describe('AudioStreamManager RX ingest timing and generations', () => {
  beforeEach(() => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'ICOM WLAN',
      outputDeviceName: 'ICOM WLAN',
      sampleRate: 48000,
      bufferSize: 1024,
    });
    mockConfigManager.getOpenWebRXStations.mockReturnValue([]);
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'icom-wlan' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('RX-07: anchors the capture clock at source-chunk ingest time, not at resample completion', async () => {
    let now = 10_000;
    const manager = new AudioStreamManager({ now: () => now });
    const adapter = createInputAdapter();
    manager.setIcomWlanAudioAdapter(adapter as never);
    const pending = deferred<Float32Array>();
    mockResampleAudioProfessional.mockReturnValueOnce(pending.promise);

    await manager.startStream();
    adapter.emit('audioData', new Float32Array(4800)); // 100 ms at 48 kHz, ingested at t=10_000
    now = 15_000; // async resample takes 5 s of wall-clock time
    pending.resolve(new Float32Array(1200)); // 100 ms at 12 kHz
    await flushAsyncWork();

    expect(mockResampleAudioProfessional).toHaveBeenCalledWith(expect.any(Float32Array), SOURCE_SAMPLE_RATE, 12_000, 1);
    // First write anchors sample 0 at (arrival - chunk duration). Using the resample
    // completion time would give 14_900 instead.
    expect(ringStatus(manager)).toMatchObject({ totalSamplesWritten: 1200, anchorWallMs: 9_900 });
    expect(manager.getAudioProvider().readByWallClock(9_900, 100).presentSamples).toBe(1200);

    await manager.stopStream();
  });

  it('RX-15: drops an in-flight resample result produced for the previous processing rate', async () => {
    const manager = new AudioStreamManager();
    const adapter = createInputAdapter();
    manager.setIcomWlanAudioAdapter(adapter as never);
    const providerBefore = manager.getAudioProvider();
    const stale = deferred<Float32Array>();
    mockResampleAudioProfessional.mockReturnValueOnce(stale.promise);
    const processedFrames: Array<{ length: number; sampleRate: number }> = [];
    manager.on('audioData', (samples, sampleRate) => processedFrames.push({ length: samples.length, sampleRate }));

    await manager.startStream();
    adapter.emit('audioData', new Float32Array(4800)); // resampling 48 kHz -> 12 kHz in flight
    expect(manager.setInputProcessingSampleRate(9600, 'test-cw')).toBe(true);
    stale.resolve(new Float32Array(1200)); // 12 kHz result arrives after the switch
    await flushAsyncWork();

    // The provider object survives the rate switch (SlotScheduler keeps holding it) ...
    expect(manager.getAudioProvider()).toBe(providerBefore);
    expect(manager.getAudioProvider().getSampleRate()).toBe(9600);
    // ... but the stale 12 kHz chunk never reaches the rebuilt 9.6 kHz ring or audioData.
    expect(ringStatus(manager).totalSamplesWritten).toBe(0);
    expect(processedFrames).toEqual([]);

    // Fresh chunks resampled for the current rate are still written.
    mockResampleAudioProfessional.mockResolvedValueOnce(new Float32Array(960));
    adapter.emit('audioData', new Float32Array(4800));
    await flushAsyncWork();
    expect(mockResampleAudioProfessional).toHaveBeenLastCalledWith(expect.any(Float32Array), SOURCE_SAMPLE_RATE, 9600, 1);
    expect(ringStatus(manager).totalSamplesWritten).toBe(960);
    expect(processedFrames).toEqual([{ length: 960, sampleRate: 9600 }]);

    await manager.stopStream();
  });

  it('RX-16: restarts the stateful resampler stream when the processing rate changes or the input stops', async () => {
    const manager = new AudioStreamManager();
    const adapter = createInputAdapter();
    manager.setIcomWlanAudioAdapter(adapter as never);
    await manager.startStream();
    vi.mocked(clearResamplerCache).mockClear();

    // Same rate: the running filter stream is kept.
    expect(manager.setInputProcessingSampleRate(12_000, 'unchanged')).toBe(false);
    expect(clearResamplerCache).not.toHaveBeenCalled();

    // New rate: filter state from the old rate must not leak into the new stream.
    expect(manager.setInputProcessingSampleRate(9600, 'test-cw')).toBe(true);
    expect(clearResamplerCache).toHaveBeenCalledTimes(1);

    // Stopping input ends the stream; a restart begins from fresh filter state.
    await manager.stopStream();
    expect(clearResamplerCache).toHaveBeenCalledTimes(2);
  });

  it('RX-18: does not write an input chunk from the previous stream generation after stop and restart', async () => {
    const manager = new AudioStreamManager();
    const adapter = createInputAdapter();
    manager.setIcomWlanAudioAdapter(adapter as never);
    const inFlight = deferred<Float32Array>();
    mockResampleAudioProfessional.mockReturnValueOnce(inFlight.promise);
    const processedFrames: number[] = [];
    manager.on('audioData', (samples) => processedFrames.push(samples.length));

    await manager.startStream();
    adapter.emit('audioData', new Float32Array(4800)); // generation 1, resample in flight
    await manager.stopStream();
    await manager.startStream(); // generation 3
    inFlight.resolve(new Float32Array(1200));
    await flushAsyncWork();

    expect(ringStatus(manager).totalSamplesWritten).toBe(0);
    expect(processedFrames).toEqual([]);

    // The restarted stream itself still ingests normally.
    mockResampleAudioProfessional.mockResolvedValueOnce(new Float32Array(600));
    adapter.emit('audioData', new Float32Array(2400));
    await flushAsyncWork();
    expect(ringStatus(manager).totalSamplesWritten).toBe(600);
    expect(processedFrames).toEqual([600]);

    await manager.stopStream();
  });

  it('RX-18: does not write an input chunk that completes after the stream stopped', async () => {
    const manager = new AudioStreamManager();
    const adapter = createInputAdapter();
    manager.setIcomWlanAudioAdapter(adapter as never);
    const inFlight = deferred<Float32Array>();
    mockResampleAudioProfessional.mockReturnValueOnce(inFlight.promise);

    await manager.startStream();
    adapter.emit('audioData', new Float32Array(4800));
    await manager.stopStream();
    inFlight.resolve(new Float32Array(1200));
    await flushAsyncWork();

    expect(ringStatus(manager).totalSamplesWritten).toBe(0);
    expect(manager.getAudioProvider().getAvailableMs()).toBe(0);
  });
});
