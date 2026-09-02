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

    consumeNextFrame() {
      this.frameOutputCallback?.();
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

import {
  AudioRuntimeIssueError,
  AudioStreamManager,
  getAudioRuntimeIssue,
  isRtAudioRuntimeLossMessage,
  type RtAudioRuntimeIssue,
} from '../AudioStreamManager.js';
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

  it('applies the explicit FT8/FT4 envelope at the RtAudio output boundary', async () => {
    const manager = new AudioStreamManager();
    manager.setVolumeGain(1);
    await manager.startOutput();

    await manager.playAudio(new Float32Array(2_400).fill(0.5), 48_000, {
      playbackKind: 'digital',
      txEnvelopeProfile: 'ft8-ft4',
    });

    const first = mockRtAudioState.writes[0]!.readFloatLE(0);
    const middle = mockRtAudioState.writes[Math.floor(mockRtAudioState.writes.length / 2)]!.readFloatLE(0);
    const lastWrite = mockRtAudioState.writes.at(-1)!;
    const last = lastWrite.readFloatLE(lastWrite.length - 4);
    expect(first).toBeCloseTo(0);
    expect(middle).toBeGreaterThan(0.49);
    expect(last).toBeCloseTo(0);
  });

  it('sends a bounded release tail before stopping an FT8/FT4 playback', async () => {
    const manager = new AudioStreamManager();
    manager.setVolumeGain(1);
    await manager.startOutput();
    const playback = manager.playAudio(new Float32Array(48_000).fill(0.5), 48_000, {
      playbackKind: 'digital',
      txEnvelopeProfile: 'ft8-ft4',
    }).catch((error) => error);

    await vi.waitFor(() => expect(mockRtAudioState.writes.length).toBeGreaterThan(0));
    await manager.stopCurrentPlayback({ kind: 'digital' });
    const result = await playback;
    expect(result).toBeInstanceOf(Error);
    const lastWrite = mockRtAudioState.writes.at(-1)!;
    expect(lastWrite.readFloatLE(lastWrite.length - 4)).toBeCloseTo(0);
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

    await expect(manager.playAudio(new Float32Array(256).fill(0.5), 48000))
      .rejects.toMatchObject({
        audioIssue: expect.objectContaining({
          kind: 'consumption-stall',
          disposition: 'restart-required',
        }),
      });

    expect(runtimeErrors.some((error) => error.message.includes('submitted audio but no frame consumption'))).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'RtAudio output consume watchdog fired',
      expect.objectContaining({
        submittedChunks: 4,
        consumedChunks: 0,
      }),
    );
  });

  it('acknowledges RtAudio playback only after the device consumes a frame', async () => {
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    const onPlaybackStarted = vi.fn();
    await manager.startOutput();

    const playback = manager.playAudio(new Float32Array(256).fill(0.5), 48000, { onPlaybackStarted });
    await vi.waitFor(() => expect(mockRtAudioState.writes.length).toBeGreaterThan(0));
    expect(onPlaybackStarted).not.toHaveBeenCalled();

    const output = (manager as unknown as { rtAudioOutput: { consumeNextFrame: () => void } }).rtAudioOutput;
    output.consumeNextFrame();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    await playback;
  });

  it('does not enqueue a new RtAudio playback behind undrained output', async () => {
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    await manager.startOutput();

    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    await expect(manager.playAudio(new Float32Array(256).fill(0.5), 48000))
      .rejects.toThrow('undrained audio from a previous playback');
  });

  it('waits for every previously submitted RtAudio chunk before allowing replacement playback', async () => {
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    await manager.startOutput();
    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    let drained = false;
    const drain = manager.waitForOutputDrain({ timeoutMs: 200 }).then((waited) => {
      drained = true;
      return waited;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    const output = (manager as unknown as {
      rtAudioOutput: { consumeNextFrame: () => void };
    }).rtAudioOutput;
    for (let index = 0; index < mockRtAudioState.writes.length; index++) {
      output.consumeNextFrame();
    }

    await expect(drain).resolves.toBe(true);
    mockRtAudioState.consumeOnWrite = true;
    await expect(manager.playAudio(new Float32Array(256).fill(0.25), 48000)).resolves.toBeUndefined();
  });

  it('bounds waiting for an RtAudio FIFO that never drains', async () => {
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    await manager.startOutput();
    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    await expect(manager.waitForOutputDrain({ timeoutMs: 10 }))
      .rejects.toThrow('RtAudio output drain timed out after 10ms');
  });

  it('rejects an output-drain waiter when the RtAudio stream is stopped', async () => {
    mockRtAudioState.consumeOnWrite = false;
    const manager = new AudioStreamManager();
    await manager.startOutput();
    await manager.playAudio(new Float32Array(256).fill(0.5), 48000);

    const drain = expect(manager.waitForOutputDrain({ timeoutMs: 200 }))
      .rejects.toThrow('output stopped before previous playback drained');
    await manager.stopOutput();
    await drain;
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

  it('keeps legacy ALSA positive short-write warnings on the current stream', async () => {
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();

    const output = (manager as unknown as {
      rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void };
    }).rtAudioOutput;
    output.emitRtAudioError(1, 'RtApiAlsa::callbackEvent: audio write error, Unknown error 256.');

    expect(runtimeErrors).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'RtAudio output callback warning',
      expect.objectContaining({
        kind: 'short-write',
        disposition: 'continue',
        fatal: false,
      }),
    );
    await expect(manager.prepareAudioPlayback('digital')).resolves.toMatchObject({ ready: true });
  });

  it('does not report a virtual output ready after its stream generation failed', () => {
    const manager = new AudioStreamManager();
    const issue: RtAudioRuntimeIssue = {
      issueId: 'issue-android-loss',
      streamGeneration: 7,
      kind: 'device-loss',
      disposition: 'restart-required',
      phase: 'runtime',
      direction: 'output',
      deviceName: 'Android audio output',
      backend: 'android-bridge',
      message: 'Android audio output socket closed unexpectedly',
      sampleRate: 48000,
      bufferSize: 512,
      elapsedSinceOpenMs: null,
      framesConsumed: 0,
      fatal: true,
      runtimeLoss: true,
      at: Date.now(),
    };
    Object.assign(manager as any, {
      isOutputting: true,
      usingAndroidOutput: true,
      outputStreamGeneration: 7,
      outputRuntimeIssueError: new AudioRuntimeIssueError(issue),
    });

    expect(manager.getAudioPlaybackReadiness('digital')).toMatchObject({
      ready: false,
      streamGeneration: 7,
      issue: { issueId: 'issue-android-loss', disposition: 'restart-required' },
    });
  });

  it('ignores a fatal callback from an output stream generation that was already replaced', async () => {
    const manager = new AudioStreamManager();
    const runtimeErrors: Error[] = [];
    manager.on('error', (error) => runtimeErrors.push(error));
    await manager.startOutput();
    const oldOutput = (manager as unknown as {
      rtAudioOutput: { emitRtAudioError: (type: number, message: string) => void };
    }).rtAudioOutput;

    await manager.stopOutput();
    await manager.startOutput();
    oldOutput.emitRtAudioError(5, 'RtApiCore: the stream device was disconnected (and closed)!');

    expect(runtimeErrors).toEqual([]);
    expect(manager.getAudioPlaybackReadiness('digital')).toMatchObject({ ready: true });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Ignoring stale RtAudio output callback',
      expect.objectContaining({ type: 5 }),
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
    expect(isRtAudioRuntimeLossMessage('RtApiAlsa::callbackEvent: audio write error, Unknown error 256.')).toBe(false);
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

  it('fails playback after bounded consecutive RtAudio write errors without acknowledging start', async () => {
    mockRtAudioState.throwOnWrite = true;
    const manager = new AudioStreamManager();
    await manager.startOutput();
    const onPlaybackStarted = vi.fn();

    const failure = await manager.playAudio(
      new Float32Array(256).fill(0.5),
      48000,
      { onPlaybackStarted },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(AudioRuntimeIssueError);
    expect(getAudioRuntimeIssue(failure)).toMatchObject({
      kind: 'driver-failure',
      disposition: 'restart-required',
      direction: 'output',
    });
    expect(failure.message).toContain('20 consecutive times');
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    expect(manager.isPlaying()).toBe(false);
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
