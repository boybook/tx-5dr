import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';
import { writePluginSource } from '../plugin-source.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeUserPlugin(
  dataDir: string,
  pluginName: string,
  source: string,
): Promise<void> {
  const pluginDir = join(dataDir, 'plugins', pluginName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.mjs'), source, 'utf8');
}

function createOperator(): RadioOperator {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
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

describe('PluginManager plugin source metadata', () => {
  it('reads marketplace source from the plugin directory metadata file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-source-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'market-source-test', `
      export default {
        name: 'market-source-test',
        version: '1.2.3',
        type: 'utility',
      };
    `);
    await writePluginSource(join(dataDir, 'plugins', 'market-source-test'), {
      kind: 'marketplace',
      version: '1.2.3',
      channel: 'nightly',
      artifactUrl: 'https://dl.tx5dr.com/plugins/demo.zip',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      installedAt: 1_777_000_000_000,
    });

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operator = createOperator();
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

    await pluginManager.start();

    const plugin = pluginManager.getSnapshot().plugins.find((entry) => entry.name === 'market-source-test');
    expect(plugin?.source).toMatchObject({
      kind: 'marketplace',
      version: '1.2.3',
      channel: 'nightly',
      artifactUrl: 'https://dl.tx5dr.com/plugins/demo.zip',
    });

    await pluginManager.shutdown();
  });
});
