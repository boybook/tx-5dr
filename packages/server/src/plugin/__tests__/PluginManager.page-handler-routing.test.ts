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

describe('PluginManager page handler routing', () => {
  it('routes invoke requests to the exact operator-scoped plugin instance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-page-routing-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'page-routing-test', `
      export default {
        name: 'page-routing-test',
        version: '1.0.0',
        type: 'utility',
        ui: {
          pages: [
            {
              id: 'settings',
              title: 'Settings',
              entry: 'settings.html',
              accessScope: 'operator',
              resourceBinding: 'none',
            },
          ],
        },
        onLoad(ctx) {
          ctx.ui.registerPageHandler({
            async onMessage(_pageId, action) {
              if (action !== 'whoami') {
                throw new Error('unexpected action');
              }
              return { operatorId: ctx.operator.id };
            },
          });
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'page-routing-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'page-routing-test', 'ui', 'settings.html'),
      '<!doctype html><html><body>settings</body></html>',
      'utf8',
    );

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operators = [
      createOperator('operator-1', 'BG4IAJ'),
      createOperator('operator-2', 'BG5DRB'),
    ];

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
        'page-routing-test': { enabled: true, settings: {} },
      },
      operatorStrategies: Object.fromEntries(
        operators.map((operator) => [operator.config.id, 'standard-qso']),
      ),
      operatorSettings: {},
    });

    await pluginManager.start();

    const invoke = (operatorId: string) => pluginManager.invokePluginPageHandler(
      'page-routing-test',
      'settings',
      'whoami',
      null,
      {
        pageSessionId: `session-${operatorId}`,
        user: {
          tokenId: 'token-1',
          role: 'operator',
          operatorIds: [operatorId],
        },
        instanceTarget: { kind: 'operator', operatorId },
        page: {
          sessionId: `session-${operatorId}`,
          pageId: 'settings',
          push() {},
        },
      },
    );

    await expect(invoke('operator-1')).resolves.toEqual({ operatorId: 'operator-1' });
    await expect(invoke('operator-2')).resolves.toEqual({ operatorId: 'operator-2' });

    await pluginManager.shutdown();
  });
});
