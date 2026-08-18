import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  state,
  mockResolveAudioSettings,
  mockUpdateActiveProfileAudioConfig,
  mockReloadAudioConfig,
  mockEngineStop,
  mockEngineStart,
} = vi.hoisted(() => {
  const testState = {
    running: false,
    audio: {} as Record<string, unknown>,
    runtimeInputSignalType: 'icom-12k-if' as 'af' | 'icom-12k-if',
    runtimeIfCenterHz: 11750,
  };
  const resolveAudioSettings = vi.fn(async () => ({
    input: {
      configuredDeviceName: null,
      configuredDevice: null,
      effectiveDevice: null,
      status: 'default',
    },
    output: {
      configuredDeviceName: null,
      configuredDevice: null,
      effectiveDevice: null,
      status: 'default',
    },
  }));
  const updateActiveProfileAudioConfig = vi.fn(async (update: Record<string, unknown>) => {
    testState.audio = { ...testState.audio, ...update };
  });
  const reloadAudioConfig = vi.fn(() => {
    testState.runtimeInputSignalType = testState.audio.inputSignalType === 'icom-12k-if'
      ? 'icom-12k-if'
      : 'af';
    testState.runtimeIfCenterHz = Number(testState.audio.ifCenterHz ?? 12000);
  });

  return {
    state: testState,
    mockResolveAudioSettings: resolveAudioSettings,
    mockUpdateActiveProfileAudioConfig: updateActiveProfileAudioConfig,
    mockReloadAudioConfig: reloadAudioConfig,
    mockEngineStop: vi.fn(async () => {}),
    mockEngineStart: vi.fn(async () => {}),
  };
});

vi.mock('../../audio/audio-device-manager.js', () => ({
  AudioDeviceManager: {
    getInstance: () => ({ resolveAudioSettings: mockResolveAudioSettings }),
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({ getAudioConfig: () => ({ ...state.audio }) }),
  },
}));

vi.mock('../../config/ProfileManager.js', () => ({
  ProfileManager: {
    getInstance: () => ({ updateActiveProfileAudioConfig: mockUpdateActiveProfileAudioConfig }),
  },
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getStatus: () => ({ isRunning: state.running }),
      stop: mockEngineStop,
      start: mockEngineStart,
      getAudioStreamManager: () => ({ reloadAudioConfig: mockReloadAudioConfig }),
    }),
  },
}));

describe('audio settings reset', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    state.running = false;
    state.audio = {
      inputDeviceName: 'IC-705 USB Audio',
      outputDeviceName: 'IC-705 USB Audio',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'float32',
      outputChannelMode: 'mono',
      inputSignalType: 'icom-12k-if',
      ifCenterHz: 11750,
    };
    state.runtimeInputSignalType = 'icom-12k-if';
    state.runtimeIfCenterHz = 11750;

    const { audioRoutes } = await import('../audio.js');
    fastify = Fastify();
    await fastify.register(audioRoutes, { prefix: '/api/audio' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it.each([false, true])('restores AF defaults when engine running is %s', async (running) => {
    state.running = running;

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/audio/settings/reset',
    });

    expect(response.statusCode).toBe(200);
    expect(mockUpdateActiveProfileAudioConfig).toHaveBeenCalledWith(expect.objectContaining({
      inputSignalType: 'af',
      ifCenterHz: 12000,
    }));
    expect(mockReloadAudioConfig).toHaveBeenCalledTimes(1);
    expect(state.runtimeInputSignalType).toBe('af');
    expect(state.runtimeIfCenterHz).toBe(12000);
    expect(response.json().currentSettings).toMatchObject({
      inputSignalType: 'af',
      ifCenterHz: 12000,
    });

    if (running) {
      expect(mockEngineStop).toHaveBeenCalledTimes(1);
      expect(mockEngineStart).toHaveBeenCalledTimes(1);
    } else {
      expect(mockEngineStop).not.toHaveBeenCalled();
      expect(mockEngineStart).not.toHaveBeenCalled();
    }
  });
});
