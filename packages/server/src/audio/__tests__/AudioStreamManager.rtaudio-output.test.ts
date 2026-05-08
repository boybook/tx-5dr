import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfigManager, mockLogger, mockRtAudioState, MockRtAudio } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const state = {
    consumeOnWrite: true,
    throwOnWrite: false,
    writes: [] as Buffer[],
    devices: [
      {
        id: 11,
        name: 'USB Audio',
        inputChannels: 1,
        outputChannels: 1,
        preferredSampleRate: 48000,
        isDefaultInput: true,
        isDefaultOutput: true,
      },
    ],
  };

  class HoistedMockRtAudio {
    private open = false;
    private running = false;
    private frameOutputCallback: (() => void) | null = null;
    private errorCallback: ((type: number, message: string) => void) | null = null;
    private sampleRate = 48000;
    private frameSize = 64;
    private outputChannels = 1;

    constructor(private readonly api: number) {}

    getDevices() {
      return state.devices;
    }

    getDefaultInputDevice() {
      return 11;
    }

    getDefaultOutputDevice() {
      return 11;
    }

    openStream(
      outputParams: { deviceId: number; nChannels: number } | null,
      _inputParams: { deviceId: number; nChannels: number } | null,
      _format: number,
      sampleRate: number,
      frameSize: number,
      _streamName: string,
      _inputCallback: ((inputData: Buffer) => void) | null,
      frameOutputCallback: (() => void) | null,
      _flags?: number,
      errorCallback?: ((type: number, message: string) => void) | null,
    ) {
      this.open = true;
      this.sampleRate = sampleRate;
      this.frameSize = frameSize;
      this.outputChannels = outputParams?.nChannels ?? 0;
      this.frameOutputCallback = frameOutputCallback;
      this.errorCallback = errorCallback ?? null;
    }

    start() {
      this.running = true;
    }

    stop() {
      this.running = false;
    }

    closeStream() {
      this.open = false;
      this.running = false;
    }

    isStreamOpen() {
      return this.open;
    }

    isStreamRunning() {
      return this.running;
    }

    getApi() {
      return this.api === 7 ? 'Windows WASAPI' : 'Mock API';
    }

    getStreamLatency() {
      return 128;
    }

    getStreamSampleRate() {
      return this.sampleRate;
    }

    write(buffer: Buffer) {
      if (buffer.length !== this.frameSize * this.outputChannels * 4) {
        throw new Error(`bad write size: ${buffer.length}`);
      }
      if (state.throwOnWrite) {
        throw new Error('mock write failed');
      }
      state.writes.push(buffer);
      if (state.consumeOnWrite) {
        this.frameOutputCallback?.();
      }
    }

    emitRtAudioError(type: number, message: string) {
      this.errorCallback?.(type, message);
    }
  }

  return {
    mockConfigManager: {
      getAudioConfig: vi.fn(),
      getOpenWebRXStations: vi.fn((): Array<{ id: string; name: string; url: string }> => []),
      getRadioConfig: vi.fn(() => ({ type: 'serial' })),
    },
    mockLogger: logger,
    mockRtAudioState: state,
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
  resampleAudioProfessional: vi.fn(async (samples: Float32Array) => samples),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

import { AudioStreamManager } from '../AudioStreamManager.js';
import { RingBuffer } from '../ringBuffer.js';

describe('AudioStreamManager RtAudio output diagnostics', () => {
  const originalForceWatchdog = process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG;
  const originalConsumeDiagnostics = process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS;

  beforeEach(() => {
    mockRtAudioState.consumeOnWrite = true;
    mockRtAudioState.throwOnWrite = false;
    mockRtAudioState.writes = [];
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'USB Audio',
      outputDeviceName: 'USB Audio',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
    });
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'serial' });
    mockConfigManager.getOpenWebRXStations.mockReturnValue([]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalForceWatchdog === undefined) {
      delete process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG;
    } else {
      process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG = originalForceWatchdog;
    }
    if (originalConsumeDiagnostics === undefined) {
      delete process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS;
    } else {
      process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS = originalConsumeDiagnostics;
    }
    vi.restoreAllMocks();
  });

  it('logs submitted and consumed RtAudio output chunks with playback amplitude stats', async () => {
    process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS = '1';
    const manager = new AudioStreamManager();
    await manager.startOutput();

    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    expect(mockRtAudioState.writes).toHaveLength(4);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'audio playback submit complete',
      expect.objectContaining({
        submittedChunks: 4,
        submittedSamples: 256,
        writeFails: 0,
      }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'audio playback consume complete',
      expect.objectContaining({
        submittedChunks: 4,
        consumedChunks: 4,
        consumeComplete: true,
        sourcePeak: 0.5,
        postGainPeak: 0.158114,
        backend: expect.objectContaining({
          streamRunning: true,
          streamSampleRate: 48000,
        }),
      }),
    );
  });

  it('emits a runtime error when Windows writes are submitted but RtAudio never consumes frames', async () => {
    process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG = '1';
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();

    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    expect(runtimeErrors.some((error) => error.message.includes('submitted audio but no frame consumption'))).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Windows RtAudio output consume watchdog fired',
      expect.objectContaining({
        submittedChunks: 4,
        consumedChunks: 0,
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RtAudio output did not consume all submitted playback chunks before timeout',
      expect.objectContaining({
        submittedChunks: 4,
        consumedChunks: 0,
        consumeComplete: false,
      }),
    );
  });

  it('surfaces RtAudio output error callbacks through AudioStreamManager error events', async () => {
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();

    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    output.emitRtAudioError(8, 'WASAPI render client failed');

    expect(runtimeErrors[0]?.message).toContain('RtAudio output runtime error (8)');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'RtAudio output runtime error',
      expect.objectContaining({
        type: 8,
        typeName: 'DRIVER_ERROR',
        message: 'WASAPI render client failed',
        fatal: true,
      }),
    );
  });

  it('records RtAudio warning callbacks without treating them as runtime loss', async () => {
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();

    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    output.emitRtAudioError(1, 'RtApiWasapi::closeStream: No open stream to close.');

    expect(runtimeErrors).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RtAudio output callback warning',
      expect.objectContaining({
        type: 1,
        typeName: 'DEBUG_WARNING',
        message: 'RtApiWasapi::closeStream: No open stream to close.',
        fatal: false,
      }),
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'RtAudio output runtime error',
      expect.anything(),
    );
  });

  it('logs RtAudio write exception details instead of only incrementing writeFails', async () => {
    mockRtAudioState.throwOnWrite = true;
    const manager = new AudioStreamManager();
    await manager.startOutput();

    const playback = manager.playAudio(new Float32Array(256).fill(0.5), 48000).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await manager.stopCurrentPlayback();
    await playback;

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'audio output write failed',
      expect.objectContaining({
        error: 'mock write failed',
        fails: expect.any(Number),
      }),
    );
  });

  it('labels RingBuffer overflow logs as RX/input buffer overflow', () => {
    const ringBuffer = new RingBuffer(12000, 10);

    ringBuffer.write(new Float32Array(200).fill(0.1));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RX/input ring buffer overflow',
      expect.objectContaining({
        bufferKind: 'rx-input',
        droppedSamples: 80,
      }),
    );
  });
});
