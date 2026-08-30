import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../config-manager.js';
import { RuntimeStateManager } from '../RuntimeStateManager.js';
import { PersistenceCoordinator } from '../../utils/persistence/index.js';

function resetSingletons(): void {
  (ConfigManager as unknown as { instance?: ConfigManager | null }).instance = null;
  RuntimeStateManager.getInstance().disposeForTests();
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  PersistenceCoordinator.getInstance().allowNewMutationsForTests();
}

describe('ConfigManager profile operating memory', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-profile-freq-memory-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    resetSingletons();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await configManager.addProfile({
      id: 'profile-9700',
      name: 'IC-9700',
      radio: { type: 'serial' } as any,
      audio: {
        inputSampleRate: 48000,
        outputSampleRate: 48000,
        inputBufferSize: 1024,
        outputBufferSize: 1024,
      },
      audioLockedToRadio: false,
      createdAt: 1,
      updatedAt: 1,
    });
    await configManager.addProfile({
      id: 'profile-7610',
      name: 'IC-7610',
      radio: { type: 'serial' } as any,
      audio: {
        inputSampleRate: 48000,
        outputSampleRate: 48000,
        inputBufferSize: 1024,
        outputBufferSize: 1024,
      },
      audioLockedToRadio: false,
      createdAt: 2,
      updatedAt: 2,
    });
    await configManager.setActiveProfileId('profile-9700');
  });

  afterEach(async () => {
    await RuntimeStateManager.getInstance().flush();
    resetSingletons();
    if (previousConfigDir === undefined) {
      delete process.env.TX5DR_CONFIG_DIR;
    } else {
      process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it('mirrors last frequency updates into the active profile memory', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
      description: '144.460 FT8',
    });
    await configManager.setLastEngineMode('digital');

    expect(configManager.getProfileOperatingMemory('profile-9700')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000, mode: 'FT8' }),
      lastEngineMode: 'digital',
    });
  });

  it('keeps volume gain slots isolated by Profile and band', async () => {
    await configManager.updateVolumeGainForProfileSlot('profile-9700', 'digital', '20m', 1, 0);
    await configManager.updateVolumeGainForProfileSlot('profile-7610', 'digital', '20m', 0.5623, -5);

    expect(configManager.getVolumeGainForProfileSlot('profile-9700', 'digital', '20m')).toEqual({ gain: 1, gainDb: 0 });
    expect(configManager.getVolumeGainForProfileSlot('profile-7610', 'digital', '20m')).toEqual({ gain: 0.5623, gainDb: -5 });
    expect(configManager.getVolumeGainForProfileSlot('profile-9700', 'voice', '20m')).toBeNull();
  });

  it('keeps previous profile memory and clears globals when loading an empty profile', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
      description: '144.460 FT8',
    });
    await configManager.setLastEngineMode('voice');

    await configManager.snapshotOperatingMemoryForProfile('profile-9700');
    await configManager.setActiveProfileId('profile-7610');
    await configManager.loadOperatingMemoryForProfile('profile-7610');

    expect(configManager.getLastSelectedFrequency()).toBeNull();
    expect(configManager.getLastEngineMode()).toBe('digital');
    expect(configManager.getProfileOperatingMemory('profile-9700')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000 }),
      lastEngineMode: 'voice',
    });
  });

  it('restores a profile memory bucket into globals on load', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });
    await configManager.snapshotOperatingMemoryForProfile('profile-9700');

    await configManager.setActiveProfileId('profile-7610');
    await configManager.updateLastSelectedFrequency({
      frequency: 14_074_000,
      mode: 'FT8',
      band: '20m',
    });
    await configManager.snapshotOperatingMemoryForProfile('profile-7610');

    await configManager.setActiveProfileId('profile-9700');
    await configManager.loadOperatingMemoryForProfile('profile-9700');

    expect(configManager.getLastSelectedFrequency()).toMatchObject({
      frequency: 144_460_000,
      band: '2m',
    });
  });

  it('switchActiveProfile snapshots previous memory then loads the target bucket', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });
    await configManager.setLastEngineMode('digital');

    await configManager.setActiveProfileId('profile-7610');
    await configManager.updateLastSelectedFrequency({
      frequency: 14_074_000,
      mode: 'FT8',
      band: '20m',
    });

    // Put globals back on 9700 without going through switchActiveProfile,
    // then exercise the helper as RadioPowerController would.
    await configManager.setActiveProfileId('profile-9700');
    await configManager.loadOperatingMemoryForProfile('profile-9700');
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });

    const result = await configManager.switchActiveProfile('profile-7610');

    expect(result).toEqual({ previousProfileId: 'profile-9700', profileId: 'profile-7610' });
    expect(configManager.getActiveProfileId()).toBe('profile-7610');
    expect(configManager.getLastSelectedFrequency()).toMatchObject({
      frequency: 14_074_000,
      band: '20m',
    });
    expect(configManager.getProfileOperatingMemory('profile-9700')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000 }),
    });
  });

  it('skips snapshot/load when switchActiveProfile targets the already-active profile', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });
    await configManager.setLastEngineMode('voice');

    const result = await configManager.switchActiveProfile('profile-9700');

    expect(result).toEqual({ previousProfileId: 'profile-9700', profileId: 'profile-9700' });
    expect(configManager.getLastSelectedFrequency()).toMatchObject({ frequency: 144_460_000 });
    expect(configManager.getLastEngineMode()).toBe('voice');
    expect(configManager.getActiveProfileId()).toBe('profile-9700');
  });

  it('serializes concurrent switchActiveProfile calls without corrupting buckets', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });
    await configManager.setLastEngineMode('digital');

    const first = configManager.switchActiveProfile('profile-7610');
    const second = configManager.switchActiveProfile('profile-9700');
    await Promise.all([first, second]);

    expect(configManager.getActiveProfileId()).toBe('profile-9700');
    expect(configManager.getLastSelectedFrequency()).toMatchObject({
      frequency: 144_460_000,
      band: '2m',
    });
    expect(configManager.getProfileOperatingMemory('profile-9700')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000 }),
    });
  });

  it('throws when switchActiveProfile targets a missing profile', async () => {
    await expect(configManager.switchActiveProfile('missing-profile')).rejects.toThrow(
      'Profile missing-profile does not exist',
    );
    expect(configManager.getActiveProfileId()).toBe('profile-9700');
  });

  it('loads target memory without snapshot when activating with no previous profile', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 14_074_000,
      mode: 'FT8',
      band: '20m',
    });
    await configManager.setLastEngineMode('voice');
    await configManager.snapshotOperatingMemoryForProfile('profile-7610');

    // Simulate first activate: no active profile yet.
    await configManager.setActiveProfileId(null);
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });

    const result = await configManager.switchActiveProfile('profile-7610');

    expect(result).toEqual({ previousProfileId: null, profileId: 'profile-7610' });
    expect(configManager.getActiveProfileId()).toBe('profile-7610');
    expect(configManager.getLastSelectedFrequency()).toMatchObject({
      frequency: 14_074_000,
      band: '20m',
    });
    expect(configManager.getLastEngineMode()).toBe('voice');
    // Orphan globals from the null-active window must not pollute the target bucket.
    expect(configManager.getProfileOperatingMemory('profile-7610')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 14_074_000 }),
      lastEngineMode: 'voice',
    });
  });

  it('removes operating memory when a profile is deleted', async () => {
    await configManager.updateLastSelectedFrequency({
      frequency: 14_074_000,
      mode: 'FT8',
      band: '20m',
    });
    expect(configManager.getProfileOperatingMemory('profile-9700')).not.toBeNull();

    await configManager.setActiveProfileId('profile-7610');
    await configManager.deleteProfile('profile-9700');

    expect(configManager.getProfileOperatingMemory('profile-9700')).toBeNull();
  });
});
