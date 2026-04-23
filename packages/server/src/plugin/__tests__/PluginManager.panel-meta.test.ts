import { afterEach, describe, expect, it } from 'vitest';
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

describe('PluginManager panel meta snapshots', () => {
  it('includes operator panel meta in the initial snapshot and refreshes it after config changes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-panel-meta-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'panel-meta-test', `
      const PANEL_ID = 'operator-webview';

      function sync(ctx) {
        ctx.ui.setPanelMeta(PANEL_ID, {
          visible: Boolean(ctx.config.operatorCardUrl),
          title: '',
        });
      }

      export default {
        name: 'panel-meta-test',
        version: '1.0.0',
        type: 'utility',
        settings: {
          operatorCardUrl: {
            type: 'string',
            default: '',
            label: 'Operator URL',
            scope: 'operator',
          },
        },
        onLoad(ctx) {
          sync(ctx);
        },
        hooks: {
          onConfigChange(_changes, ctx) {
            sync(ctx);
          },
        },
      };
    `);

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operators = [createOperator('operator-1', 'BG4IAJ')];

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => operators,
      getOperatorById: (id) => operators.find((operator) => operator.config.id === id),
      getCurrentMode: () => operators[0]?.config.mode ?? MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: (operatorId, callsign, lastMessage) => {
        pluginManager.requestCall(operatorId, callsign, lastMessage);
      },
      getRadioFrequency: async () => operators[0]?.config.frequency ?? null,
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
      configs: {
        'panel-meta-test': { enabled: true, settings: {} },
      },
      operatorStrategies: {
        'operator-1': 'standard-qso',
      },
      operatorSettings: {
        'operator-1': {
          'standard-qso': {
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: false,
            targetSelectionPriorityMode: 'dxcc_first',
            maxQSOTimeoutCycles: 6,
            maxCallAttempts: 5,
          },
          'panel-meta-test': {
            operatorCardUrl: '',
          },
        },
      },
    });

    await pluginManager.start();

    expect(pluginManager.getSnapshot().panelMeta).toContainEqual({
      pluginName: 'panel-meta-test',
      operatorId: 'operator-1',
      panelId: 'operator-webview',
      meta: {
        visible: false,
        title: '',
      },
    });

    pluginManager.setOperatorPluginSettings('operator-1', 'panel-meta-test', {
      operatorCardUrl: 'https://example.com',
    });

    expect(pluginManager.getSnapshot().panelMeta).toContainEqual({
      pluginName: 'panel-meta-test',
      operatorId: 'operator-1',
      panelId: 'operator-webview',
      meta: {
        visible: true,
        title: '',
      },
    });

    await pluginManager.shutdown();
  });
});
