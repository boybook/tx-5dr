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
      recordQSOLog: vi.fn(),
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

  it('rejects transmit-control APIs when permission is missing', async () => {
    const { ctx } = await createOperatorContext(createPlugin());

    expect(() => ctx.operator.startTransmitting()).toThrow("permissions: ['operator:transmit-control']");
  });

  it('rejects transmit-control APIs while auto-call state is disabled', async () => {
    const { ctx } = await createOperatorContext(createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: () => false,
    }));
    const lastMessage = { message: { type: 'CQ', raw: 'CQ TEST PM00' }, slotInfo: { id: 'slot-1', startMs: 0, window: 0 } } as any;

    const actions = [
      () => ctx.operator.startTransmitting(),
      () => ctx.operator.stopTransmitting(),
      () => ctx.operator.haltTransmission(),
      () => ctx.operator.call('BG4IAK', lastMessage),
      () => ctx.operator.replyToDecode({ callsign: 'BG4IAK', lastMessage }),
      () => ctx.operator.sendFreeText('CQ TEST PM00'),
    ];

    for (const action of actions) {
      expect(action).toThrow('isAutoCallEnabled(ctx) returned false');
    }
  });

  it('allows transmit-control APIs when permission and auto-call state are enabled', async () => {
    const deps = createDeps();
    const { ctx } = await createOperatorContext(createPlugin({
      permissions: ['operator:transmit-control'],
      isAutoCallEnabled: () => true,
    }), deps);
    const lastMessage = { message: { type: 'CQ', raw: 'CQ TEST PM00' }, slotInfo: { id: 'slot-1', startMs: 0, window: 0 } } as any;
    const requestTransmit = vi.fn();
    deps.eventEmitter.on('requestTransmit', requestTransmit);

    expect(() => ctx.operator.startTransmitting()).not.toThrow();
    expect(() => ctx.operator.stopTransmitting()).not.toThrow();
    expect(() => ctx.operator.call('BG4IAK', lastMessage)).not.toThrow();
    expect(() => ctx.operator.replyToDecode({ callsign: 'BG4IAK', lastMessage })).not.toThrow();
    expect(() => ctx.operator.sendFreeText('CQ TEST PM00')).not.toThrow();
    expect(() => ctx.operator.haltTransmission({ autoOnly: true })).not.toThrow();

    expect(deps.getOperatorById('operator-1')?.start).toHaveBeenCalled();
    expect(deps.getOperatorById('operator-1')?.stop).toHaveBeenCalled();
    expect(deps.requestOperatorCall).toHaveBeenCalledWith('operator-1', 'BG4IAK', lastMessage);
    expect(requestTransmit).toHaveBeenCalledWith({ operatorId: 'operator-1', transmission: 'CQ TEST PM00' });
  });
});
