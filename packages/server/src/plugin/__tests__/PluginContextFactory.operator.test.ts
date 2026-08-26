import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createPlugin(definition: Partial<LoadedPlugin['definition']> = {}): LoadedPlugin {
  return {
    definition: {
      apiVersion: 2,
      name: 'test-plugin',
      version: '1.0.0',
      type: 'utility',
      ...definition,
    },
    isBuiltIn: false,
  };
}

function createDeps(overrides: Partial<PluginManagerDeps> = {}): PluginManagerDeps {
  const operators = [
    {
      config: {
        id: 'operator-1',
        myCallsign: 'BG4IAJ',
        myGrid: 'OM96',
        frequency: 1200,
        mode: MODES.FT8,
      },
      getTransmitCycles: () => [0],
      isTransmitting: false,
      start: vi.fn(),
      stop: vi.fn(),
      setTransmitCycles: vi.fn(),
      isTargetBeingWorkedByOthers: vi.fn(() => false),
      recordQSOLog: vi.fn(async record => record),
      notifySlotsUpdated: vi.fn(),
      notifyStateChanged: vi.fn(),
    },
    {
      config: {
        id: 'operator-2',
        myCallsign: 'BG4IAK',
        myGrid: 'OM97',
        frequency: 1825,
        mode: MODES.FT4,
      },
      getTransmitCycles: () => [1],
      isTransmitting: true,
    },
  ] as any[];

  return {
    eventEmitter: new EventEmitter<DigitalRadioEngineEvents>(),
    getOperators: () => operators,
    getOperatorById: (id) => operators.find((operator) => operator.config.id === id),
    getCurrentMode: () => MODES.FT8,
    getOperatorAutomationSnapshot: () => null,
    requestOperatorCall: vi.fn(),
    getRadioFrequency: async () => 7_074_000,
    setRadioFrequency: () => {},
    getRadioBand: () => '40m',
    getRadioConnected: () => true,
    getLatestSlotPack: () => null,
    interruptOperatorTransmission: vi.fn(async () => {}),
    hasWorkedCallsign: async () => false,
    resetOperatorRuntime: () => {},
    dataDir: '/tmp',
    ...overrides,
  };
}

async function createOperatorContext(plugin: LoadedPlugin, deps = createDeps()) {
  const factory = new PluginContextFactory(deps);
  const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-'));
  tempDirs.push(storageDir);
  const ctx = await factory.create(
    plugin,
    'operator-1',
    'operator',
    storageDir,
    () => {},
    () => ({}),
  );
  return { ctx, deps };
}

describe('PluginContextFactory operator access', () => {
  it('projects a one-stream Host limit on standard digital frequencies', async () => {
    let dialFrequency = 14_074_000;
    const { ctx } = await createOperatorContext(createPlugin(), createDeps({
      getKnownRadioFrequency: () => dialFrequency,
    }));

    expect(ctx.operator.maxConcurrentStreams).toBe(1);
    dialFrequency = 14_090_000;
    expect(ctx.operator.maxConcurrentStreams).toBe(3);
  });

  it('exposes read-only snapshots for other operators only', async () => {
    const operators = [
      {
        config: {
          id: 'operator-1',
          myCallsign: 'BG4IAJ',
          myGrid: 'OM96',
          frequency: 1200,
          mode: MODES.FT8,
        },
        getTransmitCycles: () => [0],
        isTransmitting: false,
      },
      {
        config: {
          id: 'operator-2',
          myCallsign: 'BG4IAK',
          myGrid: 'OM97',
          frequency: 1825,
          mode: MODES.FT4,
        },
        getTransmitCycles: () => [1],
        isTransmitting: true,
      },
    ] as any[];

    const deps = createDeps({
      getOperators: () => operators,
      getOperatorById: (id) => operators.find((operator) => operator.config.id === id),
    });
    const factory = new PluginContextFactory(deps);
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-'));
    tempDirs.push(storageDir);

    const ctx = await factory.create(
      createPlugin(),
      'operator-1',
      'operator',
      storageDir,
      () => {},
      () => ({}),
    );

    expect(ctx.operator.getOtherOperators()).toEqual([{
      id: 'operator-2',
      callsign: 'BG4IAK',
      grid: 'OM97',
      audioFrequencyHz: 1825,
      mode: MODES.FT4,
      isTransmitting: true,
      transmitCycles: [1],
      automation: null,
    }]);
  });

  it('omits the command capability when permission is missing', async () => {
    const { ctx } = await createOperatorContext(createPlugin());

    expect('operatorCommands' in ctx).toBe(false);
    expect('startTransmitting' in ctx.operator).toBe(false);
  });

  it('exposes only host-arbitrated command ports when transmit capabilities are declared', async () => {
    const { ctx } = await createOperatorContext(createPlugin({
      apiVersion: 2,
      permissions: [
        'operator:transmit-control',
        'radio:read',
        'radio:control',
        'radio:power',
      ],
      isTransmitControlEnabled: () => true,
    }));

    expect(ctx.operatorCommands).toBeDefined();
    expect(Object.keys(ctx.operatorCommands!)).toEqual(['submit']);
    expect('setPTT' in ctx).toBe(false);
    expect('playAudio' in ctx).toBe(false);
    expect('audioMixer' in ctx).toBe(false);
    expect('encoder' in ctx).toBe(false);
    await expect(ctx.digitalMessagePreflight.check({ mode: 'FT8', text: 'CQ TEST' }))
      .resolves.toMatchObject({ encodable: false, reason: 'encode_failed' });
    expect('forceStopTransmission' in ctx).toBe(false);
    expect('setPTT' in ctx.radio).toBe(false);
    expect('stopPlayback' in ctx.radio).toBe(false);
  });

  it('rejects transmit-control APIs while auto-call state is disabled', async () => {
    const { ctx } = await createOperatorContext(createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: () => false,
    }));
    const lastMessage = { message: { type: 'CQ', raw: 'CQ TEST PM00' }, slotInfo: { id: 'slot-1', startMs: 0, window: 0 } } as any;

    expect(ctx.operatorCommands).toBeDefined();
    await expect(ctx.operatorCommands!.submit({ type: 'request-call', callsign: 'BG4IAK', lastMessage }))
      .rejects.toThrow('transmit-control eligibility predicate returned false');
  });

  it('rejects transmit-control APIs while the operator plugin is paused by the host', async () => {
    const deps = createDeps();
    const plugin = createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: () => true,
    });
    const factory = new PluginContextFactory(
      deps,
      undefined,
      undefined,
      (pluginName, operatorId) => pluginName === 'test-plugin' && operatorId === 'operator-1',
    );
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-'));
    tempDirs.push(storageDir);
    const ctx = await factory.create(
      plugin,
      'operator-1',
      'operator',
      storageDir,
      () => {},
      () => ({}),
    );

    await expect(ctx.operatorCommands!.submit({ type: 'start-automation' }))
      .rejects.toThrow('automatic calling is paused');
  });

  it('allows transmit-control APIs when permission and auto-call state are enabled', async () => {
    const submitOperatorCommand = vi.fn(async (_operatorId, command) => ({
      epoch: 1,
      outcome: 'completed' as const,
      command,
    }));
    const deps = createDeps({ submitOperatorCommand });
    const { ctx } = await createOperatorContext(createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: () => true,
    }), deps);
    const lastMessage = { message: { type: 'CQ', raw: 'CQ TEST PM00' }, slotInfo: { id: 'slot-1', startMs: 0, window: 0 } } as any;
    await ctx.operatorCommands!.submit({ type: 'start-automation' });
    await ctx.operatorCommands!.submit({ type: 'stop-automation' });
    await ctx.operatorCommands!.submit({ type: 'request-call', callsign: 'BG4IAK', lastMessage });
    await ctx.operatorCommands!.submit({ type: 'reply-to-decode', callsign: 'BG4IAK', lastMessage });
    await ctx.operatorCommands!.submit({ type: 'send-free-text', text: 'CQ TEST PM00' });
    await ctx.operatorCommands!.submit({ type: 'remove-contribution' });

    expect(submitOperatorCommand.mock.calls.map(([, command]) => command.type)).toEqual([
      'start-automation',
      'stop-automation',
      'request-call',
      'reply-to-decode',
      'send-free-text',
      'remove-contribution',
    ]);
    expect(submitOperatorCommand).toHaveBeenCalledWith('operator-1', {
      type: 'request-call',
      callsign: 'BG4IAK',
      lastMessage,
    }, 'test-plugin');
  });

  it('uses the latest config when checking transmit-control eligibility', async () => {
    let enabled = true;
    const submitOperatorCommand = vi.fn(async (_operatorId, command) => ({
      epoch: 1,
      outcome: 'completed' as const,
      command,
    }));
    const deps = createDeps({ submitOperatorCommand });
    const plugin = createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: (ctx) => ctx.config.enabled === true,
    });
    const factory = new PluginContextFactory(deps);
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ctx-config-'));
    tempDirs.push(storageDir);
    const ctx = await factory.create(
      plugin,
      'operator-1',
      'operator',
      storageDir,
      () => {},
      () => ({ enabled }),
    );

    await expect(ctx.operatorCommands!.submit({ type: 'start-automation' })).resolves.toBeDefined();
    enabled = false;
    await expect(ctx.operatorCommands!.submit({ type: 'start-automation' }))
      .rejects.toThrow('transmit-control eligibility predicate returned false');
    enabled = true;
    await expect(ctx.operatorCommands!.submit({ type: 'start-automation' })).resolves.toBeDefined();
  });

  it('detaches worked-query options before asynchronous host use', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observedAnyBand: boolean | undefined;
    const deps = createDeps({
      hasWorkedCallsign: async (_operatorId, _callsign, options) => {
        await gate;
        observedAnyBand = options?.anyBand;
        return false;
      },
    });
    const { ctx } = await createOperatorContext(createPlugin(), deps);
    const options = { anyBand: false };

    const query = ctx.operator.hasWorkedCallsign('W1AW', options);
    options.anyBand = true;
    release();

    await expect(query).resolves.toBe(false);
    expect(observedAnyBand).toBe(false);
  });
});
