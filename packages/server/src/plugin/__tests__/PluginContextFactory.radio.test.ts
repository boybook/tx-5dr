import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type CapabilityList, type DigitalRadioEngineEvents, MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';

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
    const setRadioPower = vi.fn(async (state, options) => ({ success: true, target: state, state: 'awake' as const }));
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
});
