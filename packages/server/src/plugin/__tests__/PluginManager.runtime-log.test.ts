import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  DigitalRadioEngineEvents,
  PluginLogEntry,
  PluginLogHistoryEntry,
  PluginRuntimeLogEntry,
} from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';
import { ConfigManager } from '../../config/config-manager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function isRuntimeLogEntry(entry: PluginLogHistoryEntry): entry is PluginRuntimeLogEntry {
  return 'source' in entry && entry.source === 'system';
}

function isPluginLogEntry(entry: PluginLogHistoryEntry): entry is PluginLogEntry {
  return !isRuntimeLogEntry(entry);
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
      isRuntimeLogEntry(entry)
      &&
      entry.stage === 'reload'
      && entry.level === 'info'
      && entry.message.includes('completed'))).toBe(true);
    expect(latestThree.length).toBeLessThanOrEqual(3);
    expect(latestThree).toEqual(allEntries.slice(-latestThree.length));

    await pluginManager.shutdown();
  });

  it('stores plugin ctx.log entries in backend history', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'history-plugin', `
      export default {
        name: 'history-plugin',
        version: '1.0.0',
        type: 'utility',
        instanceScope: 'global',
        onLoad(ctx) {
          ctx.log.info('history plugin started');
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    pluginManager.loadConfig({
      configs: {
        'history-plugin': { enabled: true, settings: {} },
      },
      operatorStrategies: {
        [operator.config.id]: 'standard-qso',
      },
      operatorSettings: {},
    });

    await pluginManager.start();

    const history = pluginManager.getRuntimeLogHistory();
    expect(history.some((entry) =>
      isPluginLogEntry(entry)
      && entry.pluginName === 'history-plugin'
      && entry.message === 'history plugin started')).toBe(true);

    await pluginManager.shutdown();
  });

  it('updates auto-call enabled operator ids when operator settings change', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-runtime-log-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'tx-control-test', `
      export default {
        name: 'tx-control-test',
        version: '1.0.0',
        type: 'utility',
        permissions: ['operator:transmit-control'],
        settings: {
          autoCallEnabled: {
            type: 'boolean',
            default: false,
            label: 'autoCallEnabled',
            scope: 'operator',
          },
        },
        isAutoCallEnabled(ctx) {
          return ctx.config.autoCallEnabled === true;
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    pluginManager.loadConfig({
      configs: {
        'tx-control-test': { enabled: true, settings: {} },
        'qso-udp-broadcast': { enabled: false, settings: {} },
      },
      operatorStrategies: {
        [operator.config.id]: 'standard-qso',
      },
      operatorSettings: {
        [operator.config.id]: {
          'tx-control-test': { autoCallEnabled: false },
        },
      },
    });

    await pluginManager.start();
    expect(pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === 'tx-control-test')?.autoCallEnabledOperatorIds).toBeUndefined();

    const statusChanged = vi.fn();
    eventEmitter.on('pluginStatusChanged', statusChanged);
    pluginManager.setOperatorPluginSettings(operator.config.id, 'tx-control-test', { autoCallEnabled: true });

    const status = pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === 'tx-control-test');
    expect(status?.autoCallEnabledOperatorIds).toEqual([operator.config.id]);
    expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({
      plugin: expect.objectContaining({
        name: 'tx-control-test',
        autoCallEnabledOperatorIds: [operator.config.id],
      }),
    }));

    await pluginManager.shutdown();
  });

  it('persists operator plugin pauses and gates transmit-control hooks and actions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-pause-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'pausable-tx-control', `
      export default {
        name: 'pausable-tx-control',
        version: '1.0.0',
        type: 'utility',
        permissions: ['operator:transmit-control'],
        settings: {
          autoCallEnabled: {
            type: 'boolean',
            default: true,
            label: 'autoCallEnabled',
            scope: 'operator',
          },
        },
        quickActions: [{ id: 'ping', label: 'Ping' }],
        onLoad(ctx) {
          ctx.timers.set('poll', 1000);
        },
        hooks: {
          onTimer(timerId, ctx) {
            ctx.log.info('timer:' + timerId);
          },
          onDecode(messages, ctx) {
            ctx.log.info('decode');
          },
          onUserAction(actionId, payload, ctx) {
            ctx.log.info('action:' + actionId);
          },
        },
        isAutoCallEnabled(ctx) {
          return ctx.config.autoCallEnabled === true;
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator(eventEmitter);
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    pluginManager.loadConfig({
      configs: {
        'pausable-tx-control': { enabled: true, settings: {} },
      },
      operatorStrategies: {
        [operator.config.id]: 'standard-qso',
      },
      operatorSettings: {
        [operator.config.id]: {
          'pausable-tx-control': { autoCallEnabled: true },
        },
      },
      operatorPluginPauses: {},
    });

    await pluginManager.start();
    const setOperatorPluginPauses = vi.fn(async () => {});
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      setOperatorPluginPauses,
    } as unknown as ConfigManager);
    const timerManager = (pluginManager as any).instances.get(operator.config.id).get('pausable-tx-control').ctx.timers;
    timerManager.onTimerFired('poll');
    await (pluginManager as any).handleSlotStart({ id: 'slot-1', startMs: 0, window: 0 }, null);
    pluginManager.handlePluginUserAction('pausable-tx-control', 'ping', operator.config.id);

    const countLogs = (message: string) => pluginManager.getRuntimeLogHistory()
      .filter((entry) => isPluginLogEntry(entry) && entry.pluginName === 'pausable-tx-control' && entry.message === message)
      .length;
    expect(countLogs('timer:poll')).toBe(1);
    expect(countLogs('decode')).toBe(1);
    expect(countLogs('action:ping')).toBe(1);

    const statusChanged = vi.fn();
    eventEmitter.on('pluginStatusChanged', statusChanged);
    await pluginManager.setOperatorPluginPaused(operator.config.id, 'pausable-tx-control', true);

    const pausedStatus = pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === 'pausable-tx-control');
    expect(pausedStatus?.autoCallEnabledOperatorIds).toEqual([operator.config.id]);
    expect(pausedStatus?.pausedOperatorIds).toEqual([operator.config.id]);
    expect(setOperatorPluginPauses).toHaveBeenCalledWith(operator.config.id, ['pausable-tx-control']);
    expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({
      plugin: expect.objectContaining({
        name: 'pausable-tx-control',
        pausedOperatorIds: [operator.config.id],
      }),
    }));

    timerManager.onTimerFired('poll');
    await (pluginManager as any).handleSlotStart({ id: 'slot-2', startMs: 15_000, window: 0 }, null);
    expect(() => pluginManager.handlePluginUserAction('pausable-tx-control', 'ping', operator.config.id)).toThrow('paused');
    expect(countLogs('timer:poll')).toBe(1);
    expect(countLogs('decode')).toBe(1);
    expect(countLogs('action:ping')).toBe(1);

    await pluginManager.setOperatorPluginPaused(operator.config.id, 'pausable-tx-control', false);
    await (pluginManager as any).handleSlotStart({ id: 'slot-3', startMs: 30_000, window: 0 }, null);
    expect(() => pluginManager.handlePluginUserAction('pausable-tx-control', 'ping', operator.config.id)).not.toThrow();
    expect(countLogs('decode')).toBe(2);
    expect(countLogs('action:ping')).toBe(2);

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
