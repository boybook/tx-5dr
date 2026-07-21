import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockState, mockConfigManager, MockRtAudio } = vi.hoisted(() => {
  const state = {
    devices: [] as Array<{
      id: number;
      name: string;
      inputChannels?: number;
      outputChannels?: number;
      preferredSampleRate?: number;
      sampleRates?: number[];
      isDefaultInput?: boolean;
      isDefaultOutput?: boolean;
    }>,
    openCalls: [] as Array<{
      direction: 'input' | 'output';
      deviceId: number;
      streamName: string;
      sampleRate: number;
      bufferSize: number;
    }>,
  };

  class HoistedMockRtAudio {
    constructor(_api: number) {}

    getDevices() {
      return state.devices;
    }

    getDefaultInputDevice() {
      return state.devices.find((device) => (device.inputChannels || 0) > 0)?.id ?? 0;
    }

    getDefaultOutputDevice() {
      return state.devices.find((device) => (device.outputChannels || 0) > 0)?.id ?? 0;
    }

    openStream(
      outputParams: { deviceId: number } | null,
      inputParams: { deviceId: number } | null,
      _format: number,
      sampleRate: number,
      bufferSize: number,
      streamName: string,
    ) {
      const direction = outputParams ? 'output' : 'input';
      const params = outputParams ?? inputParams;
      if (!params) {
        throw new Error('missing stream parameters');
      }

      const target = state.devices.find((device) => (
        device.id === params.deviceId &&
        ((direction === 'input' ? device.inputChannels : device.outputChannels) || 0) > 0
      ));

      if (!target) {
        throw new Error(`RtAudio Error: Code: 7, Message: 'RtApi::openStream: ${direction} device ID is invalid.'`);
      }

      state.openCalls.push({ direction, deviceId: params.deviceId, streamName, sampleRate, bufferSize });
    }

    start() {}
    stop() {}
    closeStream() {}
  }

  return {
    mockState: state,
    mockConfigManager: {
      getAudioConfig: vi.fn(),
      getOpenWebRXStations: vi.fn(() => []),
      getRadioConfig: vi.fn(() => ({ type: 'serial' })),
    },
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
  resampleAudioProfessional: vi.fn(),
}));

import { AudioDeviceManager } from '../audio-device-manager.js';
import { AudioStreamManager } from '../AudioStreamManager.js';
import { RadioErrorCode } from '../../utils/errors/RadioError.js';

function setAudioConfig(overrides: Partial<{
  inputDeviceName?: string;
  outputDeviceName?: string;
  sampleRate: number;
  bufferSize: number;
  inputSampleRate: number;
  outputSampleRate: number;
  inputBufferSize: number;
  outputBufferSize: number;
}> = {}) {
  mockConfigManager.getAudioConfig.mockReturnValue({
    inputDeviceName: 'IC-705',
    outputDeviceName: 'IC-705',
    sampleRate: 48000,
    bufferSize: 1024,
    ...overrides,
  });
}

describe('audio hotplug recovery', () => {
  beforeEach(() => {
    mockState.devices = [];
    mockState.openCalls = [];
    mockConfigManager.getAudioConfig.mockReset();
    mockConfigManager.getOpenWebRXStations.mockClear();
    mockConfigManager.getRadioConfig.mockClear();
    mockConfigManager.getOpenWebRXStations.mockReturnValue([]);
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'serial' });
    delete process.env.TX5DR_RUNTIME_FLAVOR;
    delete process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE;
    setAudioConfig();
    (AudioDeviceManager as unknown as { instance?: AudioDeviceManager }).instance = undefined;
  });

  it('lists Android bridge audio devices from the manifest and resolves them by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx5dr-android-audio-'));
    const manifest = join(dir, 'android-audio-devices.json');
    writeFileSync(manifest, JSON.stringify({
      inputDevices: [
        {
          id: 'android-input-11',
          androidDeviceId: 11,
          name: '[Android] USB Audio CODEC',
          direction: 'input',
          kind: 'usb',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [44100, 48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-input-11.sock',
          available: true,
          isDefault: true,
        },
        {
          id: 'android-input-12',
          androidDeviceId: 12,
          name: '[Android] USB Audio CODEC #2',
          direction: 'input',
          kind: 'usb',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-input-12.sock',
          available: true,
          isDefault: false,
        },
      ],
      outputDevices: [
        {
          id: 'android-output-21',
          androidDeviceId: 21,
          name: '[Android] Phone speaker',
          direction: 'output',
          kind: 'builtinSpeaker',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-output-21.sock',
          available: true,
          isDefault: true,
        },
        {
          id: 'android-output-22',
          androidDeviceId: 22,
          name: '[Android] USB Audio CODEC',
          direction: 'output',
          kind: 'usb',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-output-22.sock',
          available: true,
          isDefault: false,
        },
      ],
    }));
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = manifest;

    const manager = AudioDeviceManager.getInstance();
    const devices = await manager.getAllDevices();

    expect(devices.inputDevices.map((device) => device.name)).toContain('[Android] USB Audio CODEC');
    expect(devices.inputDevices.map((device) => device.name)).toContain('[Android] USB Audio CODEC #2');
    await expect(manager.resolveInputDeviceId('[Android] USB Audio CODEC #2')).resolves.toBe('android-input-12');
    await expect(manager.resolveInputDeviceId()).resolves.toBe('android-input-11');
    await expect(manager.resolveInputDeviceId('TX5DRAndroidUsbInput')).resolves.toBe('android-input-11');
    await expect(manager.resolveOutputDeviceId()).resolves.toBe('android-output-21');
    await expect(manager.resolveOutputDeviceId('TX5DRAndroidOutput')).resolves.toBe('android-output-22');
  });

  it('merges active Android socket devices into manifest devices without duplicating them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx5dr-android-audio-'));
    const manifest = join(dir, 'android-audio-devices.json');
    writeFileSync(manifest, JSON.stringify({
      inputDevices: [
        {
          id: 'android-input-24',
          androidDeviceId: 24,
          name: '[Android] Phone microphone',
          direction: 'input',
          kind: 'builtinMic',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-input-24.sock',
          available: true,
          isDefault: true,
        },
        {
          id: 'android-input-26',
          androidDeviceId: 26,
          name: '[Android] Phone microphone #2',
          direction: 'input',
          kind: 'builtinMic',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-input-26.sock',
          available: true,
          isDefault: false,
        },
      ],
      outputDevices: [
        {
          id: 'android-output-3',
          androidDeviceId: 3,
          name: '[Android] Phone speaker',
          direction: 'output',
          kind: 'builtinSpeaker',
          channels: 1,
          sampleRate: 48000,
          sampleRates: [48000],
          format: 's16le',
          socketPath: '/opt/tx5dr-data/runtime/sockets/audio-output-3.sock',
          available: true,
          isDefault: true,
        },
      ],
    }));
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = manifest;

    const manager = AudioDeviceManager.getInstance();
    manager.markDeviceActive('input', '[Android] Phone microphone', 'android-input-24', 48000, 1);
    manager.markDeviceActive('output', '[Android] Phone speaker', 'android-output-3', 48000, 1);

    const devices = await manager.getAllDevices();

    expect(devices.inputDevices.filter((device) => device.id === 'android-input-24')).toHaveLength(1);
    expect(devices.inputDevices.filter((device) => device.name === '[Android] Phone microphone')).toHaveLength(1);
    expect(devices.inputDevices.find((device) => device.id === 'android-input-24')).toMatchObject({
      isDefault: true,
      availability: 'active',
      isActiveByTx5dr: true,
    });
    expect(devices.inputDevices.map((device) => device.name)).toEqual([
      '[Android] Phone microphone',
      '[Android] Phone microphone #2',
    ]);
    expect(devices.outputDevices.filter((device) => device.id === 'android-output-3')).toHaveLength(1);
    expect(devices.outputDevices.find((device) => device.id === 'android-output-3')).toMatchObject({
      isDefault: true,
      availability: 'active',
      isActiveByTx5dr: true,
    });

    manager.clearActiveDevice('input', '[Android] Phone microphone');
    const refreshed = await manager.getAllDevices();
    expect(refreshed.inputDevices.filter((device) => device.id === 'android-input-24')).toHaveLength(1);
    expect(refreshed.inputDevices.find((device) => device.id === 'android-input-24')).toMatchObject({
      isDefault: true,
      availability: 'available',
      isActiveByTx5dr: false,
    });
  });

  it('re-resolves configured input device IDs from a fresh RtAudio enumeration', async () => {
    const manager = AudioDeviceManager.getInstance();

    mockState.devices = [
      { id: 3, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];
    await expect(manager.resolveInputDeviceId('IC-705')).resolves.toBe('input-3');

    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];
    await expect(manager.resolveInputDeviceId('IC-705')).resolves.toBe('input-7');
  });

  it('resolves empty audio settings to default devices', async () => {
    mockState.devices = [
      { id: 1, name: 'Built-in Mic', inputChannels: 1, outputChannels: 0, preferredSampleRate: 48000, isDefaultInput: true },
      { id: 2, name: 'Built-in Speaker', inputChannels: 0, outputChannels: 2, preferredSampleRate: 48000, isDefaultOutput: true },
    ];
    const manager = AudioDeviceManager.getInstance();

    const resolution = await manager.resolveAudioSettings({ sampleRate: 48000, bufferSize: 1024 });

    expect(resolution.input.status).toBe('default');
    expect(resolution.input.effectiveDevice?.name).toBe('Built-in Mic');
    expect(resolution.output.status).toBe('default');
    expect(resolution.output.effectiveDevice?.name).toBe('Built-in Speaker');
  });

  it('resolves configured physical devices as selected', async () => {
    mockState.devices = [
      { id: 3, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true, isDefaultOutput: true },
    ];
    const manager = AudioDeviceManager.getInstance();

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'IC-705',
      outputDeviceName: 'IC-705',
      sampleRate: 48000,
      bufferSize: 1024,
    });

    expect(resolution.input.status).toBe('selected');
    expect(resolution.output.status).toBe('selected');
  });

  it('resolves same-named input and output endpoints in their own directions', async () => {
    mockState.devices = [
      { id: 129, name: 'USB Audio CODEC', inputChannels: 0, outputChannels: 2, preferredSampleRate: 44100 },
      { id: 130, name: 'USB Audio CODEC', inputChannels: 1, outputChannels: 0, preferredSampleRate: 48000 },
    ];
    const manager = AudioDeviceManager.getInstance();

    await expect(manager.resolveInputDeviceId('USB Audio CODEC')).resolves.toBe('input-130');
    await expect(manager.resolveOutputDeviceId('USB Audio CODEC')).resolves.toBe('output-129');

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'USB Audio CODEC',
      outputDeviceName: 'USB Audio CODEC',
      sampleRate: 48000,
      bufferSize: 1024,
    });

    expect(resolution.input.effectiveDevice?.id).toBe('input-130');
    expect(resolution.input.effectiveDevice?.type).toBe('input');
    expect(resolution.output.effectiveDevice?.id).toBe('output-129');
    expect(resolution.output.effectiveDevice?.type).toBe('output');
  });

  it('does not resolve an input-only same-named endpoint as an output device', async () => {
    mockState.devices = [
      { id: 130, name: 'USB Audio CODEC', inputChannels: 1, outputChannels: 0, preferredSampleRate: 48000 },
    ];
    const manager = AudioDeviceManager.getInstance();

    await expect(manager.resolveOutputDeviceId('USB Audio CODEC')).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      context: expect.objectContaining({
        direction: 'output',
        deviceName: 'USB Audio CODEC',
      }),
    });

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'USB Audio CODEC',
      outputDeviceName: 'USB Audio CODEC',
      sampleRate: 48000,
      bufferSize: 1024,
    });

    expect(resolution.input.status).toBe('selected');
    expect(resolution.output.status).toBe('missing');
    expect(resolution.output.effectiveDevice).toBeNull();
  });

  it('returns sorted sample rates and backend buffer size options', async () => {
    mockState.devices = [
      {
        id: 3,
        name: 'IC-705',
        inputChannels: 1,
        outputChannels: 1,
        preferredSampleRate: 48000,
        sampleRates: [48000, 16000, 44100, 16000],
        isDefaultInput: true,
        isDefaultOutput: true,
      },
    ];
    const manager = AudioDeviceManager.getInstance();

    const devices = await manager.getAllDevices();

    expect(devices.inputDevices[0]?.sampleRates).toEqual([16000, 44100, 48000]);
    expect(devices.outputDevices[0]?.sampleRates).toEqual([16000, 44100, 48000]);
    expect(devices.inputBufferSizes).toContain(768);
    expect(devices.outputBufferSizes).toContain(768);
  });

  it('does not invent sample rate lists for physical devices that do not report them', async () => {
    mockState.devices = [
      {
        id: 3,
        name: 'IC-705',
        inputChannels: 1,
        outputChannels: 1,
        preferredSampleRate: 48000,
        isDefaultInput: true,
        isDefaultOutput: true,
      },
    ];
    const manager = AudioDeviceManager.getInstance();

    const devices = await manager.getAllDevices();

    expect(devices.inputDevices[0]?.sampleRate).toBe(48000);
    expect(devices.inputDevices[0]?.sampleRates).toBeUndefined();
    expect(devices.outputDevices[0]?.sampleRates).toBeUndefined();
  });

  it('keeps previously seen devices as cached when a refresh no longer enumerates them', async () => {
    mockState.devices = [
      { id: 3, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];
    const manager = AudioDeviceManager.getInstance();

    const first = await manager.getAllDevices();
    expect(first.inputDevices.find((device) => device.name === 'IC-705')?.availability).toBe('available');

    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];
    const second = await manager.getAllDevices();

    const cached = second.inputDevices.find((device) => device.name === 'IC-705');
    expect(cached?.availability).toBe('cached');
    expect(cached?.id).toBe('input-3');
  });

  it('updates matching registry devices and appends newly seen devices during refresh', async () => {
    mockState.devices = [
      { id: 3, name: 'IC-705', inputChannels: 1, preferredSampleRate: 48000 },
    ];
    const manager = AudioDeviceManager.getInstance();
    await manager.getAllDevices();

    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 2, preferredSampleRate: 44100, sampleRates: [44100] },
      { id: 8, name: 'USB Mic', inputChannels: 1, preferredSampleRate: 48000 },
    ];
    const devices = await manager.getAllDevices();

    expect(devices.inputDevices.find((device) => device.name === 'IC-705')).toMatchObject({
      id: 'input-7',
      channels: 2,
      sampleRate: 44100,
      availability: 'available',
    });
    expect(devices.inputDevices.find((device) => device.name === 'USB Mic')?.availability).toBe('available');
  });

  it('reports missing when configured physical devices disappear', async () => {
    mockState.devices = [
      { id: 1, name: 'Built-in Mic', inputChannels: 1, outputChannels: 0, preferredSampleRate: 48000, isDefaultInput: true },
      { id: 2, name: 'Built-in Speaker', inputChannels: 0, outputChannels: 2, preferredSampleRate: 48000, isDefaultOutput: true },
    ];
    const manager = AudioDeviceManager.getInstance();

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'Missing USB',
      outputDeviceName: 'Missing USB',
      sampleRate: 48000,
      bufferSize: 1024,
    });

    expect(resolution.input.status).toBe('missing');
    expect(resolution.input.effectiveDevice).toBeNull();
    expect(resolution.output.status).toBe('missing');
    expect(resolution.output.effectiveDevice).toBeNull();
  });

  it('treats ICOM WLAN as a virtual selected device for ICOM WLAN profiles', async () => {
    mockState.devices = [];
    const manager = AudioDeviceManager.getInstance();

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'ICOM WLAN',
      outputDeviceName: 'ICOM WLAN',
      sampleRate: 48000,
      bufferSize: 1024,
    }, 'icom-wlan');

    expect(resolution.input.status).toBe('virtual-selected');
    expect(resolution.input.effectiveDevice?.id).toBe('icom-wlan-input');
    expect(resolution.output.status).toBe('virtual-selected');
    expect(resolution.output.effectiveDevice?.id).toBe('icom-wlan-output');
  });

  it('treats TCI Audio as a virtual selected device for TCI profiles', async () => {
    mockState.devices = [];
    mockConfigManager.getRadioConfig.mockReturnValue({
      type: 'tci',
      tci: { host: '127.0.0.1', port: 40001, audioEnabled: true, audioSampleRate: 12000 },
    } as never);
    const manager = AudioDeviceManager.getInstance();

    const resolution = await manager.resolveAudioSettings({
      inputDeviceName: 'TCI Audio',
      outputDeviceName: 'TCI Audio',
      sampleRate: 48000,
      bufferSize: 1024,
    }, 'tci');

    expect(resolution.input.status).toBe('virtual-selected');
    expect(resolution.input.effectiveDevice).toMatchObject({ id: 'tci-input', sampleRate: 12000 });
    expect(resolution.output.status).toBe('virtual-selected');
    expect(resolution.output.effectiveDevice).toMatchObject({ id: 'tci-output', sampleRate: 12000 });
  });

  it('resolves existing OpenWebRX virtual input devices and marks removed stations missing', async () => {
    mockState.devices = [
      { id: 1, name: 'Built-in Mic', inputChannels: 1, outputChannels: 0, preferredSampleRate: 48000, isDefaultInput: true },
    ];
    mockConfigManager.getOpenWebRXStations.mockReturnValueOnce([{ id: 'remote', name: 'Remote SDR' }] as any);
    const manager = AudioDeviceManager.getInstance();

    const existing = await manager.resolveAudioSettings({
      inputDeviceName: '[SDR] Remote SDR',
      sampleRate: 48000,
      bufferSize: 1024,
    }, 'serial');
    expect(existing.input.status).toBe('virtual-selected');
    expect(existing.input.effectiveDevice?.id).toBe('openwebrx-remote');

    mockConfigManager.getOpenWebRXStations.mockReturnValue([]);
    const missing = await manager.resolveAudioSettings({
      inputDeviceName: '[SDR] Remote SDR',
      sampleRate: 48000,
      bufferSize: 1024,
    }, 'serial');
    expect(missing.input.status).toBe('missing');
  });

  it('uses the current live input device ID before opening the stream', async () => {
    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];

    const streamManager = new AudioStreamManager();
    await streamManager.startStream('input-3');

    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'input',
      deviceId: 7,
      streamName: 'TX5DR-Input',
    }));
    expect(streamManager.getStatus().inputDeviceId).toBe('input-7');
  });

  it('raises a temporary unavailable error when the configured input device is still missing', async () => {
    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    const streamManager = new AudioStreamManager();

    await expect(streamManager.startStream('input-3')).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      userMessageKey: 'radio:audioSidecar.errorInputDeviceUnavailable',
      userMessageParams: { deviceName: 'IC-705' },
      context: expect.objectContaining({
        temporaryUnavailable: true,
        recoverable: true,
        direction: 'input',
        deviceName: 'IC-705',
      }),
    });
    expect(mockState.openCalls).toHaveLength(0);
  });

  it('does not fall back to default input when the configured device name is missing', async () => {
    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    const streamManager = new AudioStreamManager();

    await expect(streamManager.startStream()).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      userMessageKey: 'radio:audioSidecar.errorInputDeviceUnavailable',
      userMessageParams: { deviceName: 'IC-705' },
      context: expect.objectContaining({
        temporaryUnavailable: true,
        recoverable: true,
        direction: 'input',
        deviceName: 'IC-705',
      }),
    });
    expect(mockState.openCalls).toHaveLength(0);
  });

  it('retries with a fresh device enumeration after a configured input device reappears', async () => {
    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    const streamManager = new AudioStreamManager();
    await expect(streamManager.startStream()).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
    });

    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, preferredSampleRate: 48000 },
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    await streamManager.startStream();

    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'input',
      deviceId: 7,
      streamName: 'TX5DR-Input',
    }));
  });

  it('keeps a TX-5DR active input device in the registry while live enumeration misses it', async () => {
    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, preferredSampleRate: 48000 },
    ];
    const streamManager = new AudioStreamManager();
    await streamManager.startStream();

    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];
    const devices = await AudioDeviceManager.getInstance().getAllDevices();

    expect(devices.inputDevices.find((device) => device.name === 'IC-705')).toMatchObject({
      availability: 'active',
      isActiveByTx5dr: true,
      id: 'input-7',
    });
    expect(mockState.openCalls.filter((call) => call.direction === 'input')).toHaveLength(1);

    await streamManager.startStream();
    expect(mockState.openCalls.filter((call) => call.direction === 'input')).toHaveLength(1);
  });

  it('rejects cached configured input devices instead of opening stale IDs or falling back', async () => {
    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, preferredSampleRate: 48000 },
    ];
    const manager = AudioDeviceManager.getInstance();
    await manager.getAllDevices();

    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    const streamManager = new AudioStreamManager();
    await expect(streamManager.startStream()).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      context: expect.objectContaining({
        availability: 'cached',
        deviceName: 'IC-705',
      }),
    });
    expect(mockState.openCalls).toHaveLength(0);
  });

  it('uses default devices when audio settings leave device names empty', async () => {
    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
      { id: 6, name: 'Built-in Speaker', outputChannels: 2, preferredSampleRate: 48000, isDefaultOutput: true },
    ];
    setAudioConfig({ inputDeviceName: undefined, outputDeviceName: undefined });

    const streamManager = new AudioStreamManager();
    await streamManager.startStream();
    await streamManager.startOutput();

    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'input',
      deviceId: 5,
      streamName: 'TX5DR-Input',
    }));
    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'output',
      deviceId: 6,
      streamName: 'TX5DR-Output',
    }));
  });

  it('uses separate reloaded input and output audio parameters when opening RtAudio streams', async () => {
    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];

    const streamManager = new AudioStreamManager();
    setAudioConfig({
      inputSampleRate: 16000,
      outputSampleRate: 48000,
      inputBufferSize: 256,
      outputBufferSize: 1024,
    });
    streamManager.reloadAudioConfig();

    await streamManager.startStream();
    await streamManager.startOutput();

    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'input',
      deviceId: 7,
      streamName: 'TX5DR-Input',
      sampleRate: 16000,
      bufferSize: 256,
    }));
    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'output',
      deviceId: 7,
      streamName: 'TX5DR-Output',
      sampleRate: 48000,
      bufferSize: 1024,
    }));
  });

  it('uses the current live output device ID before opening the stream', async () => {
    mockState.devices = [
      { id: 9, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];

    const streamManager = new AudioStreamManager();
    await streamManager.startOutput('output-3');

    expect(mockState.openCalls).toContainEqual(expect.objectContaining({
      direction: 'output',
      deviceId: 9,
      streamName: 'TX5DR-Output',
    }));
    expect(streamManager.getStatus().outputDeviceId).toBe('output-9');
  });

  it('does not fall back to default output when the configured device name is missing', async () => {
    mockState.devices = [
      { id: 6, name: 'Built-in Speaker', outputChannels: 2, preferredSampleRate: 48000, isDefaultOutput: true },
    ];

    const streamManager = new AudioStreamManager();

    await expect(streamManager.startOutput()).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      userMessageKey: 'radio:audioSidecar.errorOutputDeviceUnavailable',
      userMessageParams: { deviceName: 'IC-705' },
      context: expect.objectContaining({
        temporaryUnavailable: true,
        recoverable: true,
        direction: 'output',
        deviceName: 'IC-705',
      }),
    });
    expect(mockState.openCalls).toHaveLength(0);
  });
});
