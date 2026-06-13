import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfigManager, mockLogger, mockResampleAudioProfessional, mockRtAudioState, MockRtAudio } = vi.hoisted(() => {
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
    inputCallback: null as ((inputData: Buffer) => void) | null,
    openCalls: [] as Array<{ outputChannels: number; format: number; frameSize: number }>,
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
    private bytesPerSample = 4;

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
      format: number,
      sampleRate: number,
      frameSize: number,
      _streamName: string,
      inputCallback: ((inputData: Buffer) => void) | null,
      frameOutputCallback: (() => void) | null,
      _flags?: number,
      errorCallback?: ((type: number, message: string) => void) | null,
    ) {
      this.open = true;
      this.sampleRate = sampleRate;
      this.frameSize = frameSize;
      this.outputChannels = outputParams?.nChannels ?? 0;
      this.bytesPerSample = format === 0x2 ? 2 : 4;
      state.openCalls.push({ outputChannels: this.outputChannels, format, frameSize });
      state.inputCallback = inputCallback;
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
      if (buffer.length !== this.frameSize * this.outputChannels * this.bytesPerSample) {
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
    mockResampleAudioProfessional: vi.fn(async (samples: Float32Array) => samples),
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
  resampleAudioProfessional: mockResampleAudioProfessional,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

import { AudioStreamManager, getAudioRuntimeIssue, isRtAudioRuntimeLossMessage } from '../AudioStreamManager.js';
import { AudioDeviceManager } from '../audio-device-manager.js';
import { RingBuffer } from '../ringBuffer.js';

describe('AudioStreamManager RtAudio output diagnostics', () => {
  const originalForceWatchdog = process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG;
  const originalConsumeDiagnostics = process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS;
  const originalRuntimeFlavor = process.env.TX5DR_RUNTIME_FLAVOR;

  beforeEach(() => {
    mockRtAudioState.consumeOnWrite = true;
    mockRtAudioState.throwOnWrite = false;
    mockRtAudioState.writes = [];
    mockRtAudioState.openCalls = [];
    mockRtAudioState.inputCallback = null;
    mockRtAudioState.devices = [
      {
        id: 11,
        name: 'USB Audio',
        inputChannels: 1,
        outputChannels: 1,
        preferredSampleRate: 48000,
        isDefaultInput: true,
        isDefaultOutput: true,
      },
    ];
    mockResampleAudioProfessional.mockImplementation(async (samples: Float32Array) => samples);
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
    (AudioDeviceManager as unknown as { instance?: AudioDeviceManager }).instance = undefined;
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
    if (originalRuntimeFlavor === undefined) {
      delete process.env.TX5DR_RUNTIME_FLAVOR;
    } else {
      process.env.TX5DR_RUNTIME_FLAVOR = originalRuntimeFlavor;
    }
    vi.restoreAllMocks();
  });

  it('resamples audio device input once into the configured RX processing rate', async () => {
    const manager = new AudioStreamManager();
    manager.setInputProcessingSampleRate(9600, 'test-cw');
    const processed = new Float32Array([0.25, 0.5]);
    const processedFrames: Array<{ samples: Float32Array; sampleRate: number }> = [];
    mockResampleAudioProfessional.mockResolvedValueOnce(processed);
    manager.on('audioData', (samples, sampleRate) => processedFrames.push({ samples, sampleRate }));

    await manager.startStream();

    const input = Buffer.alloc(3 * Float32Array.BYTES_PER_ELEMENT);
    new Float32Array(input.buffer, input.byteOffset, 3).set([0.1, 0.2, 0.3]);
    mockRtAudioState.inputCallback?.(input);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockResampleAudioProfessional).toHaveBeenCalledWith(
      expect.any(Float32Array),
      48000,
      9600,
      1,
    );
    expect(manager.getInternalSampleRate()).toBe(9600);
    expect(manager.getAudioProvider().getSampleRate()).toBe(9600);
    expect(processedFrames).toEqual([{ samples: processed, sampleRate: 9600 }]);

    await manager.stopStream();
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

  it('opens the default RtAudio output as Float32 mono', async () => {
    const manager = new AudioStreamManager();
    await manager.startOutput();

    expect(mockRtAudioState.openCalls.at(-1)).toMatchObject({
      outputChannels: 1,
      format: 0x10,
      frameSize: 64,
    });
  });

  it('writes Int16 duplicated stereo output when both channels are selected', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'USB Audio',
      outputDeviceName: 'USB Audio',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'int16',
      outputChannelMode: 'both',
    });
    const manager = new AudioStreamManager();
    manager.setVolumeGain(1);
    await manager.startOutput();

    await manager.playAudio(new Float32Array([0.5, -0.5]), 48000);

    expect(mockRtAudioState.openCalls.at(-1)).toMatchObject({
      outputChannels: 2,
      format: 0x2,
    });
    const buffer = mockRtAudioState.writes[0]!;
    expect(buffer).toHaveLength(64 * 2 * 2);
    expect(buffer.readInt16LE(0)).toBe(16384);
    expect(buffer.readInt16LE(2)).toBe(16384);
    expect(buffer.readInt16LE(4)).toBe(-16384);
    expect(buffer.readInt16LE(6)).toBe(-16384);
  });

  it('routes Float32 stereo output to the selected side channel', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'USB Audio',
      outputDeviceName: 'USB Audio',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'float32',
      outputChannelMode: 'right',
    });
    const manager = new AudioStreamManager();
    manager.setVolumeGain(1);
    await manager.startOutput();

    await manager.playAudio(new Float32Array([0.25]), 48000);

    expect(mockRtAudioState.openCalls.at(-1)).toMatchObject({
      outputChannels: 2,
      format: 0x10,
    });
    const buffer = mockRtAudioState.writes[0]!;
    expect(buffer).toHaveLength(64 * 2 * 4);
    expect(buffer.readFloatLE(0)).toBe(0);
    expect(buffer.readFloatLE(4)).toBeCloseTo(0.25);
  });

  it('uses the same RtAudio encoding for voice TX writes without applying gain twice', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'USB Audio',
      outputDeviceName: 'USB Audio',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'int16',
      outputChannelMode: 'left',
    });
    const manager = new AudioStreamManager();
    manager.setVolumeGain(0.1);
    await manager.startOutput();

    const writeOk = await (manager as unknown as {
      writeVoiceTxOutputChunk: (samples: Float32Array, sink: { kind: 'rtaudio'; available: boolean; outputSampleRate: number; outputBufferSize: number }) => Promise<boolean>;
    }).writeVoiceTxOutputChunk(new Float32Array([0.5, -0.5]), {
      kind: 'rtaudio',
      available: true,
      outputSampleRate: 48000,
      outputBufferSize: 64,
    });

    expect(writeOk).toBe(true);
    const buffer = mockRtAudioState.writes[0]!;
    expect(buffer.readInt16LE(0)).toBe(16384);
    expect(buffer.readInt16LE(2)).toBe(0);
    expect(buffer.readInt16LE(4)).toBe(-16384);
    expect(buffer.readInt16LE(6)).toBe(0);
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

  it('treats ALSA output device-loss warnings as a single recoverable runtime loss', async () => {
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();
    vi.clearAllMocks();

    const nowSpy = vi.spyOn(Date, 'now');
    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    const message = 'RtApiAlsa::callbackEvent: audio write error, No such device.';

    nowSpy.mockReturnValue(1_000);
    output.emitRtAudioError(1, message);
    nowSpy.mockReturnValue(1_001);
    output.emitRtAudioError(1, message);
    nowSpy.mockReturnValue(1_002);
    output.emitRtAudioError(1, message);

    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]?.message).toContain('RtAudio output runtime error (1)');
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'RtAudio output runtime error',
      expect.objectContaining({
        type: 1,
        typeName: 'DEBUG_WARNING',
        message,
        fatal: true,
      }),
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(7_000);
    output.emitRtAudioError(1, message);

    expect(runtimeErrors).toHaveLength(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RtAudio output runtime error suppressed',
      expect.objectContaining({
        type: 1,
        suppressedCount: 2,
        suppressWindowMs: 5000,
      }),
    );
  });

  it('classifies CoreAudio disconnected callbacks as structured runtime loss', async () => {
    mockRtAudioState.devices = [
      {
        id: 11,
        name: 'C-Media Electronics Inc.: USB Audio Device',
        inputChannels: 1,
        outputChannels: 1,
        preferredSampleRate: 48000,
        isDefaultInput: true,
        isDefaultOutput: true,
      },
    ];
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      outputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
    });
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();

    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    output.emitRtAudioError(5, 'RtApiCore: the stream device was disconnected (and closed)!');

    const issue = getAudioRuntimeIssue(runtimeErrors[0]);
    expect(issue).toMatchObject({
      direction: 'output',
      phase: 'runtime',
      deviceName: 'C-Media Electronics Inc.: USB Audio Device',
      sampleRate: 48000,
      bufferSize: 64,
      runtimeLoss: true,
      type: 5,
      framesConsumed: 0,
    });
    expect(issue?.elapsedSinceOpenMs).not.toBeNull();
  });

  it('keeps close-stream and Android underrun warnings out of runtime-loss classification', () => {
    expect(isRtAudioRuntimeLossMessage('RtApiCore: the stream device was disconnected (and closed)!')).toBe(true);
    expect(isRtAudioRuntimeLossMessage('RtApiWasapi::closeStream: No open stream to close.')).toBe(false);
    expect(isRtAudioRuntimeLossMessage('RtApiAlsa::callbackEvent: audio write error, underrun.')).toBe(false);
  });

  it('treats Android bridge ALSA output underruns as non-fatal warnings', async () => {
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();
    vi.clearAllMocks();

    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    const message = 'RtApiAlsa::callbackEvent: audio write error, underrun.';

    output.emitRtAudioError(1, message);

    expect(runtimeErrors).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RtAudio output callback warning',
      expect.objectContaining({
        type: 1,
        typeName: 'DEBUG_WARNING',
        message,
        fatal: false,
      }),
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'RtAudio output runtime error',
      expect.anything(),
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

  it('rate-limits repeated non-fatal RtAudio output warnings', async () => {
    const manager = new AudioStreamManager();
    await manager.startOutput();
    vi.clearAllMocks();

    const nowSpy = vi.spyOn(Date, 'now');
    const output = (manager as unknown as { rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void } }).rtAudioOutput;
    const message = 'RtApiWasapi::closeStream: No open stream to close.';

    nowSpy.mockReturnValue(2_000);
    output.emitRtAudioError(1, message);
    nowSpy.mockReturnValue(2_001);
    output.emitRtAudioError(1, message);
    nowSpy.mockReturnValue(8_000);
    output.emitRtAudioError(1, message);

    const warningCalls = mockLogger.warn.mock.calls.filter(([logMessage]) => logMessage === 'RtAudio output callback warning');
    expect(warningCalls).toHaveLength(2);
    expect(warningCalls[0]?.[1]).toMatchObject({
      type: 1,
      message,
      fatal: false,
    });
    expect(warningCalls[1]?.[1]).toMatchObject({
      type: 1,
      message,
      fatal: false,
      suppressedCount: 1,
      suppressWindowMs: 5000,
    });
  });

  it('closes an existing RtAudio output stream even when outputting state was already cleared', async () => {
    const manager = new AudioStreamManager();
    await manager.startOutput();
    const output = (manager as unknown as { rtAudioOutput: { isStreamOpen: () => boolean } }).rtAudioOutput;

    (manager as unknown as { isOutputting: boolean }).isOutputting = false;

    await manager.stopOutput();

    expect(output.isStreamOpen()).toBe(false);
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

  it('logs sliding-window eviction at debug (not warn) for the RX/input buffer', () => {
    const ringBuffer = new RingBuffer(12000, 10);

    ringBuffer.write(new Float32Array(200).fill(0.1));

    // 满缓冲淘汰最旧样本是正常稳态，记为 debug 避免误导性 WARN 噪声
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'RX/input ring buffer evicted oldest samples (sliding window full)',
      expect.objectContaining({
        bufferKind: 'rx-input',
        droppedSamples: 80,
      }),
    );
  });
});
