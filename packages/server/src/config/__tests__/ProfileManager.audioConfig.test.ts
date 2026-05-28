import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioProfile } from '@tx5dr/contracts';

const { state, mockConfigManager, mockEngine, mockReloadAudioConfig } = vi.hoisted(() => {
  const testState = {
    profiles: [] as RadioProfile[],
    activeProfileId: null as string | null,
  };

  const configManager = {
    getActiveProfileId: vi.fn(() => testState.activeProfileId),
    getProfile: vi.fn((id: string) => testState.profiles.find((profile) => profile.id === id) ?? null),
    updateProfile: vi.fn(async (id: string, updates: Partial<RadioProfile>) => {
      const index = testState.profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        throw new Error(`Profile ${id} does not exist`);
      }
      testState.profiles[index] = {
        ...testState.profiles[index],
        ...updates,
        updatedAt: Date.now(),
      } as RadioProfile;
      return testState.profiles[index];
    }),
    updateAudioConfig: vi.fn(async (audioConfig: Partial<NonNullable<RadioProfile['audio']>>) => {
      const profile = testState.profiles.find((item) => item.id === testState.activeProfileId);
      if (!profile) return;
      profile.audio = {
        ...profile.audio,
        ...audioConfig,
      } as RadioProfile['audio'];
      profile.updatedAt = Date.now();
    }),
    setActiveProfileId: vi.fn(async (id: string | null) => {
      testState.activeProfileId = id;
    }),
    getProfiles: vi.fn(() => testState.profiles),
    getActiveProfile: vi.fn(() => testState.profiles.find((profile) => profile.id === testState.activeProfileId) ?? null),
    reorderProfiles: vi.fn(),
    addProfile: vi.fn(),
    deleteProfile: vi.fn(),
  };

  const reloadAudioConfig = vi.fn();
  const engine = {
    getStatus: vi.fn(() => ({ isRunning: false })),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    emit: vi.fn(),
    getAudioStreamManager: vi.fn(() => ({
      reloadAudioConfig,
    })),
    getRadioManager: vi.fn(() => ({
      getActiveConnection: vi.fn(() => null),
    })),
  };

  return {
    state: testState,
    mockConfigManager: configManager,
    mockEngine: engine,
    mockReloadAudioConfig: reloadAudioConfig,
  };
});

vi.mock('../config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => mockConfigManager,
  },
  normalizeAudioDeviceSettings: (audioConfig: Record<string, unknown> | null = {}) => {
    const config = audioConfig ?? {};
    return {
      inputDeviceName: config.inputDeviceName,
      outputDeviceName: config.outputDeviceName,
      inputSampleRate: config.inputSampleRate ?? config.sampleRate ?? 48000,
      outputSampleRate: config.outputSampleRate ?? config.sampleRate ?? 48000,
      inputBufferSize: config.inputBufferSize ?? config.bufferSize ?? 1024,
      outputBufferSize: config.outputBufferSize ?? config.bufferSize ?? 1024,
      outputSampleFormat: config.outputSampleFormat ?? 'float32',
      outputChannelMode: config.outputChannelMode ?? 'mono',
    };
  },
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => mockEngine,
  },
}));

import { ProfileManager } from '../ProfileManager.js';

function makeProfile(overrides: Partial<RadioProfile> = {}): RadioProfile {
  return {
    id: 'profile-1',
    name: 'IC-705',
    radio: { type: 'serial' } as RadioProfile['radio'],
    audio: {
      inputDeviceName: 'IC-705',
      outputDeviceName: 'IC-705',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'float32',
      outputChannelMode: 'mono',
    },
    audioLockedToRadio: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('ProfileManager audio runtime config application', () => {
  beforeEach(() => {
    state.profiles = [makeProfile()];
    state.activeProfileId = 'profile-1';
    vi.clearAllMocks();
    mockEngine.getStatus.mockReturnValue({ isRunning: false });
    (ProfileManager as unknown as { instance?: ProfileManager }).instance = undefined;
  });

  it('saves active Profile audio changes without applying them immediately', async () => {
    mockEngine.getStatus.mockReturnValue({ isRunning: true });
    const manager = ProfileManager.getInstance();

    await manager.updateProfile('profile-1', {
      audio: {
        inputDeviceName: 'IC-705',
        outputDeviceName: 'IC-705',
        inputSampleRate: 16000,
        outputSampleRate: 48000,
        inputBufferSize: 256,
        outputBufferSize: 1024,
      },
    });

    expect(mockEngine.stop).not.toHaveBeenCalled();
    expect(mockReloadAudioConfig).not.toHaveBeenCalled();
    expect(mockEngine.start).not.toHaveBeenCalled();
    expect(state.profiles[0]?.audio.inputSampleRate).toBe(16000);
    expect(state.profiles[0]?.audio.inputBufferSize).toBe(256);
  });

  it('does not apply active Profile changes while saving unchanged audio', async () => {
    mockEngine.getStatus.mockReturnValue({ isRunning: true });
    const manager = ProfileManager.getInstance();

    await manager.updateProfile('profile-1', {
      audio: {
        inputDeviceName: 'IC-705',
        outputDeviceName: 'IC-705',
        inputSampleRate: 48000,
        outputSampleRate: 48000,
        inputBufferSize: 1024,
        outputBufferSize: 1024,
      },
    });

    expect(mockEngine.stop).not.toHaveBeenCalled();
    expect(mockReloadAudioConfig).not.toHaveBeenCalled();
    expect(mockEngine.start).not.toHaveBeenCalled();
  });

  it('merges partial active Profile audio updates before saving without applying them', async () => {
    const manager = ProfileManager.getInstance();

    await manager.updateProfile('profile-1', {
      audio: {
        inputSampleRate: 16000,
      },
    });

    expect(state.profiles[0]?.audio).toMatchObject({
      inputDeviceName: 'IC-705',
      outputDeviceName: 'IC-705',
      inputSampleRate: 16000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'float32',
      outputChannelMode: 'mono',
    });
    expect(mockReloadAudioConfig).not.toHaveBeenCalled();
  });

  it('preserves output sample format and channel mode in Profile audio updates', async () => {
    const manager = ProfileManager.getInstance();

    await manager.updateProfile('profile-1', {
      audio: {
        outputSampleFormat: 'int16',
        outputChannelMode: 'both',
      },
    });

    expect(state.profiles[0]?.audio).toMatchObject({
      inputDeviceName: 'IC-705',
      outputDeviceName: 'IC-705',
      outputSampleFormat: 'int16',
      outputChannelMode: 'both',
    });
    expect(mockReloadAudioConfig).not.toHaveBeenCalled();
  });

  it('broadcasts Profile list updates after active Profile audio config changes', async () => {
    const manager = ProfileManager.getInstance();

    await manager.updateActiveProfileAudioConfig({
      inputSampleRate: 44100,
      outputSampleRate: 44100,
    });

    expect(mockConfigManager.updateAudioConfig).toHaveBeenCalledWith({
      inputSampleRate: 44100,
      outputSampleRate: 44100,
    });
    expect(state.profiles[0]?.audio).toMatchObject({
      inputSampleRate: 44100,
      outputSampleRate: 44100,
    });
    expect(mockEngine.emit).toHaveBeenCalledWith('profileListUpdated', {
      profiles: state.profiles,
      activeProfileId: 'profile-1',
    });
    expect(mockReloadAudioConfig).not.toHaveBeenCalled();
  });

  it('reloads audio config after activating a Profile before starting the engine', async () => {
    const manager = ProfileManager.getInstance();

    await manager.activateProfile('profile-1');

    expect(mockConfigManager.setActiveProfileId).toHaveBeenCalledWith('profile-1');
    expect(mockReloadAudioConfig).toHaveBeenCalledTimes(1);
    expect(mockEngine.start).toHaveBeenCalledTimes(1);
    expect(mockReloadAudioConfig.mock.invocationCallOrder[0]).toBeLessThan(mockEngine.start.mock.invocationCallOrder[0]);
  });
});
