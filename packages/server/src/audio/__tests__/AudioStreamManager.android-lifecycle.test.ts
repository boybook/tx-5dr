import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfigManager,
  mockState,
  MockAndroidAudioInputSocket,
  MockAndroidAudioOutputSocket,
  MockRtAudio,
} = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type DeferredResample = {
    samples: Float32Array;
    resolve: (samples: Float32Array) => void;
  };

  const state = {
    audioConfig: {} as Record<string, unknown>,
    inputs: [] as Array<HoistedMockAndroidAudioInputSocket>,
    outputs: [] as Array<HoistedMockAndroidAudioOutputSocket>,
    resampleCalls: 0,
    activeResamples: 0,
    maxActiveResamples: 0,
    deferredResamples: [] as DeferredResample[],
  };

  class HoistedSocket {
    readonly listeners = new Map<string, Listener[]>();
    stopped = false;

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    emitEvent(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    async start() {}

    stop() {
      this.stopped = true;
    }
  }

  class HoistedMockAndroidAudioInputSocket extends HoistedSocket {
    constructor(readonly device: { id: string; routeKey?: string }) {
      super();
      state.inputs.push(this);
    }
  }

  class HoistedMockAndroidAudioOutputSocket extends HoistedSocket {
    constructor(
      readonly device: { id: string; routeKey?: string },
      readonly streamConfig: unknown,
    ) {
      super();
      state.outputs.push(this);
    }

    async write() {
      return true;
    }
  }

  class HoistedMockRtAudio {
    getDevices() { return []; }
    getDefaultInputDevice() { return 0; }
    getDefaultOutputDevice() { return 0; }
  }

  return {
    mockConfigManager: {
      getAudioConfig: vi.fn(() => state.audioConfig),
      getOpenWebRXStations: vi.fn(() => []),
      getRadioConfig: vi.fn(() => ({ type: 'serial' })),
    },
    mockState: state,
    MockAndroidAudioInputSocket: HoistedMockAndroidAudioInputSocket,
    MockAndroidAudioOutputSocket: HoistedMockAndroidAudioOutputSocket,
    MockRtAudio: HoistedMockRtAudio,
  };
});

vi.mock('audify', () => ({ default: { RtAudio: MockRtAudio } }));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: { getInstance: () => mockConfigManager },
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../utils/audioUtils.js', () => ({
  clearResamplerCache: vi.fn(),
  resampleAudioProfessional: vi.fn((samples: Float32Array) => {
    mockState.resampleCalls += 1;
    mockState.activeResamples += 1;
    mockState.maxActiveResamples = Math.max(mockState.maxActiveResamples, mockState.activeResamples);
    return new Promise<Float32Array>((resolve) => {
      mockState.deferredResamples.push({
        samples,
        resolve: (result) => {
          mockState.activeResamples -= 1;
          resolve(result);
        },
      });
    });
  }),
}));

vi.mock('../AndroidAudioSocketBackend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AndroidAudioSocketBackend.js')>();
  return {
    ...actual,
    AndroidAudioInputSocket: MockAndroidAudioInputSocket,
    AndroidAudioOutputSocket: MockAndroidAudioOutputSocket,
  };
});

import { AudioDeviceManager } from '../audio-device-manager.js';
import { AudioStreamManager } from '../AudioStreamManager.js';

function writeManifest(options: {
  inputId?: number;
  outputId?: number;
  inputState?: string;
  outputState?: string;
  inputFailure?: string;
  outputFailure?: string;
} = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx5dr-android-lifecycle-'));
  const file = join(directory, 'devices.json');
  const inputId = options.inputId ?? 7;
  const outputId = options.outputId ?? 8;
  writeFileSync(file, JSON.stringify({
    inputDevices: [{
      id: `android-input-${inputId}`,
      androidDeviceId: inputId,
      name: '[Android] Wired headset',
      direction: 'input',
      kind: 'wiredHeadset',
      channels: 1,
      sampleRate: 48000,
      sampleRates: [48000],
      format: 's16le',
      socketPath: `/tmp/input-${inputId}.sock`,
      available: true,
      isDefault: true,
      routeKey: 'android:wired-headset:input',
      routeVerified: false,
      routeState: options.inputState ?? 'idle',
      ...(options.inputFailure ? { failureReason: options.inputFailure } : {}),
    }],
    outputDevices: [{
      id: `android-output-${outputId}`,
      androidDeviceId: outputId,
      name: '[Android] Wired headset',
      direction: 'output',
      kind: 'wiredHeadset',
      channels: 1,
      sampleRate: 48000,
      sampleRates: [48000],
      format: 's16le',
      socketPath: `/tmp/output-${outputId}.sock`,
      available: true,
      isDefault: true,
      routeKey: 'android:wired-headset:output',
      routeVerified: false,
      routeState: options.outputState ?? 'idle',
      ...(options.outputFailure ? { failureReason: options.outputFailure } : {}),
    }],
  }));
  return file;
}

describe('AudioStreamManager Android lifecycle', () => {
  beforeEach(() => {
    mockState.inputs = [];
    mockState.outputs = [];
    mockState.resampleCalls = 0;
    mockState.activeResamples = 0;
    mockState.maxActiveResamples = 0;
    mockState.deferredResamples = [];
    mockState.audioConfig = {
      inputDeviceName: '[Android] Wired headset',
      outputDeviceName: '[Android] Wired headset',
      inputRouteKey: 'android:wired-headset:input',
      outputRouteKey: 'android:wired-headset:output',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'int16',
      outputChannelMode: 'mono',
    };
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest();
    (AudioDeviceManager as unknown as { instance?: AudioDeviceManager }).instance = undefined;
  });

  it('raises each active socket loss once and suppresses shutdown noise', async () => {
    const manager = new AudioStreamManager();
    const errors: string[] = [];
    manager.on('error', (error) => errors.push(error.message));
    await manager.startStream();
    await manager.startOutput();

    const input = mockState.inputs[0]!;
    const output = mockState.outputs[0]!;
    input.emitEvent('error', new Error('input route lost'));
    input.emitEvent('close');
    output.emitEvent('close');
    output.emitEvent('error', new Error('late output error'));

    expect(errors).toEqual([
      'input route lost',
      'Android audio output socket closed unexpectedly: [Android] Wired headset',
    ]);
    await manager.stopOutput();
    await manager.stopStream();
    input.emitEvent('close');
    output.emitEvent('close');
    expect(errors).toHaveLength(2);
  });

  it('fails output startup when Android input was lost before the sidecar became connected', async () => {
    const manager = new AudioStreamManager();
    const errors: string[] = [];
    manager.on('error', (error) => errors.push(error.message));
    await manager.startStream();
    mockState.inputs[0]!.emitEvent('close');

    await expect(manager.startOutput()).rejects.toThrow('Android audio input socket closed unexpectedly');
    expect(mockState.outputs).toHaveLength(0);
    expect(errors).toEqual(['Android audio input socket closed unexpectedly: [Android] Wired headset']);
  });

  it('allows a fresh socket session to retry an available endpoint after a historical route failure', async () => {
    const manager = new AudioStreamManager();
    await manager.startStream();
    expect(mockState.inputs).toHaveLength(1);
    await manager.stopStream();

    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest({
      inputState: 'failed',
      inputFailure: 'preferred route mismatch',
    });
    const failedManager = new AudioStreamManager();
    failedManager.on('error', () => undefined);
    await expect(failedManager.startStream()).resolves.toBeUndefined();
    expect(mockState.inputs).toHaveLength(2);
  });

  it('clears an input route loss after an intentional stop so output-only restart can proceed', async () => {
    const manager = new AudioStreamManager();
    manager.on('error', () => undefined);
    await manager.startStream();
    mockState.inputs[0]!.emitEvent('error', new Error('input route lost'));

    await manager.stopStream();
    await expect(manager.startOutput()).resolves.toBeUndefined();
    expect(mockState.outputs).toHaveLength(1);
    await manager.stopOutput();
  });

  it('serializes Android input resampling and preserves chunk order', async () => {
    const manager = new AudioStreamManager();
    const received: number[] = [];
    manager.on('audioData', (samples) => received.push(samples[0] ?? 0));
    await manager.startStream();

    const input = mockState.inputs[0]!;
    input.emitEvent('audioData', new Float32Array([1]), 48000);
    input.emitEvent('audioData', new Float32Array([2]), 48000);
    await vi.waitFor(() => expect(mockState.resampleCalls).toBe(1));
    expect(mockState.maxActiveResamples).toBe(1);

    mockState.deferredResamples[0]!.resolve(new Float32Array([1]));
    await vi.waitFor(() => expect(mockState.resampleCalls).toBe(2));
    expect(mockState.maxActiveResamples).toBe(1);
    mockState.deferredResamples[1]!.resolve(new Float32Array([2]));
    await vi.waitFor(() => expect(received).toEqual([1, 2]));
  });

  it('bounds serialized Android input work instead of accumulating unlimited latency', async () => {
    const manager = new AudioStreamManager();
    const received: number[] = [];
    manager.on('audioData', (samples) => received.push(samples[0] ?? 0));
    await manager.startStream();

    const input = mockState.inputs[0]!;
    for (let value = 1; value <= 5; value += 1) {
      input.emitEvent('audioData', new Float32Array([value]), 48000);
    }
    await vi.waitFor(() => expect(mockState.resampleCalls).toBe(1));

    mockState.deferredResamples[0]!.resolve(new Float32Array([1]));
    await vi.waitFor(() => expect(mockState.resampleCalls).toBe(2));
    mockState.deferredResamples[1]!.resolve(new Float32Array([2]));
    await vi.waitFor(() => expect(mockState.resampleCalls).toBe(3));
    mockState.deferredResamples[2]!.resolve(new Float32Array([3]));
    await vi.waitFor(() => expect(received).toEqual([1, 2, 3]));
    expect(mockState.resampleCalls).toBe(3);
  });

  it('reconnects the same route key after Android assigns a different numeric ID', async () => {
    const manager = new AudioStreamManager();
    await manager.startStream();
    expect(mockState.inputs[0]?.device.id).toBe('android-input-7');
    await manager.stopStream();

    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest({ inputId: 99 });
    await manager.startStream();
    expect(mockState.inputs[1]?.device).toMatchObject({
      id: 'android-input-99',
      routeKey: 'android:wired-headset:input',
    });
  });
});
