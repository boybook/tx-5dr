import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PluginManager global instance scope', () => {
  it('accepts runtime radio-control-toolbar panel contributions from global utility instances', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-global-toolbar-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'global-toolbar-test', `
      export default {
        name: 'global-toolbar-test',
        version: '1.0.0',
        type: 'utility',
        instanceScope: 'global',
        ui: {
          pages: [
            { id: 'rotator', title: 'Rotator', entry: 'rotator.html', accessScope: 'operator', resourceBinding: 'none' },
          ],
        },
        onLoad(ctx) {
          ctx.ui.setPanelContributions('toolbar', [{
            id: 'rotator-button',
            title: 'Rotator',
            component: 'iframe',
            pageId: 'rotator',
            slot: 'radio-control-toolbar',
            icon: 'satellite-dish',
            openMode: 'popover',
            uiSize: 'md',
          }]);
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'global-toolbar-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'global-toolbar-test', 'ui', 'rotator.html'),
      '<!doctype html><html><body>rotator</body></html>',
      'utf8',
    );

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operator = createOperator('operator-1', 'BG4IAJ');
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
      configs: {
        'global-toolbar-test': { enabled: true, settings: {} },
      },
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

    expect(pluginManager.getSnapshot().panelContributions).toContainEqual({
      pluginName: 'global-toolbar-test',
      groupId: 'toolbar',
      source: 'runtime',
      instanceTarget: { kind: 'global' },
      panels: [expect.objectContaining({
        id: 'rotator-button',
        component: 'iframe',
        pageId: 'rotator',
        slot: 'radio-control-toolbar',
      })],
    });

    await pluginManager.shutdown();
  });

  it('rejects runtime radio-control-toolbar contributions outside global unbound UI pages', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-invalid-toolbar-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'operator-toolbar-test', `
      export default {
        name: 'operator-toolbar-test',
        version: '1.0.0',
        type: 'utility',
        ui: {
          pages: [
            { id: 'rotator', title: 'Rotator', entry: 'rotator.html', accessScope: 'operator', resourceBinding: 'none' },
          ],
        },
        onLoad(ctx) {
          ctx.ui.setPanelContributions('toolbar', [{
            id: 'rotator-button',
            title: 'Rotator',
            component: 'iframe',
            pageId: 'rotator',
            slot: 'radio-control-toolbar',
          }]);
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'operator-toolbar-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'operator-toolbar-test', 'ui', 'rotator.html'),
      '<!doctype html><html><body>rotator</body></html>',
      'utf8',
    );

    await writeUserPlugin(dataDir, 'bound-toolbar-test', `
      export default {
        name: 'bound-toolbar-test',
        version: '1.0.0',
        type: 'utility',
        instanceScope: 'global',
        ui: {
          pages: [
            { id: 'rotator', title: 'Rotator', entry: 'rotator.html', accessScope: 'operator', resourceBinding: 'operator' },
          ],
        },
        onLoad(ctx) {
          ctx.ui.setPanelContributions('toolbar', [{
            id: 'rotator-button',
            title: 'Rotator',
            component: 'iframe',
            pageId: 'rotator',
            slot: 'radio-control-toolbar',
          }]);
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'bound-toolbar-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'bound-toolbar-test', 'ui', 'rotator.html'),
      '<!doctype html><html><body>rotator</body></html>',
      'utf8',
    );

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operator = createOperator('operator-1', 'BG4IAJ');
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
      configs: {
        'operator-toolbar-test': { enabled: true, settings: {} },
        'bound-toolbar-test': { enabled: true, settings: {} },
      },
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

    expect((pluginManager.getSnapshot().panelContributions ?? []).filter((group) =>
      group.pluginName === 'operator-toolbar-test' || group.pluginName === 'bound-toolbar-test',
    )).toEqual([]);
    const runtimeLogDetails = pluginManager.getRuntimeLogHistory()
      .filter((entry): entry is typeof entry & { details: unknown } => 'details' in entry)
      .map((entry) => entry.details);
    expect(runtimeLogDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: 'radio-control-toolbar panels are only supported for global utility plugins',
        }),
        expect.objectContaining({
          error: 'radio-control-toolbar panel "rotator-button" must reference a UI page with resourceBinding "none"',
        }),
      ]),
    );

    await pluginManager.shutdown();
  });

  it('creates a global utility plugin only once and unregisters its sync provider on disable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-global-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'global-sync-test', `
      export default {
        name: 'global-sync-test',
        version: '1.0.0',
        type: 'utility',
        instanceScope: 'global',
        ui: {
          pages: [
            {
              id: 'settings',
              title: 'Settings',
              entry: 'settings.html',
              accessScope: 'operator',
              resourceBinding: 'callsign',
            },
          ],
        },
        onLoad: async (ctx) => {
          const existing = await ctx.files.read('load-count.txt');
          const nextCount = existing ? Number(existing.toString('utf8')) + 1 : 1;
          await ctx.files.write('load-count.txt', Buffer.from(String(nextCount), 'utf8'));
          ctx.logbookSync.register({
            id: 'global-sync-test-provider',
            displayName: 'Global Sync Test',
            settingsPageId: 'settings',
            accessScope: 'operator',
            testConnection: async () => ({ success: true, message: 'ok' }),
            upload: async () => ({ uploaded: 0, skipped: 0, failed: 0 }),
            download: async () => ({ downloaded: 0, matched: 0, updated: 0 }),
            isConfigured: () => true,
            isAutoUploadEnabled: () => false,
          });
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'global-sync-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'global-sync-test', 'ui', 'settings.html'),
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
        'global-sync-test': { enabled: true, settings: {} },
      },
      operatorStrategies: Object.fromEntries(
        operators.map((operator) => [operator.config.id, 'standard-qso']),
      ),
      operatorSettings: Object.fromEntries(
        operators.map((operator) => [
          operator.config.id,
          {
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
        ]),
      ),
    });

    await pluginManager.start();

    const loadCountFile = join(
      dataDir,
      'plugin-data',
      'global-sync-test',
      'files',
      'load-count.txt',
    );
    expect(await readFile(loadCountFile, 'utf8')).toBe('1');

    const registeredProviders = pluginManager.logbookSyncHost.getProviders('operator');
    expect(registeredProviders.some((provider) => provider.id === 'global-sync-test-provider')).toBe(true);

    pluginManager.setPluginEnabled('global-sync-test', false);
    await flushAsyncWork();

    const remainingProviders = pluginManager.logbookSyncHost.getProviders('operator');
    expect(remainingProviders.some((provider) => provider.id === 'global-sync-test-provider')).toBe(false);

    await pluginManager.shutdown();
  });

  it('dispatches frequency changes to active operator plugin instances', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-frequency-hook-'));
    tempDirs.push(dataDir);

    await writeUserPlugin(dataDir, 'frequency-hook-test', `
      export default {
        name: 'frequency-hook-test',
        version: '1.0.0',
        type: 'utility',
        hooks: {
          onFrequencyChange(state, ctx) {
            ctx.log.info('frequency-hook-fired', {
              frequency: state.frequency,
              mode: state.mode,
              band: state.band,
            });
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
    const pluginLogs: Array<{ pluginName: string; message: string; data?: unknown }> = [];
    eventEmitter.on('pluginLog' as any, (entry: { pluginName: string; message: string; data?: unknown }) => pluginLogs.push(entry));

    const operator = createOperator('operator-1', 'BG4IAJ');
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
      configs: {
        'frequency-hook-test': { enabled: true, settings: {} },
      },
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
    eventEmitter.emit('frequencyChanged', {
      frequency: 7_074_000,
      mode: 'FT8',
      band: '40m',
      description: '40m FT8',
      radioConnected: true,
      source: 'program',
    });
    await flushAsyncWork();

    expect(pluginLogs).toContainEqual(expect.objectContaining({
      pluginName: 'frequency-hook-test',
      message: 'frequency-hook-fired',
      data: expect.objectContaining({
        frequency: 7_074_000,
        mode: 'FT8',
        band: '40m',
      }),
    }));

    await pluginManager.shutdown();
  });
});
