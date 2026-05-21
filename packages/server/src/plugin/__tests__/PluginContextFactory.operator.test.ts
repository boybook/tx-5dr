import { afterEach, describe, expect, it } from 'vitest';
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

function createPlugin(): LoadedPlugin {
  return {
    definition: {
      name: 'test-plugin',
      version: '1.0.0',
      type: 'utility',
    },
    isBuiltIn: false,
  };
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

    const deps: PluginManagerDeps = {
      eventEmitter: new EventEmitter<DigitalRadioEngineEvents>(),
      getOperators: () => operators,
      getOperatorById: (id) => operators.find((operator) => operator.config.id === id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: () => null,
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir: '/tmp',
    };
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
});
