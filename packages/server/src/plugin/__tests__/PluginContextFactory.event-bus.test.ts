import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type DigitalRadioEngineEvents, MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';
import { PluginEventBusHost } from '../PluginEventBusHost.js';

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
      name: 'event-bus-test-plugin',
      version: '1.0.0',
      type: 'utility',
      permissions,
    },
    isBuiltIn: false,
  };
}

async function createContext(
  plugin: LoadedPlugin,
  deps: PluginManagerDeps = createDeps({ pluginEventBusHost: new PluginEventBusHost() }),
) {
  const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-event-bus-'));
  tempDirs.push(storageDir);
  const factory = new PluginContextFactory(deps);
  return factory.create(plugin, 'operator-1', 'operator', storageDir, () => {}, () => ({}));
}

describe('PluginContextFactory event bus access', () => {
  it('does not expose ctx.eventBus without permission', async () => {
    const ctx = await createContext(createPlugin());
    expect(ctx.eventBus).toBeUndefined();
  });

  it('exposes ctx.eventBus with permission and forwards publisher metadata', async () => {
    const host = new PluginEventBusHost();
    const publisherCtx = await createContext(
      createPlugin(['plugin:event-bus']),
      createDeps({ pluginEventBusHost: host }),
    );
    const subscriberCtx = await createContext(
      {
        definition: {
          name: 'subscriber-plugin',
          version: '1.0.0',
          type: 'utility',
          permissions: ['plugin:event-bus'],
        },
        isBuiltIn: false,
      },
      createDeps({ pluginEventBusHost: host }),
    );

    const received = vi.fn();
    subscriberCtx.eventBus!.subscribe('plugin.topic', received);
    publisherCtx.eventBus!.publish('plugin.topic', { answer: 42 });
    await Promise.resolve();

    expect(received).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'plugin.topic',
      payload: { answer: 42 },
      publisher: {
        pluginName: 'event-bus-test-plugin',
        instanceScope: 'operator',
        operatorId: 'operator-1',
      },
      timestamp: expect.any(Number),
    }));
  });
});
