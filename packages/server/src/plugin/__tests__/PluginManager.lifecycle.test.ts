import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import { PluginManager } from '../PluginManager.js';

const tempDirs: string[] = [];
const lifecycleProbeKey = '__tx5drPluginLifecycleProbe';

interface LifecycleProbe {
  onLoad?: (ctx: RuntimePluginContext) => void | Promise<void>;
  onUnload?: (ctx: RuntimePluginContext) => void | Promise<void>;
}

function getLifecycleProbe(): LifecycleProbe {
  return (globalThis as typeof globalThis & Record<typeof lifecycleProbeKey, LifecycleProbe>)[lifecycleProbeKey];
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete (globalThis as typeof globalThis & Partial<Record<typeof lifecycleProbeKey, LifecycleProbe>>)[lifecycleProbeKey];
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

async function createManager(): Promise<{
  manager: PluginManager;
  operator: RadioOperator;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-lifecycle-'));
  tempDirs.push(dataDir);
  const pluginDir = join(dataDir, 'plugins', 'lifecycle-probe');
  await mkdir(pluginDir, { recursive: true });
  (globalThis as typeof globalThis & Record<typeof lifecycleProbeKey, LifecycleProbe>)[lifecycleProbeKey] = {};
  await writeFile(join(pluginDir, 'index.mjs'), `
    export default {
      apiVersion: 2,
      name: 'lifecycle-probe',
      version: '1.0.0',
      type: 'utility',
      permissions: ['operator:transmit-control', 'host:hamlib'],
      isAutoCallEnabled() { return true; },
      onLoad(ctx) {
        return globalThis.${lifecycleProbeKey}?.onLoad?.(ctx);
      },
      onUnload(ctx) {
        return globalThis.${lifecycleProbeKey}?.onUnload?.(ctx);
      },
    };
  `, 'utf8');

  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const operator = createOperator(eventEmitter);
  let manager!: PluginManager;
  manager = new PluginManager({
    eventEmitter,
    getOperators: () => [operator],
    getOperatorById: (id) => (id === operator.config.id ? operator : undefined),
    getCurrentMode: () => operator.config.mode,
    getOperatorAutomationSnapshot: (id) => manager.getOperatorAutomationSnapshot(id),
    requestOperatorCall: (operatorId, callsign, lastMessage) => {
      manager.requestCall(operatorId, callsign, lastMessage);
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
  manager.loadConfig({
    configs: {
      'lifecycle-probe': { enabled: false, settings: {} },
    },
    operatorStrategies: {
      [operator.config.id]: 'standard-qso',
    },
    operatorSettings: {},
  });
  await manager.start();
  return { manager, operator };
}

function getProbeInstance(manager: PluginManager, operatorId: string): any {
  return (manager as any).instances.get(operatorId).get('lifecycle-probe');
}

describe('PluginManager instance lifecycle reconciliation', () => {
  it('tombstones an obsolete activation when enable and disable race in one turn', async () => {
    const { manager, operator } = await createManager();
    const instance = getProbeInstance(manager, operator.config.id);
    const onLoad = vi.fn();
    getLifecycleProbe().onLoad = onLoad;

    manager.setPluginEnabled('lifecycle-probe', true);
    manager.setPluginEnabled('lifecycle-probe', false);
    await instance.lifecycleTail;

    expect(onLoad).not.toHaveBeenCalled();
    expect(instance.lifecycle).toBe('inactive');
    expect(instance.desiredLifecycle).toBe('inactive');
    await manager.shutdown();
  });

  it('revokes a suspended onLoad before its late continuation can submit a command', async () => {
    const { manager, operator } = await createManager();
    const instance = getProbeInstance(manager, operator.config.id);
    let releaseLoad!: () => void;
    let markStarted!: () => void;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let lateCommandError: unknown;
    let markLateDone!: () => void;
    const lateDone = new Promise<void>((resolve) => { markLateDone = resolve; });
    const onUnload = vi.fn();

    getLifecycleProbe().onLoad = async (ctx: RuntimePluginContext) => {
      markStarted();
      await loadGate;
      try {
        await ctx.operatorCommands?.submit({ type: 'start-automation' });
      } catch (error) {
        lateCommandError = error;
      } finally {
        markLateDone();
      }
    };
    getLifecycleProbe().onUnload = onUnload;

    manager.setPluginEnabled('lifecycle-probe', true);
    await started;
    manager.setPluginEnabled('lifecycle-probe', false);
    releaseLoad();
    await Promise.all([instance.lifecycleTail, lateDone]);

    expect(lateCommandError).toMatchObject({ code: 'PLUGIN_INVOCATION_EXPIRED' });
    expect(onUnload).toHaveBeenCalledOnce();
    expect(instance.lifecycle).toBe('inactive');
    await manager.shutdown();
  });

  it('rebuilds ingress when a queued deactivate is superseded by re-enable', async () => {
    const { manager, operator } = await createManager();
    const instance = getProbeInstance(manager, operator.config.id);
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    getLifecycleProbe().onLoad = onLoad;
    getLifecycleProbe().onUnload = onUnload;

    manager.setPluginEnabled('lifecycle-probe', true);
    await instance.lifecycleTail;
    expect(instance.lifecycle).toBe('active');

    manager.setPluginEnabled('lifecycle-probe', false);
    manager.setPluginEnabled('lifecycle-probe', true);
    await instance.lifecycleTail;

    expect(onUnload).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(instance.lifecycle).toBe('active');
    expect(instance.desiredLifecycle).toBe('active');
    await manager.shutdown();
  });

  it('allows native-resource and UI cleanup without reopening command capabilities', async () => {
    const { manager, operator } = await createManager();
    const instance = getProbeInstance(manager, operator.config.id);
    let hamlibVersion: string | undefined;
    let activeSessions: number | undefined;
    let cleanupOperatorId: string | undefined;
    let commandError: unknown;

    getLifecycleProbe().onUnload = async (ctx) => {
      hamlibVersion = ctx.hostDependencies?.hamlib?.Rotator.getHamlibVersion();
      activeSessions = ctx.ui.listActivePageSessions('cleanup-test').length;
      cleanupOperatorId = ctx.operator.id;
      try {
        await ctx.operatorCommands?.submit({ type: 'start-automation' });
      } catch (error) {
        commandError = error;
      }
    };

    manager.setPluginEnabled('lifecycle-probe', true);
    await instance.lifecycleTail;
    manager.setPluginEnabled('lifecycle-probe', false);
    await instance.lifecycleTail;

    expect(hamlibVersion).toBeTruthy();
    expect(activeSessions).toBe(0);
    expect(cleanupOperatorId).toBe(operator.config.id);
    expect(commandError).toMatchObject({ code: 'PLUGIN_INVOCATION_EXPIRED' });
    await manager.shutdown();
  });
});
