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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it('detaches page push data before queueing and broadcasting it', () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const listener = vi.fn();
    eventEmitter.on('pluginPagePush', listener);
    const manager = new PluginManager({
      eventEmitter,
      getOperators: () => [],
      getOperatorById: () => undefined,
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: () => null,
      requestOperatorCall: () => {},
      getRadioFrequency: async () => null,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir: '/tmp/tx5dr-page-push-test',
    });
    const session = manager.createPluginPageSession({
      pluginName: 'demo',
      pageId: 'settings',
      accessScope: 'admin',
      instanceTarget: { kind: 'global' },
    });
    const data = { nested: { value: 1 } };

    manager.pushPluginPageSession('demo', 'settings', session.sessionId, 'updated', data);
    data.nested.value = 2;

    expect(listener.mock.calls[0]?.[0].data).toEqual({ nested: { value: 1 } });
    expect(manager.pullPluginPageSessionPushes(
      'demo', 'settings', session.sessionId,
    )[0]?.data).toEqual({ nested: { value: 1 } });
  });

  it('returns stored sync configuration as detached page data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-sync-page-'));
    tempDirs.push(dataDir);
    const wavelogDir = join(dataDir, 'plugin-data', 'wavelog-sync');
    const lotwDir = join(dataDir, 'plugin-data', 'lotw-sync');
    const qrzDir = join(dataDir, 'plugin-data', 'qrz-sync');
    const clublogDir = join(dataDir, 'plugin-data', 'clublog-sync');
    await Promise.all([
      mkdir(wavelogDir, { recursive: true }),
      mkdir(lotwDir, { recursive: true }),
      mkdir(qrzDir, { recursive: true }),
      mkdir(clublogDir, { recursive: true }),
    ]);
    const wavelogConfig = {
      url: 'https://wavelog.example.test',
      apiKey: 'test-api-key',
      stationId: '7',
      radioName: 'TX5DR',
      autoUploadQSO: true,
    };
    const lotwConfig = {
      username: 'BG5DRB',
      password: 'test-password',
      autoUploadQSO: false,
    };
    const qrzConfig = { apiKey: 'qrz-test-key', autoUploadQSO: true };
    const clublogConfig = {
      email: 'operator@example.test',
      password: 'clublog-test-password',
      autoUploadQSO: false,
    };
    await Promise.all([
      writeFile(
        join(wavelogDir, 'global.json'),
        JSON.stringify({ 'config:BG5DRB': wavelogConfig }),
        'utf8',
      ),
      writeFile(
        join(lotwDir, 'global.json'),
        JSON.stringify({ 'config:BG5DRB': lotwConfig }),
        'utf8',
      ),
      writeFile(
        join(qrzDir, 'global.json'),
        JSON.stringify({ 'config:BG5DRB': qrzConfig }),
        'utf8',
      ),
      writeFile(
        join(clublogDir, 'global.json'),
        JSON.stringify({ 'config:BG5DRB': clublogConfig }),
        'utf8',
      ),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      station_id: 7,
      station_profile_name: 'Primary',
      station_callsign: 'BG5DRB',
    }]), { status: 200 })));

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const manager = new PluginManager({
      eventEmitter,
      getOperators: () => [],
      getOperatorById: () => undefined,
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: () => null,
      requestOperatorCall: () => {},
      getRadioFrequency: async () => null,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir,
    });
    manager.loadConfig({
      configs: {
        'wavelog-sync': { enabled: true, settings: {} },
        'lotw-sync': { enabled: true, settings: {} },
        'qrz-sync': { enabled: true, settings: {} },
        'clublog-sync': { enabled: true, settings: {} },
      },
      operatorStrategies: {},
      operatorSettings: {},
    });
    await manager.start();

    const requestContext = {
      pageSessionId: 'session-sync',
      user: { tokenId: 'token-1', role: 'operator' as const, operatorIds: [] },
      resource: { kind: 'callsign' as const, value: 'BG5DRB' },
      instanceTarget: { kind: 'global' as const },
      files: { write: async () => {}, read: async () => null, delete: async () => false, list: async () => [] },
      page: {
        sessionId: 'session-sync',
        pageId: 'settings',
        resource: { kind: 'callsign' as const, value: 'BG5DRB' },
        push() {},
      },
    };

    const wavelog = await manager.invokePluginPageHandler(
      'wavelog-sync', 'settings', 'getConfig', { callsign: 'BG5DRB' }, requestContext,
    ) as typeof wavelogConfig;
    const lotw = await manager.invokePluginPageHandler(
      'lotw-sync', 'settings', 'getConfig', { callsign: 'BG5DRB' }, requestContext,
    ) as typeof lotwConfig;
    const qrz = await manager.invokePluginPageHandler(
      'qrz-sync', 'settings', 'getConfig', { callsign: 'BG5DRB' }, requestContext,
    ) as typeof qrzConfig;
    const clublog = await manager.invokePluginPageHandler(
      'clublog-sync', 'settings', 'getConfig', { callsign: 'BG5DRB' }, requestContext,
    ) as { config: typeof clublogConfig };
    const connection = await manager.invokePluginPageHandler(
      'wavelog-sync',
      'settings',
      'testConnection',
      { callsign: 'BG5DRB', url: wavelogConfig.url, apiKey: wavelogConfig.apiKey },
      requestContext,
    ) as { success: boolean; stations: Array<{ station_id: string }> };

    expect(wavelog).toEqual(wavelogConfig);
    expect(lotw).toEqual(lotwConfig);
    expect(qrz).toEqual(qrzConfig);
    expect(clublog.config).toEqual(clublogConfig);
    expect(connection).toMatchObject({ success: true, stations: [{ station_id: '7' }] });
    expect(() => JSON.stringify({ wavelog, lotw, qrz, clublog, connection })).not.toThrow();
    wavelog.url = 'https://mutated.example.test';
    await expect(manager.invokePluginPageHandler(
      'wavelog-sync', 'settings', 'getConfig', { callsign: 'BG5DRB' }, requestContext,
    )).resolves.toEqual(wavelogConfig);

    await manager.shutdown();
  });

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
        files: {
          write: async () => {},
          read: async () => null,
          delete: async () => false,
          list: async () => [],
        },
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

  it('revokes page files and push capabilities after their request invocation ends', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-page-revoke-'));
    tempDirs.push(dataDir);
    await writeUserPlugin(dataDir, 'page-revoke-test', `
      let retained;
      export default {
        name: 'page-revoke-test',
        version: '1.0.0',
        type: 'utility',
        instanceScope: 'global',
        ui: { pages: [{ id: 'settings', title: 'Settings', entry: 'settings.html' }] },
        onLoad(ctx) {
          ctx.ui.registerPageHandler({
            async onMessage(_pageId, action, _data, requestContext) {
              if (action === 'echo-mutate') {
                _data.nested.value = 2;
                return _data;
              }
              if (action === 'retain') {
                retained = requestContext;
                return 'retained';
              }
              if (action === 'return-capabilities') {
                return { files: requestContext.files, page: requestContext.page };
              }
              if (action === 'reuse-files') {
                await retained.files.write('late.bin', Buffer.from('late'));
              }
              if (action === 'reuse-push') {
                retained.page.push('late');
              }
              return 'ok';
            },
          });
        },
      };
    `);
    await mkdir(join(dataDir, 'plugins', 'page-revoke-test', 'ui'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'page-revoke-test', 'ui', 'settings.html'),
      '<!doctype html><html><body>settings</body></html>',
      'utf8',
    );

    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const manager = new PluginManager({
      eventEmitter,
      getOperators: () => [],
      getOperatorById: () => undefined,
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: () => null,
      requestOperatorCall: () => {},
      getRadioFrequency: async () => null,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir,
    });
    manager.loadConfig({
      configs: { 'page-revoke-test': { enabled: true, settings: {} } },
      operatorStrategies: {},
      operatorSettings: {},
    });
    await manager.start();

    const write = vi.fn(async () => undefined);
    const push = vi.fn();
    const context = {
      pageSessionId: 'session-1',
      user: { tokenId: 'token-1', role: 'admin' as const, operatorIds: [] },
      instanceTarget: { kind: 'global' as const },
      files: { write, read: async () => null, delete: async () => false, list: async () => [] },
      page: { sessionId: 'session-1', pageId: 'settings', push },
    };

    const input = { nested: { value: 1 } };
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'echo-mutate', input, context,
    )).resolves.toEqual({ nested: { value: 2 } });
    expect(input).toEqual({ nested: { value: 1 } });

    await expect(manager.invokePluginPageHandler(
      'page-revoke-test',
      'settings',
      'echo-mutate',
      { nested: { value: 1 }, date: new Date('2026-08-23T00:00:00.000Z'), omitted: undefined, nan: NaN },
      context,
    )).resolves.toEqual({
      nested: { value: 2 },
      date: '2026-08-23T00:00:00.000Z',
      nan: null,
    });

    const cyclic: Record<string, unknown> = { nested: { value: 1 } };
    cyclic.self = cyclic;
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'echo-mutate', cyclic, context,
    )).rejects.toMatchObject({ code: 'PLUGIN_DATA_NOT_SERIALIZABLE' });
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'echo-mutate', { nested: { value: 1 }, invalid: 1n }, context,
    )).rejects.toMatchObject({ code: 'PLUGIN_DATA_NOT_SERIALIZABLE' });

    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'retain', null, context,
    )).resolves.toBe('retained');
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'return-capabilities', null, context,
    )).rejects.toMatchObject({ code: 'PLUGIN_DATA_NOT_SERIALIZABLE' });
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'reuse-files', null, context,
    )).rejects.toThrow('Plugin invocation-scoped capability has expired');
    await expect(manager.invokePluginPageHandler(
      'page-revoke-test', 'settings', 'reuse-push', null, context,
    )).rejects.toThrow('Plugin invocation-scoped capability has expired');
    expect(write).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    await manager.shutdown();
  });
});
