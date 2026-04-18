import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type DigitalRadioEngineEvents, MODES } from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createDeps(): PluginManagerDeps {
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
  };
}

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

describe('PluginContextFactory storage readiness', () => {
  it('loads persisted storage before returning context', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-storage-ready-'));
    tempDirs.push(storageDir);
    await mkdir(storageDir, { recursive: true });
    await writeFile(
      join(storageDir, 'global.json'),
      JSON.stringify({ existing: { ok: true } }),
      'utf-8',
    );

    const factory = new PluginContextFactory(createDeps());
    const ctx = await factory.create(
      createPlugin(),
      undefined,
      'global',
      storageDir,
      () => {},
      () => ({}),
    );

    expect(ctx.store.global.get('existing')).toEqual({ ok: true });
  });
});
