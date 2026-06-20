import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeUserPlugin(dataDir: string, pluginName: string, source: string): Promise<void> {
  const pluginDir = join(dataDir, 'plugins', pluginName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.mjs'), source, 'utf8');
}

function createOperator(id: string, callsign: string): RadioOperator {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
    eventEmitter.emit('hasWorkedCallsignResponse' as any, {
      requestId: data.requestId,
      hasWorked: false,
    });
  });

  return new RadioOperator({
    id,
    mode: MODES.FT8,
    myCallsign: callsign,
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

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('PluginManager event bus lifecycle', () => {
  it('logs subscriber failures without aborting publishers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-event-bus-errors-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'failing-subscriber', `
      export default {
        name: 'failing-subscriber',
        version: '1.0.0',
        type: 'utility',
        permissions: ['plugin:event-bus'],
        onLoad(ctx) {
          ctx.eventBus.subscribe('plugin.topic', () => {
            throw new Error('subscriber boom');
          });
        },
      };
    `);

    await writeUserPlugin(dataDir, 'publisher-plugin', `
      export default {
        name: 'publisher-plugin',
        version: '1.0.0',
        type: 'utility',
        permissions: ['plugin:event-bus'],
        onLoad(ctx) {
          ctx.eventBus.publish('plugin.topic', 'value');
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const operator = createOperator('operator-1', 'BG4IAJ');
    const pluginManager = createPluginManager(dataDir, eventEmitter, operator);
    pluginManager.loadConfig({
      configs: {
        'qso-udp-broadcast': { enabled: false, settings: {} },
        'failing-subscriber': { enabled: true, settings: {} },
        'publisher-plugin': { enabled: true, settings: {} },
      },
      operatorStrategies: {
        [operator.config.id]: 'standard-qso',
      },
      operatorSettings: {},
    });

    await pluginManager.start();
    await flushAsyncWork();

    const runtimeLogs = pluginManager.getRuntimeLogHistory().filter((entry) => (
      'source' in entry
      && entry.source === 'system'
      && entry.pluginName === 'failing-subscriber'
      && entry.message === 'Plugin event bus subscriber failed'
    ));
    expect(runtimeLogs.length).toBeGreaterThan(0);

    await pluginManager.shutdown();
  });
});
