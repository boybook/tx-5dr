import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfigManager, mockAndroidOutputState, MockAndroidAudioOutputSocket, MockRtAudio } = vi.hoisted(() => {
  const androidOutputState = {
    starts: 0,
    stops: 0,
    instances: [] as Array<{ device: unknown; streamConfig: unknown }>,
  };

  class HoistedMockAndroidAudioOutputSocket {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(device: unknown, streamConfig: unknown) {
      androidOutputState.instances.push({ device, streamConfig, socket: this } as never);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    async start() {
      androidOutputState.starts += 1;
    }

    stop() {
      androidOutputState.stops += 1;
    }
  }

  class HoistedMockAndroidAudioInputSocket {
    start = vi.fn(async () => undefined);
    stop = vi.fn();
    on = vi.fn();
  }

  class HoistedMockRtAudio {
    getDevices() { return []; }
    getDefaultInputDevice() { return 0; }
    getDefaultOutputDevice() { return 0; }
  }

  return {
    mockConfigManager: {
      getAudioConfig: vi.fn(),
      getOpenWebRXStations: vi.fn(() => []),
      getRadioConfig: vi.fn(() => ({ type: 'serial' })),
    },
    mockAndroidOutputState: androidOutputState,
    MockAndroidAudioOutputSocket: HoistedMockAndroidAudioOutputSocket,
    MockAndroidAudioInputSocket: HoistedMockAndroidAudioInputSocket,
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
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../AndroidAudioSocketBackend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AndroidAudioSocketBackend.js')>();
  return {
    ...actual,
    AndroidAudioInputSocket: vi.fn().mockImplementation(() => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      on: vi.fn(),
    })),
    AndroidAudioOutputSocket: MockAndroidAudioOutputSocket,
  };
});

import { AudioDeviceManager } from '../audio-device-manager.js';
import { AudioStreamManager } from '../AudioStreamManager.js';

function writeAndroidManifest(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tx5dr-android-output-'));
  const manifest = join(dir, 'android-audio-devices.json');
  writeFileSync(manifest, JSON.stringify({
    inputDevices: [],
    outputDevices: [
      {
        id: 'android-output-21',
        androidDeviceId: 21,
        name: '[Android] USB Audio CODEC',
        direction: 'output',
        kind: 'usb',
        channels: 1,
        sampleRate: 48000,
        sampleRates: [48000, 44100],
        format: 's16le',
        formats: ['s16le', 'f32le'],
        socketPath: '/opt/tx5dr-data/runtime/sockets/audio-output-21.sock',
        available: true,
        isDefault: true,
        ...overrides,
      },
    ],
  }));
  return manifest;
}

describe('AudioStreamManager Android output contract', () => {
  beforeEach(() => {
    mockAndroidOutputState.starts = 0;
    mockAndroidOutputState.stops = 0;
    mockAndroidOutputState.instances = [];
    mockConfigManager.getAudioConfig.mockReset();
    mockConfigManager.getOpenWebRXStations.mockClear();
    mockConfigManager.getRadioConfig.mockClear();
    mockConfigManager.getOpenWebRXStations.mockReturnValue([]);
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'serial' });
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeAndroidManifest();
    (AudioDeviceManager as unknown as { instance?: AudioDeviceManager }).instance = undefined;
  });

  it('keeps configured 44100Hz Android output rate and maps float32 to f32le mono', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: '[Android] USB Audio CODEC',
      outputDeviceName: '[Android] USB Audio CODEC',
      inputSampleRate: 48000,
      outputSampleRate: 44100,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'float32',
      outputChannelMode: 'both',
    });
    const manager = new AudioStreamManager();

    await manager.startOutput();

    expect(mockAndroidOutputState.starts).toBe(1);
    expect(mockAndroidOutputState.instances[0]?.streamConfig).toEqual({
      sampleRate: 44100,
      format: 'f32le',
      channels: 1,
    });
    expect(manager.getStatus()).toMatchObject({
      outputSampleRate: 44100,
      outputChannels: 1,
    });
  });

  it('maps Android int16 output to s16le mono', async () => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      outputDeviceName: '[Android] USB Audio CODEC',
      inputSampleRate: 48000,
      outputSampleRate: 44100,
      inputBufferSize: 64,
      outputBufferSize: 64,
      outputSampleFormat: 'int16',
      outputChannelMode: 'right',
    });
    const manager = new AudioStreamManager();

    await manager.startOutput();

    expect(mockAndroidOutputState.instances[0]?.streamConfig).toEqual({
      sampleRate: 44100,
      format: 's16le',
      channels: 1,
    });
    expect(manager.getStatus().outputChannels).toBe(1);
  });
});
