import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { ConfigManager } from '../../config/config-manager.js';
import { AudioVolumeController } from '../AudioVolumeController.js';

type ProfileType = 'tci' | 'serial';

function createController(options: {
  profileType: ProfileType;
  profileId?: string;
  mode?: 'digital' | 'voice' | 'cw' | 'image';
  band?: string;
  saved?: { gain: number; gainDb: number } | null;
  updateVolumeGainForProfileSlot?: (...args: any[]) => Promise<void>;
}) {
  const profileId = options.profileId ?? 'profile-a';
  let activeProfileId = profileId;
  const emitter = new EventEmitter<DigitalRadioEngineEvents>();
  let audioStreamManager: any;
  audioStreamManager = {
    gain: Math.pow(10, -10 / 20),
    gainDb: -10,
    setVolumeGain: vi.fn((gain: number): void => {
      audioStreamManager.gain = gain;
      audioStreamManager.gainDb = 20 * Math.log10(Math.max(0.001, gain));
    }),
    setVolumeGainDb: vi.fn((gainDb: number): void => {
      audioStreamManager.gainDb = gainDb;
      audioStreamManager.gain = Math.pow(10, gainDb / 20);
    }),
    getVolumeGain: vi.fn((): number => audioStreamManager.gain),
    getVolumeGainDb: vi.fn((): number => audioStreamManager.gainDb),
  };
  const configManager = {
    getActiveProfile: vi.fn(() => ({ id: activeProfileId, radio: { type: options.profileType } })),
    getActiveProfileId: vi.fn(() => activeProfileId),
    getLastEngineMode: vi.fn(() => options.mode ?? 'digital'),
    getLastSelectedFrequency: vi.fn(() => ({ band: options.band ?? '20m', frequency: 14_074_000, mode: 'FT8' })),
    getVolumeGainForProfileSlot: vi.fn(() => options.saved ?? null),
    getVolumeGainForSlot: vi.fn(() => options.saved ?? null),
    updateVolumeGainForProfileSlot: options.updateVolumeGainForProfileSlot ?? vi.fn(async () => undefined),
    updateVolumeGainForSlot: vi.fn(async () => undefined),
  } as unknown as ConfigManager;

  vi.spyOn(ConfigManager, 'getInstance').mockReturnValue(configManager);
  const controller = new AudioVolumeController(
    emitter,
    audioStreamManager as any,
    () => options.mode ?? 'digital',
  );
  controller.setupEventListeners();
  controller.restoreGainForCurrentSlot();

  return {
    controller,
    emitter,
    audioStreamManager,
    configManager,
    setActiveProfileId: (id: string) => { activeProfileId = id; },
  };
}

describe('AudioVolumeController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses 0 dB as the default for a TCI Profile', () => {
    const { audioStreamManager } = createController({ profileType: 'tci' });

    expect(audioStreamManager.setVolumeGainDb).toHaveBeenCalledWith(0);
    expect(audioStreamManager.getVolumeGainDb()).toBe(0);
  });

  it('keeps the legacy -10 dB default for non-TCI Profiles', () => {
    const { audioStreamManager } = createController({ profileType: 'serial' });

    expect(audioStreamManager.setVolumeGainDb).toHaveBeenCalledWith(-10);
    expect(audioStreamManager.getVolumeGainDb()).toBe(-10);
  });

  it('restores a saved Profile and band slot without falling back to another Profile', () => {
    const first = createController({ profileType: 'tci', profileId: 'profile-a', saved: { gain: 1, gainDb: 0 } });
    expect(first.audioStreamManager.getVolumeGainDb()).toBe(0);
    first.setActiveProfileId('profile-b');
    (first.configManager.getActiveProfile as any).mockReturnValue({ id: 'profile-b', radio: { type: 'tci' } });
    (first.configManager.getVolumeGainForProfileSlot as any).mockReturnValue(null);
    first.emitter.emit('frequencyChanged', { band: '40m' } as any);

    expect(first.audioStreamManager.getVolumeGainDb()).toBe(0);
    expect(first.configManager.getVolumeGainForProfileSlot).toHaveBeenLastCalledWith('profile-b', 'digital', '40m');
  });

  it('captures the Profile id before asynchronous persistence completes', async () => {
    let resolveSave!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const { controller, configManager, setActiveProfileId } = createController({
      profileType: 'tci',
      profileId: 'profile-a',
      updateVolumeGainForProfileSlot: save,
    });

    controller.setVolumeGainDb(-3);
    setActiveProfileId('profile-b');
    resolveSave();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith('profile-a', 'digital', '20m', expect.any(Number), -3));
    expect(configManager.updateVolumeGainForProfileSlot).toBe(save);
  });
});
