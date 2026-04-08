import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState, mockConfigManager, MockRtAudio } = vi.hoisted(() => {
  const state = {
    devices: [] as Array<{
      id: number;
      name: string;
      inputChannels?: number;
      outputChannels?: number;
      preferredSampleRate?: number;
      isDefaultInput?: boolean;
      isDefaultOutput?: boolean;
    }>,
    openCalls: [] as Array<{ direction: 'input' | 'output'; deviceId: number; streamName: string }>,
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
      _sampleRate: number,
      _bufferSize: number,
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

      state.openCalls.push({ direction, deviceId: params.deviceId, streamName });
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

function setAudioConfig(overrides: Partial<{ inputDeviceName?: string; outputDeviceName?: string; sampleRate: number; bufferSize: number }> = {}) {
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
    setAudioConfig();
    (AudioDeviceManager as unknown as { instance?: AudioDeviceManager }).instance = undefined;
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

  it('rebinds stale input device IDs before opening the stream', async () => {
    mockState.devices = [
      { id: 7, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];

    const streamManager = new AudioStreamManager();
    await streamManager.startStream('input-3');

    expect(mockState.openCalls).toContainEqual({
      direction: 'input',
      deviceId: 7,
      streamName: 'TX5DR-Input',
    });
    expect(streamManager.getStatus().inputDeviceId).toBe('input-7');
  });

  it('raises a temporary unavailable error when the configured input device is still missing', async () => {
    mockState.devices = [
      { id: 5, name: 'Built-in Mic', inputChannels: 1, preferredSampleRate: 48000, isDefaultInput: true },
    ];

    const streamManager = new AudioStreamManager();

    await expect(streamManager.startStream('input-3')).rejects.toMatchObject({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      context: expect.objectContaining({
        temporaryUnavailable: true,
        recoverable: true,
        direction: 'input',
        deviceName: 'IC-705',
      }),
    });
    expect(mockState.openCalls).toHaveLength(0);
  });

  it('rebinds stale output device IDs before opening the stream', async () => {
    mockState.devices = [
      { id: 9, name: 'IC-705', inputChannels: 1, outputChannels: 1, preferredSampleRate: 48000 },
    ];

    const streamManager = new AudioStreamManager();
    await streamManager.startOutput('output-3');

    expect(mockState.openCalls).toContainEqual({
      direction: 'output',
      deviceId: 9,
      streamName: 'TX5DR-Output',
    });
    expect(streamManager.getStatus().outputDeviceId).toBe('output-9');
  });
});
