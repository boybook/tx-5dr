import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, PluginRuntimeLogEntry } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createOperator(eventEmitter: EventEmitter<DigitalRadioEngineEvents>): RadioOperator {
  eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
    eventEmitter.emit('hasWorkedCallsignResponse' as any, {
      requestId: data.requestId,
      hasWorked: false,
    });
  });

  return new RadioOperator({
    id: 'operator-1',
    mode: MODES.FT8,
    myCallsign: 'BG4IAJ',
    myGrid: 'OM96',
    frequency: 7_074_000,
    transmitCycles: [0],
    maxQSOTimeoutCycles: 6,
    maxCallAttempts: 5,
    autoReplyToCQ: false,
    autoResumeCQAfterFail: false,
    autoResumeCQAfterSuccess: false,
    replyToWorkedStations: false,
    prioritizeNewCalls: true,
    targetSelectionPriorityMode: 'dxcc_first',
  }, eventEmitter);
}

async function writeUserPlugin(
  dataDir: string,
  folderName: string,
  source: string,
): Promise<void> {
  const pluginDir = join(dataDir, 'plugins', folderName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.mjs'), source, 'utf8');
}

function createPluginManager(
  dataDir: string,
  eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
  operator: RadioOperator,
): PluginManager {
  let pluginManager!: PluginManager;
  pluginManager = new PluginManager({
    eventEmitter,
    getOperators: () => [operator],
    getOperatorById: (id) => (id === operator.config.id ? operator : undefined),
    getCurrentMode: () => operator.config.mode,
    getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
    requestOperatorCall: (operatorId, callsign, lastMessage) => {
      pluginManager.requestCall(operatorId, callsign, lastMessage);
    },
    getRadioFrequency: async () => operator.config.frequency,
    setRadioFrequency: () => {},
    getRadioBand: () => '40m',
    getRadioConnected: () => true,
    getLatestSlotPack: () => null,
    interruptOperatorTransmission: async () => {},
    hasWorkedCallsign: async () => false,
    resetOperatorRuntime: () => {},
    dataDir,
  });
  pluginManager.loadConfig({
    configs: {},
    operatorStrategies: {
      [operator.config.id]: 'standard-qso',
    },
    operatorSettings: {
      [operator.config.id]: {
        'standard-qso': {
          autoReplyToCQ: false,
          autoResumeCQAfterFail: false,
          autoResumeCQAfterSuccess: false,
          replyToWorkedStations: false,
          targetSelectionPriorityMode: 'dxcc_first',
          maxQSOTimeoutCycles: 6,
          maxCallAttempts: 5,
        },
      },
    },
  });
  return pluginManager;
}

describe('PluginManager runtime logs', () => {
  it('stores runtime logs in backend history and supports limit queries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);

    await pluginManager.start();
    await pluginManager.reloadPlugins();

    const allEntries = pluginManager.getRuntimeLogHistory();
    const latestThree = pluginManager.getRuntimeLogHistory(3);

    expect(allEntries.length).toBeGreaterThan(0);
    expect(allEntries.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('completed'))).toBe(true);
    expect(latestThree.length).toBeLessThanOrEqual(3);
    expect(latestThree).toEqual(allEntries.slice(-latestThree.length));

    await pluginManager.shutdown();
  });

  it('emits reload started and completed logs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    const runtimeLogs: PluginRuntimeLogEntry[] = [];
    eventEmitter.on('pluginRuntimeLog', (entry) => runtimeLogs.push(entry));

    await pluginManager.start();
    runtimeLogs.length = 0;

    await pluginManager.reloadPlugins();

    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('started'))).toBe(true);
    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('completed'))).toBe(true);

    await pluginManager.shutdown();
  });

  it('emits reload failure logs when rebuild fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    const runtimeLogs: PluginRuntimeLogEntry[] = [];
    eventEmitter.on('pluginRuntimeLog', (entry) => runtimeLogs.push(entry));

    await pluginManager.start();
    runtimeLogs.length = 0;
    const rebuildSpy = vi.spyOn(pluginManager as any, 'rebuildPluginInventory')
      .mockRejectedValue(new Error('forced-reload-failure'));

    await expect(pluginManager.reloadPlugins()).rejects.toThrow('forced-reload-failure');

    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'error'
      && entry.message.includes('failed')
      && String((entry.details as { error?: string } | undefined)?.error).includes('forced-reload-failure'))).toBe(true);

    rebuildSpy.mockRestore();
    await pluginManager.shutdown();
  });

  it('emits rescan started/completed logs and rescan failure logs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    const runtimeLogs: PluginRuntimeLogEntry[] = [];
    eventEmitter.on('pluginRuntimeLog', (entry) => runtimeLogs.push(entry));

    await pluginManager.start();
    runtimeLogs.length = 0;

    await pluginManager.rescanPlugins();

    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('started')
      && String((entry.details as { reason?: string } | undefined)?.reason).includes('plugin rescan'))).toBe(true);
    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('completed')
      && String((entry.details as { reason?: string } | undefined)?.reason).includes('plugin rescan'))).toBe(true);

    runtimeLogs.length = 0;
    const rebuildSpy = vi.spyOn(pluginManager as any, 'rebuildPluginInventory')
      .mockRejectedValue(new Error('forced-rescan-failure'));

    await expect(pluginManager.rescanPlugins()).rejects.toThrow('forced-rescan-failure');

    expect(runtimeLogs.some((entry) =>
      entry.stage === 'reload'
      && entry.level === 'error'
      && entry.message.includes('failed')
      && String((entry.details as { reason?: string; error?: string } | undefined)?.reason).includes('plugin rescan')
      && String((entry.details as { reason?: string; error?: string } | undefined)?.error).includes('forced-rescan-failure'))).toBe(true);

    rebuildSpy.mockRestore();
    await pluginManager.shutdown();
  });

  it('emits name conflict warning for user plugin overriding built-in name', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);
    await writeUserPlugin(dataDir, 'user-standard-qso', `
      export default {
        name: 'standard-qso',
        version: '9.9.9',
        type: 'strategy',
        createStrategyRuntime() {
          return {
            getCurrentTransmission() { return null; },
            onSlotStart() { return null; },
            getStatus() { return { currentSlot: 'TX1', context: {}, slots: {} }; },
            reset() {},
            setContext() {},
            setCurrentSlot() {},
            setCurrentSlotContent() {},
          };
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    const runtimeLogs: PluginRuntimeLogEntry[] = [];
    eventEmitter.on('pluginRuntimeLog', (entry) => runtimeLogs.push(entry));

    await pluginManager.start();

    expect(runtimeLogs.some((entry) =>
      entry.stage === 'validate'
      && entry.level === 'warn'
      && entry.pluginName === 'standard-qso'
      && entry.message.includes('name conflict'))).toBe(true);

    await pluginManager.shutdown();
  });
});
