import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../config-manager.js';
import { RuntimeStateManager } from '../RuntimeStateManager.js';
import { PersistenceCoordinator } from '../../utils/persistence/index.js';
import { tx5drPaths } from '../../utils/app-paths.js';

function resetSingletons(): void {
  (ConfigManager as unknown as { instance?: ConfigManager | null }).instance = null;
  RuntimeStateManager.getInstance().disposeForTests();
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  PersistenceCoordinator.getInstance().allowNewMutationsForTests();
}

async function addProfile(configManager: ConfigManager, id: string): Promise<void> {
  await configManager.addProfile({
    id,
    name: id,
    radio: { type: 'none' },
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
}

describe('ConfigManager Profile operating state', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-profile-state-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    (tx5drPaths as unknown as { _configDir?: string | null })._configDir = null;
  });

  beforeEach(async () => {
    resetSingletons();
    await rm(configDir, { recursive: true, force: true });
    process.env.TX5DR_CONFIG_DIR = configDir;
    (tx5drPaths as unknown as { _configDir?: string | null })._configDir = null;
  });

  afterAll(async () => {
    resetSingletons();
    if (previousConfigDir === undefined) {
      delete process.env.TX5DR_CONFIG_DIR;
    } else {
      process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    }
    (tx5drPaths as unknown as { _configDir?: string | null })._configDir = null;
    await rm(configDir, { recursive: true, force: true });
  });

  it('keeps each Profile independent and never falls back for a new Profile', async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await addProfile(configManager, 'profile-b');
    await configManager.setActiveProfileId('profile-a');
    await configManager.updateLastSelectedFrequency({
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });

    await configManager.setActiveProfileId('profile-b');
    expect(configManager.getLastSelectedFrequency()).toBeNull();
    expect(configManager.getLastEngineMode()).toBe('digital');
    expect(configManager.getLastDigitalModeName()).toBe('FT8');

    await configManager.updateLastSelectedFrequency({
      frequency: 14_074_000,
      mode: 'FT8',
      band: '20m',
    });
    await configManager.setActiveProfileId('profile-a');
    expect(configManager.getLastSelectedFrequency()).toMatchObject({ frequency: 144_460_000 });
    expect(configManager.getProfileOperatingState('profile-b')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 14_074_000 }),
    });
  });

  it('does not lose concurrent updates to different fields in one Profile bucket', async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await configManager.setActiveProfileId('profile-a');

    await Promise.all([
      configManager.updateLastSelectedFrequency({
        frequency: 144_460_000,
        mode: 'FT8',
        band: '2m',
      }),
      configManager.setLastEngineMode('voice'),
      configManager.setLastDigitalModeName('FT4'),
    ]);

    expect(configManager.getProfileOperatingState('profile-a')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000 }),
      lastEngineMode: 'voice',
      lastDigitalModeName: 'FT4',
    });
  });

  it('invalidates captured Profile tokens when the active Profile is committed again', async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await addProfile(configManager, 'profile-b');
    await configManager.setActiveProfileId('profile-a');
    const token = configManager.captureActiveProfileToken();

    expect(configManager.isActiveProfileTokenCurrent(token)).toBe(true);
    await configManager.setActiveProfileId('profile-b');
    expect(configManager.isActiveProfileTokenCurrent(token)).toBe(false);
  });

  it('keeps the active Profile and token current when persistence fails', async () => {
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await addProfile(configManager, 'profile-b');
    await configManager.setActiveProfileId('profile-a');
    const token = configManager.captureActiveProfileToken();
    const configStore = (configManager as unknown as {
      configStore: { set: (value: Record<string, unknown>) => Promise<void> };
    }).configStore;
    vi.spyOn(configStore, 'set').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(configManager.setActiveProfileId('profile-b')).rejects.toThrow('disk unavailable');

    expect(configManager.getActiveProfileId()).toBe('profile-a');
    expect(configManager.isActiveProfileTokenCurrent(token)).toBe(true);
  });

  it('migrates legacy globals once into only the active Profile', async () => {
    let configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await addProfile(configManager, 'profile-b');
    await configManager.setActiveProfileId('profile-a');

    const runtimeState = RuntimeStateManager.getInstance();
    await runtimeState.set('operatingStateByProfile', undefined);
    await runtimeState.set('lastSelectedFrequency', {
      frequency: 144_460_000,
      mode: 'FT8',
      band: '2m',
    });
    await configManager.flush();
    resetSingletons();

    configManager = ConfigManager.getInstance();
    await configManager.initialize();
    expect(configManager.getLastSelectedFrequency()).toMatchObject({ frequency: 144_460_000 });
    expect(configManager.getProfileOperatingState('profile-b')).toBeNull();

    await configManager.setActiveProfileId('profile-b');
    await configManager.flush();
    resetSingletons();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();

    expect(configManager.getActiveProfileId()).toBe('profile-b');
    expect(configManager.getLastSelectedFrequency()).toBeNull();
    expect(configManager.getProfileOperatingState('profile-a')).toMatchObject({
      lastSelectedFrequency: expect.objectContaining({ frequency: 144_460_000 }),
    });
  });

  it('preserves explicitly cleared legacy frequencies during Profile migration', async () => {
    let configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await addProfile(configManager, 'profile-a');
    await configManager.setActiveProfileId('profile-a');

    const internals = configManager as unknown as {
      config: Record<string, unknown>;
      saveConfig: () => Promise<void>;
    };
    internals.config.lastSelectedFrequency = { frequency: 14_074_000, mode: 'FT8', band: '20m' };
    internals.config.lastVoiceFrequency = { frequency: 145_500_000, mode: 'VOICE', band: '2m' };
    internals.config.lastCWFrequency = { frequency: 7_030_000, mode: 'CW', band: '40m' };
    await internals.saveConfig();

    const runtimeState = RuntimeStateManager.getInstance();
    await runtimeState.set('operatingStateByProfile', undefined);
    await runtimeState.set('lastSelectedFrequency', null);
    await runtimeState.set('lastVoiceFrequency', null);
    await runtimeState.set('lastCWFrequency', null);
    await configManager.flush();
    resetSingletons();

    configManager = ConfigManager.getInstance();
    await configManager.initialize();

    expect(configManager.getProfileOperatingState('profile-a')).toMatchObject({
      lastSelectedFrequency: null,
      lastVoiceFrequency: null,
      lastCWFrequency: null,
    });
  });
});
