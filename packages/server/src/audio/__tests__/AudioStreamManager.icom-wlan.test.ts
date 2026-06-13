import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

type MockIcomAdapter = {
  sendAudio: ReturnType<typeof vi.fn>;
  getSampleRate: ReturnType<typeof vi.fn>;
  startReceiving?: ReturnType<typeof vi.fn>;
  stopReceiving?: ReturnType<typeof vi.fn>;
  on?: EventEmitter['on'];
  removeAllListeners?: EventEmitter['removeAllListeners'];
};

type MockOpenWebRXAdapter = EventEmitter & {
  getSampleRate: ReturnType<typeof vi.fn>;
  startReceiving: ReturnType<typeof vi.fn>;
  stopReceiving: ReturnType<typeof vi.fn>;
};

function createIcomManager(adapter: MockIcomAdapter): AudioStreamManager {
  const manager = new AudioStreamManager();
  manager.setIcomWlanAudioAdapter(adapter as never);
  (manager as unknown as { usingIcomWlanOutput: boolean; isOutputting: boolean }).usingIcomWlanOutput = true;
  (manager as unknown as { usingIcomWlanOutput: boolean; isOutputting: boolean }).isOutputting = true;
  return manager;
}

describe('AudioStreamManager ICOM WLAN output pacing', () => {
  beforeEach(() => {
    mockResampleAudioProfessional.mockImplementation(async (samples: Float32Array) => samples);
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

  it('paces ICOM WLAN chunks near realtime instead of draining the whole clip immediately', async () => {
    const adapter: MockIcomAdapter = {
      sendAudio: vi.fn().mockResolvedValue(undefined),
      getSampleRate: vi.fn().mockReturnValue(12000),
    };
    const manager = createIcomManager(adapter);
    const audio = new Float32Array(12000); // 1 second at ICOM native sample rate

    const playback = manager.playAudio(audio, 12000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(manager.isPlaying()).toBe(true);
    expect(adapter.sendAudio).toHaveBeenCalled();
    expect(adapter.sendAudio.mock.calls.length).toBeLessThan(10);

    await expect(playback).resolves.toBeUndefined();
    expect(manager.isPlaying()).toBe(false);
    expect(adapter.sendAudio).toHaveBeenCalledTimes(10);
  });

  it('keeps stopCurrentPlayback responsive while ICOM WLAN pacing waits', async () => {
    const adapter: MockIcomAdapter = {
      sendAudio: vi.fn().mockResolvedValue(undefined),
      getSampleRate: vi.fn().mockReturnValue(12000),
    };
    const manager = createIcomManager(adapter);
    const audio = new Float32Array(12000);

    const playback = manager.playAudio(audio, 12000);
    const playbackResult = playback.catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stop = manager.stopCurrentPlayback();
    const elapsedMs = await stop;

    expect(elapsedMs).toBeGreaterThan(0);
    expect(manager.isPlaying()).toBe(false);
    expect(adapter.sendAudio.mock.calls.length).toBeLessThan(10);
    const playbackError = await playbackResult;
    expect(playbackError).toBeInstanceOf(Error);
    expect(playbackError.message).toBe('playback interrupted');
  });

  it('emits native 12k ICOM input frames while still writing the digital ring buffer', async () => {
    const adapter = Object.assign(new EventEmitter(), {
      sendAudio: vi.fn().mockResolvedValue(undefined),
      getSampleRate: vi.fn().mockReturnValue(12000),
      startReceiving: vi.fn(),
      stopReceiving: vi.fn(),
    });
    const manager = new AudioStreamManager();
    manager.setIcomWlanAudioAdapter(adapter as never);
    const nativeFrames: Array<{ samples: Float32Array; sampleRate: number; sourceKind: string; sequence: number }> = [];
    manager.on('nativeAudioInputData', frame => nativeFrames.push(frame));

    await manager.startStream();
    adapter.emit('audioData', new Float32Array([0.1, 0.2, 0.3, 0.4]));

    expect(adapter.startReceiving).toHaveBeenCalledOnce();
    expect(nativeFrames).toHaveLength(1);
    expect(nativeFrames[0]?.sampleRate).toBe(12000);
    expect(nativeFrames[0]?.sourceKind).toBe('icom-wlan');
    expect(nativeFrames[0]?.sequence).toBe(0);
    expect(nativeFrames[0]?.samples[0]).toBeCloseTo(0.1);
    expect(nativeFrames[0]?.samples[3]).toBeCloseTo(0.4);
    expect(manager.getAudioProvider().getAvailableMs()).toBeGreaterThan(0);

    await manager.stopStream();
  });

  it('threads ICOM wire-level seq into the ring buffer for packet-loss detection', async () => {
    const adapter = Object.assign(new EventEmitter(), {
      sendAudio: vi.fn().mockResolvedValue(undefined),
      getSampleRate: vi.fn().mockReturnValue(12000),
      startReceiving: vi.fn(),
      stopReceiving: vi.fn(),
    });
    const manager = new AudioStreamManager();
    manager.setIcomWlanAudioAdapter(adapter as never);

    await manager.startStream();
    // 连续两个 seq 包 → lastSeq 推进、无丢包
    adapter.emit('audioData', new Float32Array([0.1, 0.2]), { seq: 10, timestampMs: 1 });
    adapter.emit('audioData', new Float32Array([0.3, 0.4]), { seq: 11, timestampMs: 2 });
    // 跳过 seq 12 → 丢 1 包
    adapter.emit('audioData', new Float32Array([0.5, 0.6]), { seq: 13, timestampMs: 3 });

    const status = manager.getAudioProvider().getStatus() as unknown as { lastSeq: number; lostPackets: number };
    expect(status.lastSeq).toBe(13);
    expect(status.lostPackets).toBe(1);

    await manager.stopStream();
  });

  it('resamples ICOM input through the unified audioData pipeline when CW processing rate is 9600 Hz', async () => {
    const adapter = Object.assign(new EventEmitter(), {
      sendAudio: vi.fn().mockResolvedValue(undefined),
      getSampleRate: vi.fn().mockReturnValue(12000),
      startReceiving: vi.fn(),
      stopReceiving: vi.fn(),
    });
    const manager = new AudioStreamManager();
    manager.setInputProcessingSampleRate(9600, 'test-cw');
    manager.setIcomWlanAudioAdapter(adapter as never);
    const processedFrames: Array<{ samples: Float32Array; sampleRate: number }> = [];
    const processed = new Float32Array([0.7, 0.8]);
    mockResampleAudioProfessional.mockResolvedValueOnce(processed);
    manager.on('audioData', (samples, sampleRate) => processedFrames.push({ samples, sampleRate }));

    await manager.startStream();
    adapter.emit('audioData', new Float32Array([0.1, 0.2, 0.3]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockResampleAudioProfessional).toHaveBeenCalledWith(
      expect.any(Float32Array),
      12000,
      9600,
      1,
    );
    expect(manager.getInternalSampleRate()).toBe(9600);
    expect(manager.getAudioProvider().getSampleRate()).toBe(9600);
    expect(processedFrames).toEqual([{ samples: processed, sampleRate: 9600 }]);
    expect(manager.getAudioProvider().getAvailableMs()).toBeGreaterThan(0);

    await manager.stopStream();
  });

  it('emits native OpenWebRX input frames and detaches handlers on stop', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: '[SDR] Remote SDR',
      outputDeviceName: 'ICOM WLAN',
      sampleRate: 48000,
      bufferSize: 1024,
    });
    mockConfigManager.getOpenWebRXStations.mockReturnValue([
      { id: 'remote', name: 'Remote SDR', url: 'https://sdr.example' },
    ]);

    const adapter: MockOpenWebRXAdapter = Object.assign(new EventEmitter(), {
      getSampleRate: vi.fn().mockReturnValue(12000),
      startReceiving: vi.fn(),
      stopReceiving: vi.fn(),
    });
    const manager = new AudioStreamManager();
    manager.setOpenWebRXAudioAdapter(adapter as never);
    const nativeFrames: Array<{ samples: Float32Array; sampleRate: number; sourceKind: string; sequence: number }> = [];
    manager.on('nativeAudioInputData', frame => nativeFrames.push(frame));

    await manager.startStream();
    adapter.emit('audioData', new Float32Array([0.2, 0.3, 0.4]));

    expect(adapter.startReceiving).toHaveBeenCalledOnce();
    expect(nativeFrames).toHaveLength(1);
    expect(nativeFrames[0]?.sampleRate).toBe(12000);
    expect(nativeFrames[0]?.sourceKind).toBe('openwebrx');
    expect(nativeFrames[0]?.sequence).toBe(0);
    expect(nativeFrames[0]?.samples[0]).toBeCloseTo(0.2);
    expect(nativeFrames[0]?.samples[2]).toBeCloseTo(0.4);
    expect(manager.getAudioProvider().getAvailableMs()).toBeGreaterThan(0);

    await manager.stopStream();
    expect(adapter.stopReceiving).toHaveBeenCalledOnce();

    adapter.emit('audioData', new Float32Array([0.5, 0.6]));
    expect(nativeFrames).toHaveLength(1);
  });
});
