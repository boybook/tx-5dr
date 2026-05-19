import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type CapabilityList, type DigitalRadioEngineEvents, MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';
import { ConfigManager } from '../../config/config-manager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createDeps(overrides: Partial<PluginManagerDeps> = {}): PluginManagerDeps {
  return {
    eventEmitter: new EventEmitter<DigitalRadioEngineEvents>(),
    getOperators: () => [],
    getOperatorById: () => undefined,
    getCurrentMode: () => MODES.FT8,
    getOperatorAutomationSnapshot: () => null,
    requestOperatorCall: () => {},
    getRadioFrequency: async () => null,
    getKnownRadioFrequency: () => null,
    getEngineMode: () => 'digital',
    setRadioFrequency: () => {},
    getRadioBand: () => '20m',
    getRadioConnected: () => true,
    getLatestSlotPack: () => null,
    interruptOperatorTransmission: async () => {},
    hasWorkedCallsign: async () => false,
    resetOperatorRuntime: () => {},
    dataDir: '/tmp',
    ...overrides,
  };
}

function createPlugin(permissions: LoadedPlugin['definition']['permissions'] = []): LoadedPlugin {
  return {
    definition: {
      name: 'radio-test-plugin',
      version: '1.0.0',
      type: 'utility',
      permissions,
    },
    isBuiltIn: false,
  };
}

async function createContext(plugin: LoadedPlugin, deps: PluginManagerDeps) {
  const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-radio-'));
  tempDirs.push(storageDir);
  const factory = new PluginContextFactory(deps);
  return factory.create(plugin, undefined, 'global', storageDir, () => {}, () => ({}));
}

describe('PluginContextFactory radio access', () => {
  it('prefers the host known radio frequency cache over saved presets', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastSelectedFrequency').mockReturnValue({
      frequency: 14_074_000,
      mode: 'FT8',
      radioMode: 'USB',
      band: '20m',
      description: '20m FT8',
    });
    const ctx = await createContext(createPlugin(), createDeps({
      getKnownRadioFrequency: () => 7_145_123,
      getRadioBand: () => 'saved-band',
    }));

    expect(ctx.radio.frequency).toBe(7_145_123);
    expect(ctx.radio.band).toBe('40m');
  });

  it('falls back to the saved voice frequency and band when no known radio frequency exists', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastVoiceFrequency').mockReturnValue({
      frequency: 145_525_000,
      radioMode: 'FM',
      band: '2m voice',
      description: '2m FM',
    });
    const ctx = await createContext(createPlugin(), createDeps({
      getEngineMode: () => 'voice',
      getKnownRadioFrequency: () => null,
      getRadioBand: () => 'host-band',
    }));

    expect(ctx.radio.frequency).toBe(145_525_000);
    expect(ctx.radio.band).toBe('2m voice');
  });

  it('falls back to the saved CW frequency and band when no known radio frequency exists', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastCWFrequency').mockReturnValue({
      frequency: 7_030_000,
      radioMode: 'CW',
      band: '40m CW',
      description: '40m CW',
    });
    const ctx = await createContext(createPlugin(), createDeps({
      getEngineMode: () => 'cw',
      getKnownRadioFrequency: () => null,
      getRadioBand: () => 'host-band',
    }));

    expect(ctx.radio.frequency).toBe(7_030_000);
    expect(ctx.radio.band).toBe('40m CW');
  });

  it('falls back to the saved digital frequency and band when no known radio frequency exists', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastSelectedFrequency').mockReturnValue({
      frequency: 21_074_000,
      mode: 'FT8',
      radioMode: 'USB',
      band: '15m digital',
      description: '15m FT8',
    });
    const ctx = await createContext(createPlugin(), createDeps({
      getEngineMode: () => 'digital',
      getKnownRadioFrequency: () => null,
      getRadioBand: () => 'host-band',
    }));

    expect(ctx.radio.frequency).toBe(21_074_000);
    expect(ctx.radio.band).toBe('15m digital');
  });

  it('falls back to the saved mode band when known radio frequency has no band match', async () => {
    vi.spyOn(ConfigManager.getInstance(), 'getLastVoiceFrequency').mockReturnValue({
      frequency: 145_525_000,
      radioMode: 'FM',
      band: '2m voice',
      description: '2m FM',
    });
    const ctx = await createContext(createPlugin(), createDeps({
      getEngineMode: () => 'voice',
      getKnownRadioFrequency: () => 999_000_000,
      getRadioBand: () => 'host-band',
    }));

    expect(ctx.radio.frequency).toBe(999_000_000);
    expect(ctx.radio.band).toBe('2m voice');
  });

  it('rejects protected radio APIs when plugin permissions are missing', async () => {
    const ctx = await createContext(createPlugin(), createDeps());

    expect(() => ctx.radio.capabilities.getSnapshot()).toThrow("requires permission 'radio:read'");
    await expect(ctx.radio.setFrequency(14_074_000)).rejects.toThrow("requires permission 'radio:control'");
    await expect(ctx.radio.power.set('off')).rejects.toThrow("requires permission 'radio:power'");
  });

  it('exposes capability read/write APIs with radio permissions', async () => {
    const snapshot: CapabilityList = {
      descriptors: [],
      capabilities: [{
        id: 'agc_mode',
        supported: true,
        availability: 'available',
        value: 'auto',
        updatedAt: 123,
      }],
    };
    const writeRadioCapability = vi.fn(async () => undefined);
    const ctx = await createContext(
      createPlugin(['radio:read', 'radio:control']),
      createDeps({
        getRadioCapabilitySnapshot: () => snapshot,
        refreshRadioCapabilities: async () => snapshot,
        writeRadioCapability,
      }),
    );

    expect(ctx.radio.capabilities.getSnapshot()).toBe(snapshot);
    expect(ctx.radio.capabilities.getState('agc_mode')).toEqual(snapshot.capabilities[0]);
    await expect(ctx.radio.capabilities.refresh()).resolves.toBe(snapshot);

    await ctx.radio.capabilities.write({ id: 'agc_mode', value: 'fast' });
    await ctx.radio.capabilities.write({ id: 'tuner_tune', action: true });
    expect(writeRadioCapability).toHaveBeenNthCalledWith(1, { id: 'agc_mode', value: 'fast' });
    expect(writeRadioCapability).toHaveBeenNthCalledWith(2, { id: 'tuner_tune', action: true });
  });

  it('exposes power support/state/set APIs with defaults and overrides', async () => {
    const getRadioPowerSupport = vi.fn(async (profileId?: string) => ({
      profileId: profileId ?? 'active-profile',
      canPowerOn: true,
      canPowerOff: true,
      supportedStates: ['off' as const],
    }));
    const getRadioPowerState = vi.fn(() => ({ profileId: 'active-profile', state: 'awake' as const, stage: 'idle' as const }));
    const setRadioPower = vi.fn(async (state, _options) => ({ success: true, target: state, state: 'awake' as const }));
    const ctx = await createContext(
      createPlugin(['radio:read', 'radio:power']),
      createDeps({ getRadioPowerSupport, getRadioPowerState, setRadioPower }),
    );

    await expect(ctx.radio.power.getSupport()).resolves.toMatchObject({ profileId: 'active-profile' });
    expect(ctx.radio.power.getState()).toMatchObject({ state: 'awake' });
    await ctx.radio.power.set('on');
    await ctx.radio.power.set('standby', { profileId: 'profile-2', autoEngine: false });

    expect(setRadioPower).toHaveBeenNthCalledWith(1, 'on', undefined);
    expect(setRadioPower).toHaveBeenNthCalledWith(2, 'standby', { profileId: 'profile-2', autoEngine: false });
  });


  it('does not expose host-owned hamlib dependency without host permission', async () => {
    const ctx = await createContext(createPlugin(), createDeps());

    expect(ctx.hostDependencies.hamlib).toBeUndefined();
  });

  it('exposes allow-listed host-owned hamlib dependency to permitted plugins', async () => {
    const ctx = await createContext(createPlugin(['host:hamlib']), createDeps());

    expect(ctx.hostDependencies.hamlib).toBeDefined();
    expect(typeof ctx.hostDependencies.hamlib?.Rotator).toBe('function');
    expect(typeof ctx.hostDependencies.hamlib?.Rotator.getSupportedRotators).toBe('function');
    expect(typeof ctx.hostDependencies.hamlib?.Rotator.getHamlibVersion()).toBe('string');
    expect(ctx.hostDependencies.hamlib).not.toHaveProperty('HamLib');
    expect(ctx.hostDependencies.hamlib).not.toHaveProperty('default');
  });
});
