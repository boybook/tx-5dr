import type {
  DigitalRadioEngineEvents,
  PluginLogEntry,
  PluginLogHistoryEntry,
  PluginPanelDescriptor,
  PluginPanelMetaPayload,
  PluginRuntimeLogEntry,
  PluginStatus,
  PluginSystemSnapshot,
  PluginUIPanelContributionGroup,
  PluginsConfig,
  SlotInfo,
  SlotPack,
  FrameMessage,
  QSORecord,
  StrategyRuntimeContext,
} from '@tx5dr/contracts';
import type {
  RuntimePluginContext,
  StrategyPluginContext,
  PluginOperatorCommand,
  PluginOperatorCommandResult,
  PluginUIRequestContext,
  PluginUIInstanceTarget,
  QSOFailureInfo,
  StrategyRuntime,
  StrategyRuntimeSlot,
  StrategyRuntimeSnapshot,
  StrategyStreamStateUpdate,
  StrategyActionInvocation,
  StrategyActionDescriptor,
  AssistedQueueSnapshot,
  QueuedStrategyMutationResult,
  QueuedStrategyTargetRequest,
} from '@tx5dr/plugin-api';
import { isQueuedStrategyRuntime } from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import {
  PluginLoader,
  canonicalizePluginDefinition,
  type PluginLoaderRuntimeLogEvent,
} from './PluginLoader.js';
import { ConfigManager } from '../config/config-manager.js';
import { getStandardDigitalFrequencyMatch, isUndecodedCallsignPlaceholder } from '@tx5dr/core';
import { PluginDevWatcher } from './PluginDevWatcher.js';
import { PluginHookDispatcher } from './PluginHookDispatcher.js';
import { PluginInvocationGuard } from './PluginInvocationGuard.js';
import { DecisionOrchestrator } from './DecisionOrchestrator.js';
import { PluginContextFactory } from './PluginContextFactory.js';
import { PluginEventBusHost } from './PluginEventBusHost.js';
import { LogbookSyncHost } from './LogbookSyncHost.js';
import { PluginPageSessionStore, type PluginPageSession } from './PluginPageSessionStore.js';
import {
  buildStandardQSODefaultTx6Message,
  BUILTIN_PLUGINS,
  BUILTIN_SNR_FILTER_PLUGIN_NAME,
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
  normalizeStandardQSOTx6MessageOverride,
  STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING,
} from '@tx5dr/builtin-plugins';
import { BUILTIN_MIGRATIONS } from './builtin-migrations/index.js';
import { toPluginStatus, toPluginSystemSnapshot } from './types.js';
import type { LoadedPlugin, PluginInstance, PluginManagerDeps, PluginSystemRuntimeState, FlushableKVStore } from './types.js';
import { readPluginSource } from './plugin-source.js';
import { createLogger } from '../utils/logger.js';
import { resolvePluginPaths } from './paths.js';
import path from 'path';
import { OperatorIntentCoordinator } from '../transmission/OperatorIntentCoordinator.js';
import { markPluginCapabilityTree, snapshotPluginData } from './plugin-data-boundary.js';

const logger = createLogger('PluginManager');
const GLOBAL_PLUGIN_SCOPE_ID = '__global__';
const PLUGIN_RUNTIME_LOG_HISTORY_LIMIT = 1000;

/**
 * 插件管理器 — 中央编排器
 *
 * 职责：
 * - 注册内置插件
 * - 扫描 {dataDir}/plugins/ 加载用户插件
 * - 管理插件生命周期（onLoad/onUnload）
 * - 提供 hook 分发 API
 * - 管理每操作员的策略选择
 * - 持久化插件配置
 */
export class PluginManager {
  private static readonly MAX_PAGE_PUSH_QUEUE = 500;
  private nextInstanceGeneration = 0;
  private loadedPlugins = new Map<string, LoadedPlugin>();
  // operatorId → Map<pluginName, PluginInstance>
  private instances = new Map<string, Map<string, PluginInstance>>();
  private globalInstances = new Map<string, PluginInstance>();
  private dispatcher!: PluginHookDispatcher;
  private readonly invocationGuard: PluginInvocationGuard;
  private readonly intentCoordinator: OperatorIntentCoordinator;
  private readonly suspendedQueueExecutions = new Set<string>();
  private readonly queueMutationTails = new Map<string, Promise<void>>();
  private orchestrator!: DecisionOrchestrator;
  private contextFactory: PluginContextFactory;
  private loader: PluginLoader;
  private devWatcher: PluginDevWatcher | null = null;
  private running = false;
  private unsubscribeFns: Array<() => void> = [];
  private _logbookSyncHost: import('./LogbookSyncHost.js').LogbookSyncHost;
  private readonly pageSessions = new PluginPageSessionStore();
  private readonly pageSessionPushQueues = new Map<string, Array<{
    pluginName: string;
    pageId: string;
    pageSessionId: string;
    action: string;
    data?: unknown;
  }>>();
  private readonly panelMetaState = new Map<string, PluginPanelMetaPayload>();
  private readonly runtimePanelContributions = new Map<string, PluginUIPanelContributionGroup>();
  private readonly pluginEventBusHost: PluginEventBusHost;
  private pluginRuntimeLogHistory: PluginLogHistoryEntry[] = [];
  private readonly recordPluginLogHistory = (entry: PluginLogEntry) => {
    this.appendPluginLogHistory(snapshotPluginData(entry, 'json'));
  };

  private systemState: PluginSystemRuntimeState = {
    state: 'ready',
    generation: 0,
  };

  // 配置（来自 ConfigManager）
  private pluginsConfig: PluginsConfig = {
    configs: {},
    operatorStrategies: {},
    operatorSettings: {},
    operatorPluginPauses: {},
  };

  constructor(private deps: PluginManagerDeps) {
    this.intentCoordinator = deps.intentCoordinator ?? new OperatorIntentCoordinator({
      abortGraceMs: 1_000,
      onAbortTimeout: (token) => {
        logger.error('Operator command did not stop after abort; automation remains blocked', token);
      },
    });
    this.invocationGuard = new PluginInvocationGuard(({ instance, operation, elapsedAfterAbortMs }) => {
      this.quarantineHungPluginInstance(instance, operation, elapsedAfterAbortMs);
    });
    this.loader = new PluginLoader((event) => this.emitPluginRuntimeLog(event));
    this._logbookSyncHost = new LogbookSyncHost();
    this.pluginEventBusHost = new PluginEventBusHost(({ subscriber, message, error }) => {
      this.emitPluginRuntimeLog({
        stage: 'activate',
        level: 'warn',
        message: 'Plugin event bus subscriber failed',
        pluginName: subscriber.pluginName,
        details: {
          topic: message.topic,
          publisher: message.publisher,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
    deps.pluginEventBusHost = this.pluginEventBusHost;
    deps.submitOperatorCommand = (operatorId, command, pluginName) => {
      const instance = this.instances.get(operatorId)?.get(pluginName);
      if (!instance
          || instance.lifecycle !== 'active'
          || instance.desiredLifecycle !== 'active') {
        throw new Error('PLUGIN_INVOCATION_EXPIRED: plugin instance is not active');
      }
      return this.submitPluginOperatorCommand(instance, operatorId, command);
    };
    // Wire the logbook sync registration callback so plugins can register
    // providers via ctx.logbookSync.register().
    deps.registerLogbookSyncProvider = (pluginName, provider) => {
      const instance = this.globalInstances.get(pluginName);
      if (!instance || instance.scope.kind !== 'global') {
        throw new Error('PLUGIN_INVOCATION_EXPIRED: sync provider owner is unavailable');
      }
      this.invocationGuard.assertCurrent(instance, 'logbookSync');
      this._logbookSyncHost.register(pluginName, provider, {
        generation: instance.generation,
        isCurrent: () => this.globalInstances.get(pluginName) === instance
          && instance.desiredLifecycle === 'active'
          && (instance.lifecycle === 'starting' || instance.lifecycle === 'active'),
        invoke: (operation, callback) => this.invocationGuard.invokeData(
          instance,
          operation,
          'json',
          callback,
        ),
        invokeSync: (operation, callback) => this.invocationGuard.invokeSync(instance, operation, callback),
      });
    };
    deps.listPluginPageSessions = (pluginName, instanceTarget, pageId) =>
      this.pageSessions.listByPluginInstance(pluginName, instanceTarget, pageId);
    deps.eventEmitter.on('pluginLog', this.recordPluginLogHistory);
    this.contextFactory = new PluginContextFactory(
      deps,
      (payload) => this.recordPanelMeta(payload),
      (pluginName, instanceTarget, groupId, panels) =>
        this.setRuntimePanelContributions(pluginName, instanceTarget, groupId, panels),
      (pluginName, operatorId) => this.isOperatorPluginPaused(operatorId, pluginName),
    );
    this.dispatcher = new PluginHookDispatcher(
      (operatorId) => this.getActiveInstances(operatorId),
      (operatorId) => this.getStrategyInstance(operatorId),
      (pluginName, reason) => this.handleAutoDisable(pluginName, reason),
      this.invocationGuard,
    );
    this.orchestrator = new DecisionOrchestrator({
      getOperators: deps.getOperators,
      getOperatorById: deps.getOperatorById,
      getCurrentMode: deps.getCurrentMode,
      getOperatorAutomationSnapshot: deps.getOperatorAutomationSnapshot,
      interruptOperatorTransmission: deps.interruptOperatorTransmission,
      requestOperatorStrategyStop: deps.requestOperatorStrategyStop ?? (() => undefined),
      transitionTargetReservation: deps.transitionTargetReservation,
      transitionTargetReservations: deps.transitionTargetReservations,
      releaseTargetReservation: deps.releaseTargetReservation,
      analyzeCallsignForOperator: deps.analyzeCallsignForOperator,
      resolveGrid: deps.resolveGrid,
      setOperatorAudioFrequency: deps.setOperatorAudioFrequency,
      isSnrPriorityEnabled: (operatorId) => this.isSnrPriorityEnabled(operatorId),
      isStoppedDirectCallAutoReplyEnabled: (operatorId) => this.isStoppedDirectCallAutoReplyEnabled(operatorId),
      getStrategyRuntime: (operatorId) => this.getStrategyRuntime(operatorId),
      getStrategyRuntimeGeneration: (operatorId) => this.getStrategyInstance(operatorId)?.generation,
      getStrategyMaxConcurrentStreams: (operatorId) => this.getStrategyInstance(operatorId)
        ?.plugin.definition.strategyFeatures?.maxConcurrentStreams,
      getEffectiveOperatorMaxConcurrentStreams: (operatorId) => (
        this.getEffectiveOperatorMaxConcurrentStreams(operatorId)
      ),
      invokeStrategyRuntime: (operatorId, operation, callback, options) =>
        this.invokeStrategyRuntime(operatorId, operation, callback, options),
      invokeStrategyRuntimeSync: (operatorId, operation, callback) =>
        this.invokeStrategyRuntimeSync(operatorId, operation, callback),
      getCtxForInstance: (instance) => this.getCtxForInstance(instance),
      dispatcher: this.dispatcher,
      eventEmitter: deps.eventEmitter,
      requestCall: (operatorId, callsign, lastMessage, options) => this.requestCall(
        operatorId,
        callsign,
        lastMessage,
        { commandToken: options?.commandToken },
      ),
      notifyQSOFail: (operatorId, info) => this.notifyQSOFail(operatorId, info),
      hasTargetQueue: (operatorId) => this.hasTargetQueue(operatorId),
      observeStrategyMessages: (operatorId, messages, slotInfo, source, token, signal) =>
        this.observeStrategyMessages(operatorId, messages, slotInfo, source, token, signal),
      notifyOperatorStatusChanged: (operatorId) => this.deps.notifyOperatorStatusChanged?.(operatorId),
      isQueueExecutionSuspended: (operatorId) => this.suspendedQueueExecutions.has(operatorId),
      markQueueExecutionValidated: (operatorId) => this.suspendedQueueExecutions.delete(operatorId),
      triggerReEncode: deps.triggerReEncode,
      intentCoordinator: this.intentCoordinator,
    });
  }

  private get eventEmitter(): EventEmitter<DigitalRadioEngineEvents> {
    return this.deps.eventEmitter;
  }

  private quarantineHungPluginInstance(
    instance: PluginInstance,
    operation: string,
    elapsedAfterAbortMs: number,
  ): void {
    if (instance.autoDisabled) return;
    instance.autoDisabled = true;
    instance.desiredLifecycle = 'inactive';
    instance.lifecycleRevision += 1;
    instance.lifecycle = 'quarantined';
    instance.lastError = `Invocation ${operation} did not stop within ${elapsedAfterAbortMs}ms after abort`;
    this.closeInstanceIngress(instance);
    this.invocationGuard.revokeInstance(instance, 'plugin instance quarantined after abort timeout');
    void instance.rawCtx.network?.udp.closeAll().catch(() => undefined);
    if (instance.scope.kind === 'operator') {
      this.deps.requestOperatorStrategyStop?.(
        instance.scope.operatorId,
        `plugin ${instance.plugin.definition.name} ignored abort`,
      );
    }
    this.emitPluginRuntimeLog({
      stage: 'activate',
      level: 'error',
      message: 'Plugin instance quarantined after ignoring AbortSignal',
      pluginName: instance.plugin.definition.name,
      details: {
        operatorId: instance.scope.kind === 'operator' ? instance.scope.operatorId : undefined,
        operation,
        elapsedAfterAbortMs,
        generation: instance.generation,
      },
    });
    this.broadcastPluginList();
  }

  /** 允许在 initialize() 阶段设置正确的数据目录 */
  setDataDir(dataDir: string): void {
    this.deps.dataDir = dataDir;
  }

  private getPluginPaths() {
    return resolvePluginPaths(this.deps.dataDir);
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.debug('Plugin manager already started');
      return;
    }

    logger.info('Starting plugin manager');
    this.running = true;
    try {
      await this.loadPluginsIntoMemory();
      this.registerEngineListeners();
      this.bumpGeneration();
      this.broadcastPluginList();
    } catch (error) {
      this.devWatcher?.stop();
      this.devWatcher = null;
      this.unregisterEngineListeners();
      await this.teardownAllInstances().catch(() => {});
      this.running = false;
      throw error;
    }

    logger.info(`Plugin manager started (${this.loadedPlugins.size} plugins)`);

    // Start dev watcher in non-production environments
    if (process.env.NODE_ENV !== 'production') {
      const { pluginDir } = this.getPluginPaths();
      this.devWatcher = new PluginDevWatcher(pluginDir, async (pluginName) => {
        if (this.loadedPlugins.has(pluginName)) {
          await this.reloadPlugin(pluginName);
        } else {
          await this.rescanPlugins();
        }
      });
      void this.devWatcher.start();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping plugin manager');
    this.devWatcher?.stop();
    this.devWatcher = null;
    await this.teardownAllInstances();
    this.eventEmitter.off('pluginLog', this.recordPluginLogHistory);
    this.unregisterEngineListeners();
    this.running = false;
    logger.info('Plugin manager stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===== 操作员实例管理 =====

  async initInstancesForOperator(operatorId: string): Promise<void> {
    this.orchestrator.initDecisionState(operatorId);

    if (!this.instances.has(operatorId)) {
      this.instances.set(operatorId, new Map());
    }
    const operatorInstances = this.instances.get(operatorId)!;

    for (const [pluginName, plugin] of this.loadedPlugins) {
      if ((plugin.definition.instanceScope ?? 'operator') === 'global') {
        continue;
      }
      if (operatorInstances.has(pluginName)) continue;

      const configEntry = this.pluginsConfig.configs?.[pluginName];
      const enabled = this.resolveInstanceEnabled(pluginName, plugin, configEntry);

      const pluginStorageDir = path.join(this.getPluginPaths().pluginDataDir, pluginName);
      const instance: PluginInstance = {
        plugin,
        scope: { kind: 'operator', operatorId },
        ctx: null as unknown as RuntimePluginContext, // 先占位，下面赋值
        rawCtx: null as unknown as RuntimePluginContext,
        runtime: undefined,
        generation: ++this.nextInstanceGeneration,
        lifecycle: 'inactive',
        lifecycleTail: Promise.resolve(),
        desiredLifecycle: 'inactive',
        lifecycleRevision: 0,
        enabled,
        errorCounts: new Map(),
        autoDisabled: false,
      };

      const ctx = await this.contextFactory.create(
        plugin,
        operatorId,
        'operator',
        pluginStorageDir,
        (timerId) => {
          if (instance.ctx && instance.lifecycle === 'active' && !this.isInstancePaused(instance)) {
            void this.dispatcher.dispatchInstance(
              instance,
              'onTimer',
              (hook, guardedCtx) => hook(timerId, guardedCtx),
            );
          }
        },
        () => this.buildMergedSettings(plugin, pluginName, operatorId),
        async (patch) => {
          const settingsNamespace = this.getOperatorSettingsNamespace(pluginName);
          const currentSettings = this.pluginsConfig.operatorSettings?.[operatorId]?.[settingsNamespace] ?? {};
          const mergedSettings = { ...currentSettings, ...patch };
          this.setOperatorPluginSettings(operatorId, pluginName, mergedSettings);
          await ConfigManager.getInstance().setOperatorPluginSettings(operatorId, settingsNamespace, mergedSettings);
        },
        (operation, callback) => {
          if (!instance.enabled
              || instance.autoDisabled
              || instance.desiredLifecycle !== 'active'
              || (instance.lifecycle !== 'active' && instance.lifecycle !== 'starting')) {
            return Promise.reject(new Error('PLUGIN_INVOCATION_EXPIRED: plugin instance is not active'));
          }
          return this.invocationGuard.invoke(instance, operation, callback);
        },
      );
      instance.rawCtx = ctx;
      instance.ctx = this.invocationGuard.wrapContext(ctx, instance);
      if (plugin.definition.type === 'strategy') {
        try {
          const runtime = this.invocationGuard.invokeSync(
            instance,
            'createStrategyRuntime',
            () => {
              const candidate = plugin.definition.createStrategyRuntime?.(
                this.createStrategyPluginContext(instance),
              );
              this.assertStrategyRuntimeV2(pluginName, candidate);
              return candidate;
            },
          );
          instance.runtime = runtime;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          instance.enabled = false;
          instance.autoDisabled = true;
          instance.lastError = message;
          logger.error(`Strategy runtime rejected: plugin=${pluginName}, operator=${operatorId}`, error);
          this.emitPluginRuntimeLog({
            stage: 'validate',
            level: 'error',
            message: `PLUGIN_API_INCOMPATIBLE: ${message}`,
            pluginName,
            details: { operatorId },
          });
        }
      }
      operatorInstances.set(pluginName, instance);

      // 调用 onLoad（仅 enabled 的插件）
      if (instance.enabled && !instance.autoDisabled) {
        await this.activateInstance(operatorId, instance);
      } else {
        instance.lifecycle = 'inactive';
      }
    }
  }

  private async initGlobalInstances(): Promise<void> {
    for (const [pluginName, plugin] of this.loadedPlugins) {
      if ((plugin.definition.instanceScope ?? 'operator') !== 'global') {
        continue;
      }
      if (this.globalInstances.has(pluginName)) {
        continue;
      }

      const configEntry = this.pluginsConfig.configs?.[pluginName];
      const enabled = this.resolveInstanceEnabled(pluginName, plugin, configEntry);
      const pluginStorageDir = path.join(this.getPluginPaths().pluginDataDir, pluginName);
      const instance: PluginInstance = {
        plugin,
        scope: { kind: 'global' },
        ctx: null as unknown as RuntimePluginContext,
        rawCtx: null as unknown as RuntimePluginContext,
        runtime: undefined,
        generation: ++this.nextInstanceGeneration,
        lifecycle: 'inactive',
        lifecycleTail: Promise.resolve(),
        desiredLifecycle: 'inactive',
        lifecycleRevision: 0,
        enabled,
        errorCounts: new Map(),
        autoDisabled: false,
      };

      const ctx = await this.contextFactory.create(
        plugin,
        undefined,
        'global',
        pluginStorageDir,
        (timerId) => {
          if (instance.ctx && instance.lifecycle === 'active' && !this.isInstancePaused(instance)) {
            void this.dispatcher.dispatchInstance(
              instance,
              'onTimer',
              (hook, guardedCtx) => hook(timerId, guardedCtx),
            );
          }
        },
        () => this.buildMergedSettings(plugin, pluginName, GLOBAL_PLUGIN_SCOPE_ID),
        async (patch) => {
          const currentConfig = this.pluginsConfig.configs?.[pluginName] ?? { enabled: true, settings: {} };
          const currentSettings = currentConfig.settings ?? {};
          const mergedSettings = { ...currentSettings, ...patch };
          const mergedConfig = { ...currentConfig, settings: mergedSettings };
          if (!this.pluginsConfig.configs) this.pluginsConfig.configs = {};
          this.pluginsConfig.configs[pluginName] = mergedConfig;
          const globalInstance = this.globalInstances.get(pluginName);
          if (globalInstance?.enabled) {
            void this.dispatcher.dispatchInstance(
              globalInstance,
              'onConfigChange',
              (hook, guardedCtx) => hook(
                snapshotPluginData(mergedSettings, 'structured'),
                guardedCtx,
              ),
            );
          }
          this.bumpGeneration();
          this.broadcastStatusChanged(pluginName);
          await ConfigManager.getInstance().setPluginConfig(pluginName, mergedConfig);
        },
        (operation, callback) => {
          if (!instance.enabled
              || instance.autoDisabled
              || instance.desiredLifecycle !== 'active'
              || (instance.lifecycle !== 'active' && instance.lifecycle !== 'starting')) {
            return Promise.reject(new Error('PLUGIN_INVOCATION_EXPIRED: plugin instance is not active'));
          }
          return this.invocationGuard.invoke(instance, operation, callback);
        },
      );
      instance.rawCtx = ctx;
      instance.ctx = this.invocationGuard.wrapContext(ctx, instance);
      this.globalInstances.set(pluginName, instance);

      if (instance.enabled && !instance.autoDisabled) {
        await this.activateInstance(GLOBAL_PLUGIN_SCOPE_ID, instance);
      } else {
        instance.lifecycle = 'inactive';
      }
    }
  }

  removeInstancesForOperator(operatorId: string): void {
    this.suspendedQueueExecutions.delete(operatorId);
    this.queueMutationTails.delete(operatorId);
    const operatorInstances = this.instances.get(operatorId);
    if (!operatorInstances) {
      return;
    }

    for (const instance of operatorInstances.values()) {
      void this.deactivateInstance(operatorId, instance, true);
    }
    this.instances.delete(operatorId);
    this.orchestrator.removeDecisionState(operatorId);
  }

  // ===== Hook 分发 =====

  getHookDispatcher(): PluginHookDispatcher {
    return this.dispatcher;
  }

  getStrategyInstanceForOperator(operatorId: string): import('./types.js').PluginInstance | undefined {
    return this.getStrategyInstance(operatorId);
  }

  getCtxForInstance(instance: PluginInstance): RuntimePluginContext {
    return instance.ctx;
  }

  private createStrategyPluginContext(instance: PluginInstance): StrategyPluginContext {
    const ctx = instance.ctx;
    const declaredScopes = new Set(instance.plugin.definition.storage?.scopes ?? []);
    const readonlyStore = (scope: 'global' | 'operator') => Object.freeze({
      get<T>(key: string, fallback?: T): T {
        if (!declaredScopes.has(scope)) return fallback as T;
        return ctx.store[scope].get<T>(key, fallback);
      },
      has(key: string): boolean {
        return declaredScopes.has(scope)
          && Object.prototype.hasOwnProperty.call(ctx.store[scope].getAll(), key);
      },
      keys(): string[] {
        return declaredScopes.has(scope) ? Object.keys(ctx.store[scope].getAll()) : [];
      },
    });
    return Object.freeze({
      get config() {
        return ctx.config;
      },
      log: ctx.log,
      operator: ctx.operator,
      radio: ctx.radio,
      store: Object.freeze({
        global: readonlyStore('global'),
        operator: readonlyStore('operator'),
      }),
      digitalMessagePreflight: ctx.digitalMessagePreflight,
    });
  }

  getOperatorRuntimeStatus(operatorId: string): Partial<StrategyRuntimeSnapshot> & {
    strategyName: string;
    currentSlot: string;
  } {
    const strategyName = this.getResolvedStrategyName(operatorId);
    const snapshot = this.getOperatorAutomationSnapshot(operatorId);
    if (!snapshot) {
      return { strategyName, currentSlot: 'TX6' };
    }

    try {
      return {
        ...snapshot,
        strategyName,
        currentSlot: typeof snapshot.currentState === 'string' ? snapshot.currentState : 'TX6',
      };
    } catch (err) {
      logger.error(`Failed to read strategy status: operator=${operatorId}`, err);
      return { strategyName, currentSlot: 'TX6' };
    }
  }

  getOperatorAutomationSnapshot(operatorId: string): StrategyRuntimeSnapshot | null {
    try {
      return this.invokeStrategyRuntimeSync(
        operatorId,
        'getSnapshot',
        (runtime) => runtime.getSnapshot(),
      ) ?? null;
    } catch (err) {
      logger.error(`Failed to read strategy snapshot: operator=${operatorId}`, err);
      return null;
    }
  }

  getOperatorTransmitGate(operatorId: string): StrategyRuntimeSnapshot['transmitGate'] | undefined {
    return this.getOperatorAutomationSnapshot(operatorId)?.transmitGate;
  }

  hasTargetQueue(operatorId: string): boolean {
    return this.getStrategyInstance(operatorId)?.plugin.definition.strategyFeatures?.targetQueue === 1;
  }

  observeStrategyMessages(
    operatorId: string,
    messages: import('@tx5dr/contracts').ParsedFT8Message[],
    slotInfo: SlotInfo,
    source: import('@tx5dr/plugin-api').StrategyDecisionSource,
    token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
    signal: AbortSignal,
  ): boolean {
    if (!this.hasTargetQueue(operatorId) || signal.aborted || !this.intentCoordinator.isCurrent(token)) return false;
    const checkpoint = this.invokeStrategyRuntimeSync(
      operatorId,
      'checkpoint:queue-observation',
      (runtime) => runtime.checkpoint(),
    );
    const changed = this.invokeStrategyRuntimeSync(operatorId, `observe:${source}`, (runtime) => (
      isQueuedStrategyRuntime(runtime)
        ? runtime.observeDecodedMessages(
          snapshotPluginData(messages, 'structured'),
          {
            slotInfo: snapshotPluginData(slotInfo, 'structured'),
            source,
            signal,
          },
        )
        : false
    )) ?? false;
    if (signal.aborted || !this.intentCoordinator.isCurrent(token)) {
      if (checkpoint !== undefined) {
        this.invokeStrategyRuntimeSync(
          operatorId,
          'restore:superseded-queue-observation',
          (runtime) => {
            runtime.restore(snapshotPluginData(checkpoint, 'structured'));
          },
        );
      }
      return false;
    }
    if (changed) this.deps.notifyOperatorStatusChanged?.(operatorId);
    return changed;
  }

  async enqueueQueueTarget(
    operatorId: string,
    request: QueuedStrategyTargetRequest,
    options?: { startIfIdle?: boolean },
  ): Promise<QueuedStrategyMutationResult> {
    const queueActivation = this.getStrategyInstance(operatorId)
      ?.plugin.definition.strategyFeatures?.queueActivation ?? 'immediate';
    return this.submitQueueMutation(
      operatorId,
      'enqueue',
      (runtime) => runtime.enqueueTarget(snapshotPluginData(request, 'structured')),
      async ({ beforeSnapshot, result, token, signal }) => {
        if (queueActivation !== 'immediate'
            || options?.startIfIdle !== true
            || beforeSnapshot.rows.length !== 0
            || result.outcome !== 'accepted') {
          return;
        }
        const operator = this.deps.getOperatorById(operatorId);
        if (!operator || operator.isTransmitting) return;

        operator.start();
        if (!operator.isTransmitting) return;
        const decision = await this.orchestrator.revalidateQueueExecutionInLane(
          operatorId,
          token,
          signal,
        );
        if (!decision || request.lastMessage || signal.aborted || !this.intentCoordinator.isCurrent(token)) return;
        this.deps.triggerReEncode?.(operatorId, {
          source: 'operator-edit',
          reason: 'manual first queue target started assisted operation',
          decisionEpoch: token.epoch,
        });
      },
    );
  }

  async reorderQueueTarget(
    operatorId: string,
    entryId: string,
    beforeEntryId: string | null,
    expectedVersion: number,
  ): Promise<QueuedStrategyMutationResult> {
    return this.submitQueueMutation(operatorId, 'reorder', (runtime) => (
      runtime.reorderTarget(entryId, beforeEntryId, expectedVersion)
    ));
  }

  async retryQueueTarget(
    operatorId: string,
    entryId: string,
    expectedVersion: number,
  ): Promise<QueuedStrategyMutationResult> {
    return this.submitQueueMutation(
      operatorId,
      'retry',
      (runtime) => {
        if (!runtime.retryTarget) throw new Error('strategy_queue_retry_unsupported');
        return runtime.retryTarget(entryId, expectedVersion);
      },
      async ({ beforeSnapshot, result, token, signal }) => {
        const operator = this.deps.getOperatorById(operatorId);
        const activeEntryCount = this.getActiveQueueEntryIds(beforeSnapshot).length;
        const maxActiveStreams = beforeSnapshot.maxActiveStreams ?? 1;
        if (result.outcome !== 'accepted'
            || activeEntryCount >= maxActiveStreams
            || !operator?.isTransmitting) {
          return;
        }
        const decision = await this.orchestrator.revalidateQueueExecutionInLane(
          operatorId,
          token,
          signal,
        );
        const hasTransmission = Boolean(decision?.transmission)
          || (decision?.transmissions?.length ?? 0) > 0;
        if (!hasTransmission
            || decision?.requestedTransmitCycle !== undefined
            || signal.aborted
            || !this.intentCoordinator.isCurrent(token)) {
          return;
        }
        this.deps.triggerReEncode?.(operatorId, {
          source: 'operator-edit',
          reason: 'manual assisted queue retry became executable',
          decisionEpoch: token.epoch,
        });
      },
    );
  }

  async removeQueueTarget(
    operatorId: string,
    entryId: string,
    expectedVersion: number,
  ): Promise<QueuedStrategyMutationResult> {
    return this.submitQueueMutation(
      operatorId,
      'remove',
      (runtime) => runtime.removeTarget(entryId, expectedVersion),
      async ({ beforeSnapshot, result, token, signal }) => {
        if (result.outcome !== 'accepted'
            || !this.getActiveQueueEntryIds(beforeSnapshot).includes(entryId)) return;
        await this.refreshQueueTransmissionSet(
          operatorId,
          token,
          signal,
          'active assisted queue target removed by operator',
        );
      },
    );
  }

  async clearQueueTargets(
    operatorId: string,
    expectedVersion: number,
  ): Promise<QueuedStrategyMutationResult> {
    return this.submitQueueMutation(
      operatorId,
      'clear',
      (runtime) => {
        if (!runtime.clearTargets) throw new Error('strategy_queue_clear_unsupported');
        return runtime.clearTargets(expectedVersion);
      },
      async ({ beforeSnapshot, result, token, signal }) => {
        if (result.outcome !== 'accepted'
            || this.getActiveQueueEntryIds(beforeSnapshot).length === 0) return;
        await this.refreshQueueTransmissionSet(
          operatorId,
          token,
          signal,
          'assisted queue cleared by operator',
        );
      },
    );
  }

  private getActiveQueueEntryIds(snapshot: AssistedQueueSnapshot): string[] {
    if (snapshot.activeEntryIds) return snapshot.activeEntryIds;
    return snapshot.activeEntryId ? [snapshot.activeEntryId] : [];
  }

  private async refreshQueueTransmissionSet(
    operatorId: string,
    token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
    signal: AbortSignal,
    reason: string,
  ): Promise<void> {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator?.isTransmitting || signal.aborted || !this.intentCoordinator.isCurrent(token)) return;
    const decision = await this.orchestrator.revalidateQueueExecutionInLane(
      operatorId,
      token,
      signal,
    );
    if (!decision || decision.stop || signal.aborted || !this.intentCoordinator.isCurrent(token)) return;
    this.deps.triggerReEncode?.(operatorId, {
      source: 'operator-edit',
      reason,
      decisionEpoch: token.epoch,
    });
  }

  private async submitQueueMutation(
    operatorId: string,
    operation: string,
    mutate: (runtime: import('@tx5dr/plugin-api').QueuedStrategyRuntime) => QueuedStrategyMutationResult,
    afterMutation?: (context: {
      beforeSnapshot: AssistedQueueSnapshot;
      result: QueuedStrategyMutationResult;
      token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
      signal: AbortSignal;
    }) => void | Promise<void>,
  ): Promise<QueuedStrategyMutationResult> {
    if (!this.hasTargetQueue(operatorId)) throw new Error('strategy_not_queue_capable');
    const previous = this.queueMutationTails.get(operatorId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => (
      this.submitQueueMutationInLane(operatorId, operation, mutate, afterMutation)
    ));
    const tail = task.then(() => undefined, () => undefined);
    this.queueMutationTails.set(operatorId, tail);
    try {
      return await task;
    } finally {
      if (this.queueMutationTails.get(operatorId) === tail) this.queueMutationTails.delete(operatorId);
    }
  }

  private async submitQueueMutationInLane(
    operatorId: string,
    operation: string,
    mutate: (runtime: import('@tx5dr/plugin-api').QueuedStrategyRuntime) => QueuedStrategyMutationResult,
    afterMutation?: (context: {
      beforeSnapshot: AssistedQueueSnapshot;
      result: QueuedStrategyMutationResult;
      token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
      signal: AbortSignal;
    }) => void | Promise<void>,
  ): Promise<QueuedStrategyMutationResult> {
    const outcome = await this.intentCoordinator.submit(operatorId, 'manual', async (token, signal) => {
      const mutation = this.invokeStrategyRuntimeSync(operatorId, `queue:${operation}`, (runtime) => {
        if (!isQueuedStrategyRuntime(runtime)) throw new Error('strategy_not_queue_capable');
        const beforeSnapshot = runtime.getQueueSnapshot();
        const beforeVersion = beforeSnapshot.version;
        const result = mutate(runtime);
        return { beforeSnapshot, beforeVersion, result };
      });
      if (!mutation) throw new Error('strategy_not_queue_capable');
      const { beforeSnapshot, beforeVersion, result } = mutation;
      if (result.snapshot.version !== beforeVersion) {
        this.orchestrator.invalidateDecisionMessageSet(operatorId);
      }
      await afterMutation?.({ beforeSnapshot, result, token, signal });
      if (result.snapshot.version !== beforeVersion || result.reason === 'version_conflict') {
        this.deps.notifyOperatorStatusChanged?.(operatorId);
      }
      return result;
    });
    if (outcome.status === 'completed') return outcome.value;
    throw new Error('queue_command_superseded');
  }

  patchOperatorRuntimeContext(
    operatorId: string,
    patch: Partial<StrategyRuntimeContext>,
  ): void {
    this.invokeStrategyRuntimeSync(
      operatorId,
      'patchContext',
      (runtime) => {
        runtime.patchContext(snapshotPluginData(patch, 'structured'));
      },
    );
  }

  setOperatorRuntimeState(operatorId: string, state: StrategyRuntimeSlot): void {
    let beforeState: string = 'unknown';
    let beforeTargetCallsign: string | undefined;
    try {
      const snapshot = this.invokeStrategyRuntimeSync(
        operatorId,
        'getSnapshot:before-set-state',
        (runtime) => runtime.getSnapshot(),
      );
      if (!snapshot) return;
      beforeState = snapshot.currentState;
      beforeTargetCallsign = snapshot.context?.targetCallsign;
    } catch {
      // snapshot may not be available for all runtime implementations
    }
    logger.info('PluginManager.setOperatorRuntimeState applied', {
      operatorId,
      before: beforeState,
      after: state,
      beforeTargetCallsign: beforeTargetCallsign ?? null,
    });
    this.invokeStrategyRuntimeSync(operatorId, 'setState', (runtime) => {
      runtime.setState(state);
    });
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    this.eventEmitter.emit('operatorSlotChanged', { operatorId, slot: state });
  }

  setOperatorStreamState(operatorId: string, update: StrategyStreamStateUpdate): void {
    const before = this.getOperatorAutomationSnapshot(operatorId)?.streams
      ?.find((stream) => stream.streamId === update.streamId);
    this.invokeStrategyRuntimeSync(operatorId, 'setStreamState', (runtime) => {
      if (!runtime.setStreamState) throw new Error('stream_state_control_not_supported');
      runtime.setStreamState(update);
    });
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    logger.info('PluginManager.setOperatorStreamState applied', {
      operatorId,
      streamId: update.streamId,
      before: before?.currentState ?? null,
      after: update.stateId,
      lifecycleEpoch: update.expectedLifecycleEpoch,
    });
    this.eventEmitter.emit('operatorStreamStateChanged', {
      operatorId,
      streamId: update.streamId,
      state: update.stateId,
    });
  }

  async invokeOperatorStrategyAction(
    operatorId: string,
    invocation: StrategyActionInvocation,
  ): Promise<import('@tx5dr/plugin-api').StrategyActionResult | void> {
    const snapshot = this.getOperatorAutomationSnapshot(operatorId);
    const action = this.findStrategyAction(snapshot, invocation);
    if (!action) throw new Error('strategy_action_not_available');
    if (action.disabledReason) throw new Error('strategy_action_disabled');

    const checkpoint = this.invokeStrategyRuntimeSync(
      operatorId,
      'checkpoint:before-strategy-action',
      (runtime) => runtime.checkpoint(),
    );
    try {
      const result = await this.invokeStrategyRuntime(
        operatorId,
        `strategy-action:${invocation.actionId}`,
        async (runtime) => {
          if (!runtime.invokeAction) throw new Error('strategy_action_not_supported');
          return runtime.invokeAction(snapshotPluginData(invocation, 'structured'));
        },
      );
      if (result?.qsoCompletions?.length) {
        this.orchestrator.commitQSOCompletionEffectsFromAction(operatorId, result.qsoCompletions);
      }
      if (result?.requestOperatorStart) {
        await this.deps.requestOperatorStrategyStart?.(
          operatorId,
          `strategy action ${invocation.actionId}`,
        );
      }
      if (result?.requestDecision) {
        this.orchestrator.invalidateDecisionMessageSet(operatorId);
        this.deps.triggerReEncode?.(operatorId, {
          source: 'operator-edit',
          reason: `strategy action ${invocation.actionId}`,
        });
      }
      this.deps.notifyOperatorStatusChanged?.(operatorId);
      logger.info('PluginManager strategy action applied', {
        operatorId,
        actionId: invocation.actionId,
        targetKind: invocation.target.kind,
      });
      return result;
    } catch (error) {
      if (checkpoint !== undefined) {
        this.invokeStrategyRuntimeSync(operatorId, 'restore:failed-strategy-action', (runtime) => {
          runtime.restore(checkpoint);
        });
      }
      throw error;
    }
  }

  private findStrategyAction(
    snapshot: StrategyRuntimeSnapshot | null,
    invocation: StrategyActionInvocation,
  ): StrategyActionDescriptor | undefined {
    if (!snapshot) return undefined;
    const target = invocation.target;
    if (target.kind === 'runtime') {
      return snapshot.actions?.find((action) => action.id === invocation.actionId);
    }
    if (target.kind === 'stream') {
      const stream = snapshot.streams?.find((candidate) => candidate.streamId === target.streamId);
      if (!stream || stream.qsoLifecycleEpoch !== target.lifecycleEpoch) {
        throw new Error('stream_lifecycle_conflict');
      }
      return stream.actions?.find((action) => action.id === invocation.actionId);
    }
    if (snapshot.queue?.version !== target.queueVersion) {
      throw new Error('queue_version_conflict');
    }
    return snapshot.queue.rows
      .find((row) => row.entryId === target.entryId)
      ?.actions?.find((action) => action.id === invocation.actionId);
  }

  setOperatorRuntimeSlotContent(
    operatorId: string,
    slot: StrategyRuntimeSlot,
    content: string,
  ): Record<string, unknown> | undefined {
    if (!this.getStrategyRuntime(operatorId)) return undefined;
    const activeStrategy = this.pluginsConfig.operatorStrategies?.[operatorId] ?? BUILTIN_STANDARD_QSO_PLUGIN_NAME;
    let persistedSettings: Record<string, unknown> | undefined;
    if (activeStrategy === BUILTIN_STANDARD_QSO_PLUGIN_NAME && slot === 'TX6') {
      persistedSettings = this.updateStandardQSOTx6OverrideSetting(operatorId, content);
    }
    this.invokeStrategyRuntimeSync(
      operatorId,
      'setSlotContent',
      (runtime) => {
        runtime.setSlotContent({ slot, content });
      },
    );
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    this.eventEmitter.emit('operatorSlotContentChanged', { operatorId, slot, content });
    return persistedSettings;
  }

  getCurrentTransmission(operatorId: string): string | null {
    return this.orchestrator.readCurrentTransmission(operatorId);
  }

  getCurrentTransmissions(operatorId: string): import('@tx5dr/plugin-api').StrategyTransmission[] {
    return this.orchestrator.readCurrentTransmissions(operatorId);
  }

  handlePluginUserAction(
    pluginName: string,
    actionId: string,
    operatorId?: string,
    payload?: unknown,
  ): void {
    const instance = this.resolvePluginActionTarget(pluginName, operatorId);
    if (!instance?.enabled) {
      throw new Error(`Plugin action target not available: plugin=${pluginName}${operatorId ? `, operator=${operatorId}` : ''}`);
    }
    if (this.isInstancePaused(instance)) {
      const pausedOperatorId = instance.scope.kind === 'operator' ? instance.scope.operatorId : operatorId;
      throw new Error(`Plugin action is paused for operator: plugin=${pluginName}${pausedOperatorId ? `, operator=${pausedOperatorId}` : ''}`);
    }

    void this.dispatcher.dispatchInstance(
      instance,
      'onUserAction',
      (hook, guardedCtx) => hook(
        actionId,
        snapshotPluginData(payload, 'structured'),
        guardedCtx,
      ),
    );
  }

  requestCall(
    operatorId: string,
    callsign: string,
    lastMessage?: { message: FrameMessage; slotInfo: SlotInfo },
    options?: {
      submitCurrentFrame?: boolean;
      source?: 'operator-edit' | 'plugin';
      reason?: string;
      commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
    },
  ): void {
    if (this.hasTargetQueue(operatorId)) {
      logger.debug('Ignoring direct requestCall while a target-queue strategy is active', { operatorId, callsign });
      return;
    }
    // 呼叫收敛点：autocall / WS 命令 / ctx.operator.call / replyToDecode 全部汇入此处，
    // 未解码占位符呼号（`<...>`/`...`）一律拒绝，避免向占位符发起呼叫。
    if (isUndecodedCallsignPlaceholder(callsign)) {
      logger.warn('Refusing requestCall with undecoded placeholder callsign', { operatorId, callsign });
      return;
    }
    const apply = (token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken) => {
      if (!this.intentCoordinator.isCurrent(token)) return;
      this.applyRequestCall(operatorId, callsign, lastMessage, options, token);
    };
    if (options?.commandToken) {
      apply(options.commandToken);
      return;
    }
    const source = options?.source === 'plugin' ? 'plugin' : 'manual';
    void this.intentCoordinator.submit(operatorId, source, (token, signal) => {
      if (!signal.aborted) apply(token);
    }).catch((error) => {
      logger.warn('Operator requestCall command failed', {
        operatorId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async submitPluginOperatorCommand(
    instance: PluginInstance,
    operatorId: string,
    command: PluginOperatorCommand,
  ): Promise<PluginOperatorCommandResult> {
    const invocation = this.invocationGuard.captureCurrent(instance);
    const isInvocationCurrent = () => (
      !invocation.signal.aborted
      && instance.generation === invocation.instanceGeneration
      && instance.lifecycle === 'active'
      && this.instances.get(operatorId)?.get(instance.plugin.definition.name) === instance
    );
    const outcome = await this.intentCoordinator.submit(
      operatorId,
      'plugin',
      async (token, signal) => {
        if (signal.aborted || !this.intentCoordinator.isCurrent(token) || !isInvocationCurrent()) return;
        const operator = this.deps.getOperatorById(operatorId);
        if (!operator) throw new Error(`Operator not found: ${operatorId}`);

        const manualInitiation = this.getStrategyInstance(operatorId)
          ?.plugin.definition.strategyFeatures?.manualInitiation === 1;
        if (manualInitiation && (
          command.type === 'start-automation'
          || command.type === 'request-call'
          || command.type === 'reply-to-decode'
          || command.type === 'send-free-text'
        )) {
          throw new Error(`manual_initiation_required:${command.type}`);
        }

        switch (command.type) {
          case 'start-automation':
            operator.start();
            break;
          case 'stop-automation':
            operator.stop();
            this.deps.requestOperatorStrategyStop?.(operatorId, 'plugin automation stop');
            break;
          case 'request-call':
            this.applyRequestCall(operatorId, command.callsign, command.lastMessage, {
              source: 'plugin',
            }, token);
            break;
          case 'reply-to-decode':
            this.eventEmitter.emit('pluginRemoteReplyToDecode', {
              operatorId,
              callsign: command.callsign,
              modifiers: command.modifiers,
            });
            this.applyRequestCall(operatorId, command.callsign, command.lastMessage, {
              source: 'plugin',
            }, token);
            break;
          case 'set-transmit-cycles':
            operator.setTransmitCycles(command.cycles, {
              commandEpoch: token.epoch,
              source: 'plugin',
              reason: `plugin ${instance.plugin.definition.name} changed transmit cycles`,
            });
            break;
          case 'remove-contribution':
            operator.stop();
            this.deps.releaseTargetReservation?.(operatorId);
            if (!this.deps.removeOperatorContribution) {
              throw new Error('Host participant-removal coordinator is unavailable');
            }
            await this.deps.removeOperatorContribution(operatorId, {
              signal: AbortSignal.any([signal, invocation.signal]),
              commandToken: token,
            });
            break;
          case 'clear-decodes':
            this.eventEmitter.emit('pluginRemoteClearDecodes', { operatorId, window: command.window });
            break;
          case 'set-free-text':
            this.eventEmitter.emit('pluginRemoteFreeText', { operatorId, text: command.text, send: false });
            break;
          case 'send-free-text':
            this.eventEmitter.emit('pluginRemoteFreeText', { operatorId, text: command.text, send: true });
            if (command.text?.trim()) {
              this.eventEmitter.emit('requestTransmit', {
                operatorId,
                transmission: command.text,
                decisionEpoch: token.epoch,
              });
            }
            break;
          case 'set-temporary-location':
            this.eventEmitter.emit('pluginRemoteLocation', { operatorId, location: command.location });
            break;
          case 'highlight-callsign':
            this.eventEmitter.emit('pluginRemoteHighlightCallsign', {
              operatorId,
              callsign: command.callsign,
              background: command.background,
              foreground: command.foreground,
              lastOnly: command.lastOnly,
            });
            break;
        }
        if (signal.aborted || !this.intentCoordinator.isCurrent(token) || !isInvocationCurrent()) {
          return;
        }
      },
    );
    return {
      epoch: outcome.token.epoch,
      outcome: outcome.status,
    };
  }

  private applyRequestCall(
    operatorId: string,
    callsign: string,
    lastMessage: { message: FrameMessage; slotInfo: SlotInfo } | undefined,
    options: {
      submitCurrentFrame?: boolean;
      source?: 'operator-edit' | 'plugin';
      reason?: string;
    } | undefined,
    token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
  ): void {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator || !this.getStrategyRuntime(operatorId)) return;

    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    const checkpoint = this.invokeStrategyRuntimeSync(
      operatorId,
      'checkpoint:request-call',
      (runtime) => runtime.checkpoint(),
    );
    const accepted = this.invokeStrategyRuntimeSync(
      operatorId,
      'requestCall',
      (runtime) => runtime.requestCall(
        callsign,
        lastMessage ? snapshotPluginData(lastMessage, 'structured') : undefined,
      ),
    );
    if (accepted === false) {
      logger.warn('Strategy rejected requestCall without starting the operator', { operatorId, callsign });
      return;
    }
    const nextSnapshot = this.invokeStrategyRuntimeSync(
      operatorId,
      'getSnapshot:request-call',
      (runtime) => runtime.getSnapshot(),
    );
    const nextTarget = nextSnapshot?.context?.targetCallsign;
    if (this.deps.transitionTargetReservation
        && !this.deps.transitionTargetReservation(operatorId, token.epoch, nextTarget)) {
      if (checkpoint !== undefined) {
        this.invokeStrategyRuntimeSync(
          operatorId,
          'restore:request-call-target-conflict',
          (runtime) => {
            runtime.restore(snapshotPluginData(checkpoint, 'structured'));
          },
        );
      }
      logger.warn('Manual/plugin requestCall target is reserved by another same-station operator', {
        operatorId,
        callsign,
        epoch: token.epoch,
      });
      return;
    }
    if (nextSnapshot?.qsoLifecycleEpoch !== undefined) {
      this.eventEmitter.emit('qsoLifecycleChanged', {
        operatorId,
        lifecycleEpoch: nextSnapshot.qsoLifecycleEpoch,
        runtimeGeneration: this.getStrategyInstance(operatorId)?.generation,
      });
    }
    operator.start();
    if (lastMessage) {
      operator.setTransmitCycles((lastMessage.slotInfo.cycleNumber + 1) % 2, {
        commandEpoch: token.epoch,
        source: options?.source === 'plugin' ? 'plugin' : 'manual',
        reason: options?.reason ?? 'requestCall selected transmit cycle',
      });
    }
    if (options?.submitCurrentFrame && !lastMessage) {
      // Manual in-slot edits must enter the frame coordinator immediately.
      // A selected frame already causes setTransmitCycles() to emit the
      // authoritative refresh event, so only the no-frame path needs this
      // explicit bridge. Automatic requestCall paths still wait for the normal
      // encode boundary.
      this.deps.triggerReEncode?.(operatorId, {
        source: options.source ?? 'operator-edit',
        reason: options.reason ?? 'requestCall updated operator context',
        decisionEpoch: token.epoch,
      });
    }
  }

  notifyTransmissionQueued(operatorId: string, transmission: string): void {
    this.invokeStrategyRuntimeSync(
      operatorId,
      'onTransmissionQueued',
      (runtime) => {
        runtime.onTransmissionQueued?.(transmission);
      },
    );
  }

  notifyTransmissionsCompleted(
    operatorId: string,
    receipts: import('@tx5dr/plugin-api').StreamPhysicalReceipt[],
  ): void {
    this.invokeStrategyRuntimeSync(
      operatorId,
      'onTransmissionsCompleted',
      (runtime) => {
        if (runtime.onTransmissionsCompleted) {
          runtime.onTransmissionsCompleted(snapshotPluginData(receipts, 'structured'));
          return;
        }
        for (const receipt of receipts) runtime.onTransmissionQueued?.(receipt.text);
      },
    );
  }

  async interruptOperatorTransmission(operatorId: string): Promise<void> {
    await this.deps.interruptOperatorTransmission(operatorId);
  }

  async notifyQSOComplete(operatorId: string, record: QSORecord): Promise<void> {
    await this.dispatcher.dispatchBroadcast(
      operatorId,
      'onQSOComplete',
      (hook, ctx) => hook(snapshotPluginData(record, 'structured'), ctx),
      (instance) => this.getCtxForInstance(instance),
    );
  }

  async notifyQSOFail(operatorId: string, info: QSOFailureInfo): Promise<void> {
    await this.dispatcher.dispatchBroadcast(
      operatorId,
      'onQSOFail',
      (hook, ctx) => hook(snapshotPluginData(info, 'structured'), ctx),
      (instance) => this.getCtxForInstance(instance),
    );
  }

  async reDecideOperator(operatorId: string, slotPack: SlotPack): Promise<boolean> {
    return this.orchestrator.reDecideOperator(operatorId, slotPack);
  }

  suspendQueueExecution(operatorId: string): void {
    if (this.hasTargetQueue(operatorId)) this.suspendedQueueExecutions.add(operatorId);
  }

  isQueueExecutionSuspended(operatorId: string): boolean {
    return this.suspendedQueueExecutions.has(operatorId);
  }

  async resumeQueueExecution(operatorId: string): Promise<boolean> {
    if (!this.hasTargetQueue(operatorId)) return true;
    await this.orchestrator.revalidateQueueExecution(operatorId);
    return !this.suspendedQueueExecutions.has(operatorId);
  }

  shouldProcessStoppedOperatorReDecision(operatorId: string, slotPack: SlotPack): boolean {
    return this.hasTargetQueue(operatorId)
      || this.orchestrator.hasActiveSilentDirectedCallGate(operatorId, slotPack);
  }

  // ===== 策略管理 =====

  getActiveStrategyForOperator(operatorId: string): string {
    return this.pluginsConfig.operatorStrategies?.[operatorId] ?? BUILTIN_STANDARD_QSO_PLUGIN_NAME;
  }

  setOperatorStrategy(operatorId: string, pluginName: string): void {
    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin || plugin.definition.type !== 'strategy') {
      throw new Error(`Invalid strategy plugin: ${pluginName}`);
    }

    const previousStrategy = this.getResolvedStrategyName(operatorId);
    if (previousStrategy === pluginName) return;
    if (!this.pluginsConfig.operatorStrategies) {
      this.pluginsConfig.operatorStrategies = {};
    }
    this.pluginsConfig.operatorStrategies[operatorId] = pluginName;

    const operatorInstances = this.instances.get(operatorId);
    const previousInstance = previousStrategy ? operatorInstances?.get(previousStrategy) : undefined;
    const nextInstance = operatorInstances?.get(pluginName);

    const resetReason = `strategy switched from ${previousStrategy} to ${pluginName}`;
    this.resetStrategyInstanceRuntime(previousInstance, resetReason);
    this.resetStrategyInstanceRuntime(nextInstance, resetReason);

    if (previousInstance && previousInstance !== nextInstance) {
      void this.deactivateInstance(operatorId, previousInstance);
    }
    let activation: Promise<void> | undefined;
    if (nextInstance) {
      nextInstance.enabled = true;
      activation = this.activateInstance(operatorId, nextInstance);
    }
    this.deps.releaseTargetReservation?.(operatorId);
    this.suspendedQueueExecutions.delete(operatorId);
    this.orchestrator.clearDecisionState(operatorId);
    this.deps.resetOperatorRuntime(operatorId, resetReason);
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
    if (previousStrategy && previousStrategy !== pluginName) {
      this.broadcastStatusChanged(previousStrategy);
    }
    this.broadcastPluginList();
    void activation?.then(() => {
      this.deps.notifyOperatorStatusChanged?.(operatorId);
    }).catch((error) => {
      logger.warn('Failed to activate switched operator strategy', {
        operatorId,
        pluginName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ===== 配置 API =====

  loadConfig(config: Partial<PluginsConfig>): void {
    this.pluginsConfig = {
      ...config,
      configs: config.configs ?? {},
      operatorStrategies: config.operatorStrategies ?? {},
      operatorSettings: config.operatorSettings ?? {},
      operatorPluginPauses: config.operatorPluginPauses ?? {},
    };
  }

  getSnapshot(): PluginSystemSnapshot {
    return toPluginSystemSnapshot(
      this.systemState,
      this.getPluginStatuses(),
      this.getPanelMetaSnapshot(),
      this.getPanelContributionSnapshot(),
    );
  }

  getRuntimeLogHistory(limit = 500): PluginLogHistoryEntry[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), PLUGIN_RUNTIME_LOG_HISTORY_LIMIT)
      : 500;
    const startIndex = Math.max(this.pluginRuntimeLogHistory.length - normalizedLimit, 0);
    return this.pluginRuntimeLogHistory
      .slice(startIndex)
      .map((entry) => snapshotPluginData(entry, 'json'));
  }

  private appendPluginLogHistory(entry: PluginLogHistoryEntry): void {
    this.pluginRuntimeLogHistory = [...this.pluginRuntimeLogHistory, entry]
      .slice(-PLUGIN_RUNTIME_LOG_HISTORY_LIMIT);
  }

  setPluginEnabled(name: string, enabled: boolean): void {
    const plugin = this.loadedPlugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`);
    }
    if (plugin.definition.type !== 'utility') {
      throw new Error(`Strategy plugin cannot be enabled or disabled: ${name}`);
    }
    if (!this.pluginsConfig.configs) this.pluginsConfig.configs = {};
    const existing = this.pluginsConfig.configs[name] ?? { enabled: false, settings: {} };
    this.pluginsConfig.configs[name] = { ...existing, enabled };
    const globalInstance = this.globalInstances.get(name);
    if (globalInstance) {
      globalInstance.enabled = enabled;
      if (enabled) {
        void this.activateInstance(GLOBAL_PLUGIN_SCOPE_ID, globalInstance);
      } else {
        void this.deactivateInstance(GLOBAL_PLUGIN_SCOPE_ID, globalInstance);
      }
    }
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(name);
      if (!instance) continue;
      instance.enabled = enabled;
      if (enabled) {
        void this.activateInstance(instance.scope.kind === 'operator' ? instance.scope.operatorId : GLOBAL_PLUGIN_SCOPE_ID, instance);
      } else {
        void this.deactivateInstance(instance.scope.kind === 'operator' ? instance.scope.operatorId : GLOBAL_PLUGIN_SCOPE_ID, instance);
      }
    }
    this.bumpGeneration();
    this.broadcastStatusChanged(name);
  }

  /** 更新 global scope 插件设置 */
  setPluginSettings(name: string, settings: Record<string, unknown>): void {
    if (!this.pluginsConfig.configs) this.pluginsConfig.configs = {};
    const existing = this.pluginsConfig.configs[name] ?? { enabled: false, settings: {} };
    this.pluginsConfig.configs[name] = { ...existing, settings };
    const globalInstance = this.globalInstances.get(name);
    if (globalInstance?.enabled) {
      void this.dispatcher.dispatchInstance(
        globalInstance,
        'onConfigChange',
        (hook, guardedCtx) => hook(snapshotPluginData(settings, 'structured'), guardedCtx),
      );
    }
    // 通知所有操作员实例配置变更（仅 global scope 键）
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(name);
      if (instance?.enabled) {
        void this.dispatcher.dispatchInstance(
          instance,
          'onConfigChange',
          (hook, guardedCtx) => hook(snapshotPluginData(settings, 'structured'), guardedCtx),
        );
      }
    }
    this.bumpGeneration();
    this.broadcastStatusChanged(name);
  }

  /** 获取操作员维度的插件设置 */
  getOperatorPluginSettings(operatorId: string, pluginName: string): Record<string, unknown> {
    const namespace = this.getOperatorSettingsNamespace(pluginName);
    return this.pluginsConfig.operatorSettings?.[operatorId]?.[namespace] ?? {};
  }

  getOperatorPluginSettingsProjection(operatorId: string, pluginName: string): Record<string, unknown> {
    const storedSettings = this.getOperatorPluginSettings(operatorId, pluginName);
    const descriptors = this.loadedPlugins.get(pluginName)?.definition.settings;
    if (!descriptors) return storedSettings;

    return Object.fromEntries(
      Object.entries(descriptors)
        .filter(([, descriptor]) => descriptor.type !== 'info' && !descriptor.hidden)
        .filter(([key]) => key in storedSettings)
        .map(([key]) => [key, storedSettings[key]]),
    );
  }

  getOperatorSettingsNamespace(pluginName: string): string {
    return BUILTIN_PLUGINS.find((builtin) => builtin.definition.name === pluginName)?.settingsNamespace ?? pluginName;
  }

  isOperatorPluginPaused(operatorId: string, pluginName: string): boolean {
    return this.isTransmitControlOperatorPlugin(pluginName)
      && (this.pluginsConfig.operatorPluginPauses?.[operatorId]?.includes(pluginName) ?? false);
  }

  async setOperatorPluginPaused(operatorId: string, pluginName: string, paused: boolean): Promise<string[]> {
    this.assertTransmitControlPauseTarget(operatorId, pluginName);
    const changed = this.setOperatorPluginPausedInMemory(operatorId, pluginName, paused);
    const nextPaused = this.pluginsConfig.operatorPluginPauses?.[operatorId] ?? [];
    await ConfigManager.getInstance().setOperatorPluginPauses(operatorId, nextPaused);
    if (changed.length > 0) {
      this.bumpGeneration();
      this.broadcastStatusChanged(pluginName);
    }
    return nextPaused;
  }

  async pauseActiveTransmitControlPlugins(operatorId: string): Promise<string[]> {
    this.assertOperatorExists(operatorId);
    const pluginNames = this.getTransmitControlPluginNamesForOperator(operatorId)
      .filter((pluginName) => this.getAutoCallEnabledOperatorIds(pluginName)?.includes(operatorId));
    const changed = this.setOperatorPluginPausesInMemory(operatorId, pluginNames, true);
    await ConfigManager.getInstance().setOperatorPluginPauses(
      operatorId,
      this.pluginsConfig.operatorPluginPauses?.[operatorId] ?? [],
    );
    this.bumpGeneration();
    this.broadcastStatusChangedForPluginNames(changed);
    return this.pluginsConfig.operatorPluginPauses?.[operatorId] ?? [];
  }

  async resumeTransmitControlPlugins(operatorId: string): Promise<string[]> {
    this.assertOperatorExists(operatorId);
    const pluginNames = this.getTransmitControlPluginNamesForOperator(operatorId);
    const changed = this.setOperatorPluginPausesInMemory(operatorId, pluginNames, false);
    await ConfigManager.getInstance().setOperatorPluginPauses(
      operatorId,
      this.pluginsConfig.operatorPluginPauses?.[operatorId] ?? [],
    );
    if (changed.length > 0) {
      this.bumpGeneration();
      this.broadcastStatusChangedForPluginNames(changed);
    }
    return this.pluginsConfig.operatorPluginPauses?.[operatorId] ?? [];
  }

  private isSnrPriorityEnabled(operatorId: string): boolean {
    const plugin = this.loadedPlugins.get(BUILTIN_SNR_FILTER_PLUGIN_NAME);
    const instance = this.instances.get(operatorId)?.get(BUILTIN_SNR_FILTER_PLUGIN_NAME);
    if (!plugin || !instance?.enabled) {
      return false;
    }

    const settings = this.buildMergedSettings(plugin, BUILTIN_SNR_FILTER_PLUGIN_NAME, operatorId);
    return settings.prioritizeHigherSNR === true;
  }

  private isStoppedDirectCallAutoReplyEnabled(operatorId: string): boolean {
    const activeStrategy = this.pluginsConfig.operatorStrategies?.[operatorId] ?? BUILTIN_STANDARD_QSO_PLUGIN_NAME;
    if (activeStrategy !== BUILTIN_STANDARD_QSO_PLUGIN_NAME) {
      return false;
    }

    const plugin = this.loadedPlugins.get(BUILTIN_STANDARD_QSO_PLUGIN_NAME);
    const instance = this.instances.get(operatorId)?.get(BUILTIN_STANDARD_QSO_PLUGIN_NAME);
    if (!plugin || !instance?.enabled) {
      return false;
    }

    const settings = this.buildMergedSettings(plugin, BUILTIN_STANDARD_QSO_PLUGIN_NAME, operatorId);
    return settings.autoReplyToDirectCallWhenStopped === true;
  }

  /**
   * Returns the loaded plugin metadata for the given name, or `undefined` if
   * the plugin is not loaded. Exposed for route handlers that need access to
   * the plugin's filesystem directory (e.g. serving static UI files).
   */
  getLoadedPlugin(pluginName: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(pluginName);
  }

  getSimulationScenarios(pluginName: string): import('@tx5dr/plugin-api').SimulationScenarioDescriptor[] {
    const scenarios = this.loadedPlugins.get(pluginName)?.definition.simulationScenarios ?? [];
    return structuredClone(scenarios);
  }

  getPluginStorageDir(pluginName: string): string {
    return path.join(this.getPluginPaths().pluginDataDir, pluginName);
  }

  createPluginPageSession(
    input: Omit<PluginPageSession, 'sessionId' | 'createdAt' | 'expiresAt'>,
  ): PluginPageSession {
    return this.pageSessions.create(input);
  }

  getPluginPageSession(sessionId: string): PluginPageSession | null {
    return this.pageSessions.get(sessionId);
  }

  touchPluginPageSession(sessionId: string): PluginPageSession | null {
    return this.pageSessions.touch(sessionId);
  }

  deletePluginPageSession(sessionId: string): void {
    this.pageSessions.delete(sessionId);
    this.pageSessionPushQueues.delete(sessionId);
  }

  listPluginPageSessions(
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    pageId?: string,
  ): PluginPageSession[] {
    return this.pageSessions.listByPluginInstance(pluginName, instanceTarget, pageId);
  }

  pushPluginPageSession(
    pluginName: string,
    pageId: string,
    pageSessionId: string,
    action: string,
    data?: unknown,
  ): void {
    const session = this.pageSessions.get(pageSessionId);
    if (!session) {
      throw new Error(`Page session not found: ${pageSessionId}`);
    }
    if (session.pluginName !== pluginName || session.pageId !== pageId) {
      throw new Error(`Page session does not belong to ${pluginName}/${pageId}: ${pageSessionId}`);
    }

    const payload = snapshotPluginData({
      pluginName,
      pageId,
      pageSessionId,
      action,
      data,
    }, 'json');

    const queue = this.pageSessionPushQueues.get(pageSessionId) ?? [];
    queue.push(payload);
    if (queue.length > PluginManager.MAX_PAGE_PUSH_QUEUE) {
      queue.splice(0, queue.length - PluginManager.MAX_PAGE_PUSH_QUEUE);
    }
    this.pageSessionPushQueues.set(pageSessionId, queue);

    this.eventEmitter.emit('pluginPagePush', payload);
  }

  pullPluginPageSessionPushes(
    pluginName: string,
    pageId: string,
    pageSessionId: string,
  ): Array<{
    pluginName: string;
    pageId: string;
    pageSessionId: string;
    action: string;
    data?: unknown;
  }> {
    const session = this.pageSessions.get(pageSessionId);
    if (!session) {
      this.pageSessionPushQueues.delete(pageSessionId);
      throw new Error(`Page session not found: ${pageSessionId}`);
    }
    if (session.pluginName !== pluginName || session.pageId !== pageId) {
      throw new Error(`Page session does not belong to ${pluginName}/${pageId}: ${pageSessionId}`);
    }

    const queued = this.pageSessionPushQueues.get(pageSessionId) ?? [];
    this.pageSessionPushQueues.delete(pageSessionId);
    return queued;
  }

  /** Host-side manager for logbook sync providers registered by plugins. */
  get logbookSyncHost(): LogbookSyncHost {
    return this._logbookSyncHost;
  }

  /**
   * Invokes a custom page handler registered by the given plugin. The host
   * routes iframe `bridge.invoke()` calls through this method.
   *
   * Returns the handler's response, or throws if no handler is registered for
   * the exact plugin instance targeted by the page session.
   */
  async invokePluginPageHandler(
    pluginName: string,
    pageId: string,
    action: string,
    data: unknown,
    requestContext: PluginUIRequestContext,
  ): Promise<unknown> {
    const instance = requestContext.instanceTarget.kind === 'global'
      ? this.globalInstances.get(pluginName)
      : this.instances.get(requestContext.instanceTarget.operatorId)?.get(pluginName);

    if (!instance || instance.lifecycle !== 'active') {
      throw new Error(`Plugin instance not found: ${pluginName}`);
    }

    const bridge = instance.rawCtx.ui as import('./PluginUIBridge.js').PluginUIBridge;
    if (bridge.hasPageHandler()) {
      return this.invocationGuard.invokeData(
        instance,
        'ui:onMessage',
        'json',
        () => bridge.handlePageInvoke(
          pageId,
          action,
          snapshotPluginData(data, 'json'),
          this.createInvocationScopedPageContext(instance, requestContext),
        ),
      );
    }

    throw new Error(`No page handler registered for plugin: ${pluginName}`);
  }

  private createInvocationScopedPageContext(
    instance: PluginInstance,
    requestContext: PluginUIRequestContext,
  ): PluginUIRequestContext {
    const invocation = this.invocationGuard.captureCurrent(instance);
    const assertCurrent = () => this.invocationGuard.assertCaptured(instance, invocation);
    const files = requestContext.files;
    const page = requestContext.page;
    const scopedFiles = markPluginCapabilityTree(Object.freeze({
      async write(filePath: string, contents: Buffer) {
        assertCurrent();
        return files.write(filePath, contents);
      },
      async read(filePath: string) {
        assertCurrent();
        return files.read(filePath);
      },
      async delete(filePath: string) {
        assertCurrent();
        return files.delete(filePath);
      },
      async list(prefix?: string) {
        assertCurrent();
        return files.list(prefix);
      },
    }));
    const scopedPage = markPluginCapabilityTree(Object.freeze({
      sessionId: page.sessionId,
      pageId: page.pageId,
      resource: page.resource ? Object.freeze({ ...page.resource }) : undefined,
      push(action: string, payload?: unknown) {
        assertCurrent();
        page.push(action, payload);
      },
    }));

    return Object.freeze({
      pageSessionId: requestContext.pageSessionId,
      user: Object.freeze({
        ...requestContext.user,
        operatorIds: [...requestContext.user.operatorIds],
        permissionGrants: requestContext.user.permissionGrants
          ? structuredClone(requestContext.user.permissionGrants)
          : undefined,
      }),
      resource: requestContext.resource ? Object.freeze({ ...requestContext.resource }) : undefined,
      instanceTarget: Object.freeze({ ...requestContext.instanceTarget }),
      files: scopedFiles,
      page: scopedPage,
    });
  }

  /** 更新 operator scope 插件设置，并通知相关实例 */
  setOperatorPluginSettings(
    operatorId: string,
    pluginName: string,
    settings: Record<string, unknown>,
  ): Record<string, unknown> {
    const settingsNamespace = this.getOperatorSettingsNamespace(pluginName);
    const mergedSettings = this.mergePreservedHiddenOperatorSettings(operatorId, pluginName, settings);
    if (!this.pluginsConfig.operatorSettings) this.pluginsConfig.operatorSettings = {};
    if (!this.pluginsConfig.operatorSettings[operatorId]) {
      this.pluginsConfig.operatorSettings[operatorId] = {};
    }
    this.pluginsConfig.operatorSettings[operatorId][settingsNamespace] = mergedSettings;

    // Notify every built-in strategy sharing the canonical settings namespace.
    for (const [instanceName, instance] of this.instances.get(operatorId) ?? []) {
      if (!instance.enabled || this.getOperatorSettingsNamespace(instanceName) !== settingsNamespace) continue;
      void this.dispatcher.dispatchInstance(instance, 'onConfigChange', (hook, guardedCtx) => (
        hook(snapshotPluginData(mergedSettings, 'structured'), guardedCtx)
      ));
    }
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
    this.deps.notifyOperatorStatusChanged?.(operatorId);
    return mergedSettings;
  }

  getEffectiveOperatorMaxConcurrentStreams(operatorId: string): number {
    const configured = this.deps.getOperatorById(operatorId)?.config.maxConcurrentStreams ?? 3;
    const standardFrequency = getStandardDigitalFrequencyMatch(
      this.deps.getCurrentMode().name,
      this.deps.getKnownRadioFrequency?.() ?? null,
    );
    return standardFrequency ? 1 : configured;
  }

  private mergePreservedHiddenOperatorSettings(
    operatorId: string,
    pluginName: string,
    settings: Record<string, unknown>,
  ): Record<string, unknown> {
    const plugin = this.loadedPlugins.get(pluginName);
    const settingsNamespace = this.getOperatorSettingsNamespace(pluginName);
    const existing = this.pluginsConfig.operatorSettings?.[operatorId]?.[settingsNamespace] ?? {};
    const merged = { ...settings };
    const declaredSettings = plugin?.definition.settings ?? {};
    if (settingsNamespace !== pluginName) {
      for (const [key, value] of Object.entries(existing)) {
        if (!(key in declaredSettings) && !(key in merged)) {
          merged[key] = value;
        }
      }
    }
    for (const [key, descriptor] of Object.entries(declaredSettings)) {
      if (!descriptor.hidden || key in merged || !(key in existing)) {
        continue;
      }
      merged[key] = existing[key];
    }
    return merged;
  }

  private updateStandardQSOTx6OverrideSetting(
    operatorId: string,
    content: string,
  ): Record<string, unknown> | undefined {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return undefined;
    }
    const defaultMessage = buildStandardQSODefaultTx6Message(operator.config);
    const override = normalizeStandardQSOTx6MessageOverride(content, defaultMessage);
    const currentSettings = this.pluginsConfig.operatorSettings?.[operatorId]?.[BUILTIN_STANDARD_QSO_PLUGIN_NAME] ?? {};
    const nextSettings = { ...currentSettings };
    if (override) {
      nextSettings[STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING] = override;
    } else {
      delete nextSettings[STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING];
    }

    if (!this.pluginsConfig.operatorSettings) this.pluginsConfig.operatorSettings = {};
    if (!this.pluginsConfig.operatorSettings[operatorId]) {
      this.pluginsConfig.operatorSettings[operatorId] = {};
    }
    this.pluginsConfig.operatorSettings[operatorId][BUILTIN_STANDARD_QSO_PLUGIN_NAME] = nextSettings;
    return nextSettings;
  }

  /**
   * 合并 global + operator scope 的设置作为 ctx.config
   * global scope 的 key 取 config.plugins.configs，operator scope 的 key 取 operatorSettings
   */
  private buildMergedSettings(
    plugin: LoadedPlugin,
    pluginName: string,
    operatorId: string,
  ): Record<string, unknown> {
    const defaults = this.getDefaultSettings(plugin);
    const settingsNamespace = this.getOperatorSettingsNamespace(pluginName);
    const globalSettings = this.pluginsConfig.configs?.[settingsNamespace]?.settings ?? {};
    const operatorSettings = this.pluginsConfig.operatorSettings?.[operatorId]?.[settingsNamespace] ?? {};

    // 分别按 scope 合并
    const merged: Record<string, unknown> = { ...defaults };
    for (const [key, descriptor] of Object.entries(plugin.definition.settings ?? {})) {
      if (descriptor.type === 'info') continue;
      if (!descriptor.scope || descriptor.scope === 'global') {
        if (key in globalSettings) {
          merged[key] = globalSettings[key];
        } else if (key in operatorSettings) {
          // Scope migrations should keep existing per-operator values working
          // until the user explicitly resaves the new global setting.
          merged[key] = operatorSettings[key];
        }
      } else {
        // operator scope
        if (key in operatorSettings) merged[key] = operatorSettings[key];
      }
    }

    if (pluginName === 'watched-callsign-autocall'
      && !Object.prototype.hasOwnProperty.call(operatorSettings, 'watchMatchMode')) {
      if (operatorSettings.matchMode === 'prefix' || operatorSettings.matchMode === 'exact') {
        merged.watchMatchMode = operatorSettings.matchMode;
      }
      merged.__legacyAutoRegexWatchList = true;
    }
    return merged;
  }

  getPluginStatuses(): PluginStatus[] {
    const result: PluginStatus[] = [];
    for (const [name, plugin] of this.loadedPlugins) {
      const representativeInstance = this.getRepresentativeInstance(name);
      const assignedOperatorIds = plugin.definition.type === 'strategy'
        ? this.getAssignedOperatorIds(name)
        : [];
      result.push({
        ...toPluginStatus(plugin, representativeInstance),
        enabled: plugin.definition.type === 'utility'
          ? (representativeInstance?.enabled ?? this.resolveUtilityEnabled(name, plugin))
          : assignedOperatorIds.length > 0,
        assignedOperatorIds: plugin.definition.type === 'strategy' ? assignedOperatorIds : undefined,
        autoCallEnabledOperatorIds: this.getAutoCallEnabledOperatorIds(name),
        pausedOperatorIds: this.getPausedOperatorIds(name),
      });
    }
    return result;
  }

  async reloadPlugins(): Promise<void> {
    await this.performReload('all plugins', async () => {
      await this.rebuildPluginInventory();
      const operatorIds = this.deps.getOperators().map((operator) => operator.config.id);
      operatorIds.forEach((operatorId) => this.resetOperatorPluginRuntime(operatorId, 'all plugins reloaded'));
    });
  }

  async reloadPlugin(pluginName: string): Promise<void> {
    if (!this.loadedPlugins.has(pluginName)) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    const assignedBeforeReload = this.getAssignedOperatorIds(pluginName);
    await this.performReload(`plugin ${pluginName}`, async () => {
      await this.rebuildPluginInventory();
      const plugin = this.loadedPlugins.get(pluginName);
      if (!plugin) {
        for (const operatorId of assignedBeforeReload) {
          this.pluginsConfig.operatorStrategies[operatorId] = BUILTIN_STANDARD_QSO_PLUGIN_NAME;
          this.resetOperatorPluginRuntime(operatorId, `plugin ${pluginName} removed during reload`);
        }
        return;
      }

      const affectedOperators = plugin.definition.type === 'strategy'
        ? this.getAssignedOperatorIds(pluginName)
        : this.deps.getOperators().map((operator) => operator.config.id);
      affectedOperators.forEach((operatorId) => this.resetOperatorPluginRuntime(operatorId, `plugin ${pluginName} reloaded`));
    });
  }

  async rescanPlugins(): Promise<void> {
    await this.performReload('plugin rescan', async () => {
      const removedAssignments = new Map<string, string[]>();
      const previousNames = new Set(this.loadedPlugins.keys());
      for (const pluginName of previousNames) {
        removedAssignments.set(pluginName, this.getAssignedOperatorIds(pluginName));
      }
      await this.rebuildPluginInventory();
      const removedNames = Array.from(previousNames).filter((name) => !this.loadedPlugins.has(name));
      for (const removedName of removedNames) {
        const affectedOperators = removedAssignments.get(removedName) ?? [];
        for (const operatorId of affectedOperators) {
          this.pluginsConfig.operatorStrategies[operatorId] = BUILTIN_STANDARD_QSO_PLUGIN_NAME;
          this.resetOperatorPluginRuntime(operatorId, `plugin ${removedName} removed during rescan`);
        }
      }
    });
  }

  // ===== 内部辅助 =====

  private assertOperatorExists(operatorId: string): void {
    if (!this.deps.getOperatorById(operatorId)) {
      throw new Error(`Operator not found: ${operatorId}`);
    }
  }

  private isTransmitControlOperatorPlugin(pluginName: string): boolean {
    const plugin = this.loadedPlugins.get(pluginName);
    return Boolean(
      plugin
      && (plugin.definition.instanceScope ?? 'operator') === 'operator'
      && plugin.definition.permissions?.includes('operator:transmit-control')
      && typeof plugin.definition.isAutoCallEnabled === 'function',
    );
  }

  private assertTransmitControlPauseTarget(operatorId: string, pluginName: string): void {
    this.assertOperatorExists(operatorId);
    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }
    if ((plugin.definition.instanceScope ?? 'operator') !== 'operator') {
      throw new Error(`Plugin pause is only available for operator-scope plugins: ${pluginName}`);
    }
    if (!plugin.definition.permissions?.includes('operator:transmit-control')) {
      throw new Error(`Plugin does not declare operator:transmit-control: ${pluginName}`);
    }
    if (typeof plugin.definition.isAutoCallEnabled !== 'function') {
      throw new Error(`Plugin is not an automatic calling controller: ${pluginName}`);
    }
    if (!this.instances.get(operatorId)?.has(pluginName)) {
      throw new Error(`Plugin instance not found for operator: plugin=${pluginName}, operator=${operatorId}`);
    }
  }

  private getTransmitControlPluginNamesForOperator(operatorId: string): string[] {
    this.assertOperatorExists(operatorId);
    return Array.from(this.instances.get(operatorId)?.keys() ?? [])
      .filter((pluginName) => this.isTransmitControlOperatorPlugin(pluginName));
  }

  private setOperatorPluginPausedInMemory(operatorId: string, pluginName: string, paused: boolean): string[] {
    return this.setOperatorPluginPausesInMemory(operatorId, [pluginName], paused);
  }

  private setOperatorPluginPausesInMemory(operatorId: string, pluginNames: string[], paused: boolean): string[] {
    if (!this.pluginsConfig.operatorPluginPauses) {
      this.pluginsConfig.operatorPluginPauses = {};
    }
    const current = new Set(this.pluginsConfig.operatorPluginPauses[operatorId] ?? []);
    const changed: string[] = [];
    for (const pluginName of pluginNames) {
      const hadPlugin = current.has(pluginName);
      if (paused && !hadPlugin) {
        current.add(pluginName);
        changed.push(pluginName);
      } else if (!paused && hadPlugin) {
        current.delete(pluginName);
        changed.push(pluginName);
      }
    }
    if (current.size === 0) {
      delete this.pluginsConfig.operatorPluginPauses[operatorId];
    } else {
      this.pluginsConfig.operatorPluginPauses[operatorId] = Array.from(current).sort();
    }
    return changed;
  }

  private isInstancePaused(instance: PluginInstance): boolean {
    return instance.scope.kind === 'operator'
      && this.isTransmitControlOperatorPlugin(instance.plugin.definition.name)
      && this.isOperatorPluginPaused(instance.scope.operatorId, instance.plugin.definition.name);
  }

  private broadcastStatusChangedForPluginNames(pluginNames: string[]): void {
    for (const pluginName of Array.from(new Set(pluginNames))) {
      this.broadcastStatusChanged(pluginName);
    }
  }

  private getActiveInstances(operatorId: string): PluginInstance[] {
    const operatorInstances = this.instances.get(operatorId);
    const scopedInstances = operatorInstances ? Array.from(operatorInstances.values()) : [];
    const globalInstances = Array.from(this.globalInstances.values()).filter(
      (instance) => instance.enabled && !instance.autoDisabled && instance.lifecycle === 'active',
    );
    return [...globalInstances, ...scopedInstances].filter(
      (instance) => instance.plugin.definition.type === 'strategy'
        ? instance === this.getStrategyInstance(operatorId)
        : instance.enabled
          && !instance.autoDisabled
          && instance.lifecycle === 'active'
          && !this.isInstancePaused(instance),
    );
  }

  private getStrategyInstance(operatorId: string): PluginInstance | undefined {
    const strategyName = this.getResolvedStrategyName(operatorId);
    const instance = this.instances.get(operatorId)?.get(strategyName);
    if (instance?.enabled
        && !instance.autoDisabled
        && instance.lifecycle === 'active'
        && !this.isInstancePaused(instance)) {
      return instance;
    }

    return undefined;
  }

  private assertStrategyRuntimeV2(pluginName: string, runtime: StrategyRuntime | undefined): asserts runtime is StrategyRuntime {
    if (!runtime) {
      throw new Error(`${pluginName} did not create a strategy runtime`);
    }
    const requiredMethods: Array<keyof StrategyRuntime> = [
      'checkpoint',
      'restore',
      'decide',
      'getTransmitText',
      'getSnapshot',
      'requestCall',
      'patchContext',
      'setState',
      'setSlotContent',
      'reset',
    ];
    const missing = requiredMethods.filter((name) => typeof runtime[name] !== 'function');
    if (missing.length > 0) {
      throw new Error(`${pluginName} strategy runtime is missing v2 methods: ${missing.join(', ')}`);
    }
    try {
      structuredClone(runtime.checkpoint());
    } catch (error) {
      throw new Error(
        `${pluginName} strategy checkpoint is not structured-cloneable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getStrategyRuntime(operatorId: string): StrategyRuntime | undefined {
    return this.getStrategyInstance(operatorId)?.runtime;
  }

  private async invokeStrategyRuntime<T>(
    operatorId: string,
    operation: string,
    callback: (runtime: StrategyRuntime) => T | Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T | undefined> {
    const instance = this.getStrategyInstance(operatorId);
    if (!instance?.runtime) return undefined;
    return this.invocationGuard.invokeData(
      instance,
      operation,
      'structured',
      () => callback(instance.runtime!),
      { signal: options?.signal, drainOnExternalAbortMs: 1_000 },
    );
  }

  private invokeStrategyRuntimeSync<T>(
    operatorId: string,
    operation: string,
    callback: (runtime: StrategyRuntime) => T,
  ): T | undefined {
    const instance = this.getStrategyInstance(operatorId);
    if (!instance?.runtime) return undefined;
    return this.invocationGuard.invokeSyncData(
      instance,
      operation,
      'structured',
      () => callback(instance.runtime!),
    );
  }

  private getRepresentativeInstance(pluginName: string): PluginInstance | undefined {
    const globalInstance = this.globalInstances.get(pluginName);
    if (globalInstance) {
      return globalInstance;
    }

    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(pluginName);
      if (instance) {
        return instance;
      }
    }

    return undefined;
  }

  private resolvePluginActionTarget(pluginName: string, operatorId?: string): PluginInstance | undefined {
    const globalInstance = this.globalInstances.get(pluginName);
    if (globalInstance) {
      return globalInstance;
    }

    if (operatorId) {
      return this.instances.get(operatorId)?.get(pluginName);
    }

    const matches: PluginInstance[] = [];
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(pluginName);
      if (instance?.enabled && !instance.autoDisabled) {
        matches.push(instance);
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new Error(`Plugin action requires operatorId when multiple instances exist: ${pluginName}`);
    }

    return undefined;
  }

  private getResolvedStrategyName(operatorId: string): string {
    const configured = this.getActiveStrategyForOperator(operatorId);
    const configuredPlugin = this.loadedPlugins.get(configured);
    if (configuredPlugin && configuredPlugin.definition.type === 'strategy') {
      return configured;
    }
    return BUILTIN_STANDARD_QSO_PLUGIN_NAME;
  }

  private getAssignedOperatorIds(pluginName: string): string[] {
    return this.deps.getOperators()
      .map((operator) => operator.config.id)
      .filter((operatorId) => this.getResolvedStrategyName(operatorId) === pluginName);
  }

  private getAutoCallEnabledOperatorIds(pluginName: string): string[] | undefined {
    const plugin = this.loadedPlugins.get(pluginName);
    if (!this.isTransmitControlOperatorPlugin(pluginName) || !plugin) {
      return undefined;
    }

    const ids: string[] = [];
    for (const [operatorId, operatorInstances] of this.instances) {
      const instance = operatorInstances.get(pluginName);
      if (!instance?.enabled || instance.autoDisabled) {
        continue;
      }
      try {
        const eligibilityContext = Object.freeze({
          config: snapshotPluginData(instance.rawCtx.config, 'structured'),
        });
        if (plugin.definition.isAutoCallEnabled!(eligibilityContext) === true) {
          ids.push(operatorId);
        }
      } catch (err) {
        logger.warn(`Failed to read plugin auto-call state: plugin=${pluginName}, operator=${operatorId}`, err);
      }
    }

    return ids.length > 0 ? ids : undefined;
  }

  private getPausedOperatorIds(pluginName: string): string[] | undefined {
    if (!this.isTransmitControlOperatorPlugin(pluginName)) {
      return undefined;
    }
    const ids = Object.entries(this.pluginsConfig.operatorPluginPauses ?? {})
      .filter(([, pluginNames]) => pluginNames.includes(pluginName))
      .map(([operatorId]) => operatorId)
      .filter((operatorId) => this.instances.get(operatorId)?.has(pluginName))
      .sort();
    return ids.length > 0 ? ids : undefined;
  }

  private resolveUtilityEnabled(pluginName: string, plugin: LoadedPlugin): boolean {
    if (plugin.definition.type !== 'utility') {
      return false;
    }

    const configEntry = this.pluginsConfig.configs?.[pluginName];
    return this.resolveInstanceEnabled(pluginName, plugin, configEntry);
  }

  private resolveInstanceEnabled(
    pluginName: string,
    plugin: LoadedPlugin,
    configEntry: PluginsConfig['configs'][string] | undefined,
  ): boolean {
    if (plugin.definition.type === 'strategy') {
      return true;
    }

    const builtinEntry = BUILTIN_PLUGINS.find((builtin) => builtin.definition.name === pluginName);
    const defaultEnabled = builtinEntry?.enabledByDefault ?? false;
    return configEntry !== undefined ? configEntry.enabled : defaultEnabled;
  }

  private getDefaultSettings(plugin: LoadedPlugin): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    if (plugin.definition.settings) {
      for (const [key, descriptor] of Object.entries(plugin.definition.settings)) {
        if (descriptor.type === 'info') continue;
        settings[key] = descriptor.default;
      }
    }
    return settings;
  }

  private async loadPluginsIntoMemory(): Promise<void> {
    await this.rebuildPluginInventory();
  }

  private async rebuildPluginInventory(): Promise<void> {
    await this.teardownAllInstances();

    const discoveredPlugins = new Map<string, LoadedPlugin>();
    for (const builtin of BUILTIN_PLUGINS) {
      const definition = canonicalizePluginDefinition(builtin.definition);
      discoveredPlugins.set(definition.name, {
        definition,
        isBuiltIn: true,
        locales: builtin.locales,
        dirPath: builtin.dirPath,
      });
    }

    const { pluginDir } = this.getPluginPaths();
    const userPlugins = await this.loader.scanAndLoad(pluginDir);
    for (const plugin of userPlugins) {
      if (discoveredPlugins.has(plugin.definition.name)) {
        this.emitPluginRuntimeLog({
          stage: 'validate',
          level: 'warn',
          message: 'Plugin name conflict: user plugin cannot override built-in plugin',
          pluginName: plugin.definition.name,
          directoryName: plugin.dirPath ? path.basename(plugin.dirPath) : undefined,
          details: {
            pluginName: plugin.definition.name,
            directoryPath: plugin.dirPath,
          },
        });
        logger.warn(`Plugin name conflict: ${plugin.definition.name} (user plugin cannot override built-in)`);
        continue;
      }
      discoveredPlugins.set(plugin.definition.name, {
        ...plugin,
        source: plugin.dirPath ? await readPluginSource(plugin.dirPath) : undefined,
      });
    }

    this.loadedPlugins = discoveredPlugins;
    logger.info(`Plugins discovered: ${Array.from(this.loadedPlugins.keys()).join(', ')}`);

    await this.initGlobalInstances();
    for (const operator of this.deps.getOperators()) {
      await this.initInstancesForOperator(operator.config.id);
    }
  }

  private async teardownAllInstances(): Promise<void> {
    for (const [operatorId, operatorInstances] of this.instances) {
      for (const [pluginName, instance] of operatorInstances) {
        await this.deactivateInstance(operatorId, instance, true).catch((err) => {
          logger.warn(`Failed to deactivate plugin instance: plugin=${pluginName}, operator=${operatorId}`, err);
        });
      }
    }
    for (const [pluginName, instance] of this.globalInstances) {
      await this.deactivateInstance(GLOBAL_PLUGIN_SCOPE_ID, instance, true).catch((err) => {
        logger.warn(`Failed to deactivate global plugin instance: plugin=${pluginName}`, err);
      });
    }

    this.instances.clear();
    this.globalInstances.clear();
    this.loadedPlugins.clear();
    this.runtimePanelContributions.clear();
    this.orchestrator.clearAllDecisionStates();
  }

  private async performReload(reason: string, action: () => Promise<void>): Promise<void> {
    if (!this.running) {
      throw new Error('Plugin manager is not running');
    }

    this.emitPluginRuntimeLog({
      stage: 'reload',
      level: 'info',
      message: `Plugin reload started: ${reason}`,
      details: { reason },
    });

    this.systemState = {
      ...this.systemState,
      state: 'reloading',
      lastError: undefined,
    };
    this.bumpGeneration();
    this.broadcastPluginList();

    try {
      await action();
      this.systemState = {
        ...this.systemState,
        state: 'ready',
        lastError: undefined,
      };
      this.bumpGeneration();
      this.broadcastPluginList();
      this.emitPluginRuntimeLog({
        stage: 'reload',
        level: 'info',
        message: `Plugin reload completed: ${reason}`,
        details: { reason },
      });
      logger.info(`Plugin reload completed: ${reason}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.systemState = {
        ...this.systemState,
        state: 'error',
        lastError: message,
      };
      this.bumpGeneration();
      this.broadcastPluginList();
      this.emitPluginRuntimeLog({
        stage: 'reload',
        level: 'error',
        message: `Plugin reload failed: ${reason}`,
        details: {
          reason,
          error: message,
        },
      });
      logger.error(`Plugin reload failed: ${reason}`, err);
      throw err;
    }
  }

  private bumpGeneration(): void {
    this.systemState = {
      ...this.systemState,
      generation: this.systemState.generation + 1,
    };
  }

  resetOperatorPluginRuntime(operatorId: string, reason: string): void {
    this.deps.releaseTargetReservation?.(operatorId);
    this.suspendedQueueExecutions.delete(operatorId);
    try {
      this.invokeStrategyRuntimeSync(
        operatorId,
        'reset',
        (runtime) => {
          runtime.reset(reason);
        },
      );
    } catch (err) {
      logger.warn(`Failed to reset strategy runtime: operator=${operatorId}`, err);
    }
    this.orchestrator.clearDecisionState(operatorId);
    this.deps.resetOperatorRuntime(operatorId, reason);
  }

  private resetStrategyInstanceRuntime(instance: PluginInstance | undefined, reason: string): void {
    if (!instance?.runtime) return;
    try {
      this.invocationGuard.invokeSync(instance, 'reset:strategy-switch', () => instance.runtime!.reset(reason));
    } catch (err) {
      logger.warn(`Failed to reset strategy runtime: plugin=${instance.plugin.definition.name}`, err);
    }
  }

  private handleAutoDisable(pluginName: string, reason: string): void {
    if (!this.pluginsConfig.configs) {
      this.pluginsConfig.configs = {};
    }
    const existing = this.pluginsConfig.configs[pluginName] ?? { enabled: true, settings: {} };
    this.pluginsConfig.configs[pluginName] = { ...existing, enabled: false };
    const affectedInstances = [
      this.globalInstances.get(pluginName),
      ...Array.from(this.instances.values()).map((entries) => entries.get(pluginName)),
    ].filter((instance): instance is PluginInstance => Boolean(instance));
    for (const instance of affectedInstances) {
      instance.enabled = false;
      instance.autoDisabled = true;
      const operatorId = instance.scope.kind === 'operator'
        ? instance.scope.operatorId
        : GLOBAL_PLUGIN_SCOPE_ID;
      void this.deactivateInstance(operatorId, instance);
    }
    logger.warn(`Plugin auto-disabled: ${pluginName}, reason: ${reason}`);
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
  }

  private broadcastPluginList(): void {
    const snapshot = this.getSnapshot();
    this.deps.eventEmitter.emit('pluginList', snapshot);
  }

  private getPanelContributionSnapshot(): PluginUIPanelContributionGroup[] {
    const manifestGroups: PluginUIPanelContributionGroup[] = [];
    for (const plugin of this.loadedPlugins.values()) {
      const panels = plugin.definition.panels ?? [];
      if (panels.length === 0) {
        continue;
      }
      manifestGroups.push({
        pluginName: plugin.definition.name,
        groupId: 'manifest',
        source: 'manifest',
        panels,
      });
    }

    return [
      ...manifestGroups,
      ...Array.from(this.runtimePanelContributions.values()).map((group) => ({
        ...group,
        panels: group.panels.map((panel) => ({ ...panel, params: panel.params ? { ...panel.params } : undefined })),
      })),
    ];
  }

  private getInstanceTargetKey(instanceTarget: PluginUIInstanceTarget): string {
    return instanceTarget.kind === 'operator'
      ? `operator:${instanceTarget.operatorId}`
      : 'global';
  }

  private getRuntimePanelContributionKey(
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    groupId: string,
  ): string {
    return `${pluginName}:${this.getInstanceTargetKey(instanceTarget)}:${groupId}`;
  }

  private validateRuntimePanelContributions(
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    groupId: string,
    panels: PluginPanelDescriptor[],
  ): void {
    if (!groupId || groupId.trim() !== groupId || groupId === 'manifest') {
      throw new Error('Panel contribution groupId must be stable and must not be "manifest"');
    }

    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    const uiPageById = new Map((plugin.definition.ui?.pages ?? []).map((page) => [page.id, page]));
    const uiPageIds = new Set(uiPageById.keys());
    const ids = new Set<string>();
    for (const panel of panels) {
      if (!panel.id || ids.has(panel.id)) {
        throw new Error(`Duplicate or empty panel id in contribution group "${groupId}": ${panel.id}`);
      }
      ids.add(panel.id);

      if (panel.component === 'iframe') {
        if (!panel.pageId) {
          throw new Error(`Iframe panel "${panel.id}" must declare pageId`);
        }
        if (!uiPageIds.has(panel.pageId)) {
          throw new Error(`Iframe panel "${panel.id}" references unknown ui page "${panel.pageId}"`);
        }
      }

      if (panel.slot === 'operator-action') {
        if ((plugin.definition.instanceScope ?? 'operator') !== 'operator') {
          throw new Error('operator-action panels are only supported for operator-scoped plugins');
        }
        if (instanceTarget.kind !== 'operator') {
          throw new Error(`operator-action panel "${panel.id}" must be contributed by an operator plugin instance`);
        }
        if (panel.component !== 'iframe' || !panel.pageId) {
          throw new Error(`operator-action panel "${panel.id}" must reference an iframe UI page`);
        }
        if (panel.openMode !== 'page') {
          throw new Error(`operator-action panel "${panel.id}" must use openMode "page"`);
        }
        const page = uiPageById.get(panel.pageId);
        if (page?.resourceBinding !== 'operator') {
          throw new Error(`operator-action panel "${panel.id}" must reference a UI page with resourceBinding "operator"`);
        }
      }

      if (panel.slot === 'radio-control-toolbar') {
        if (panel.component !== 'iframe') {
          throw new Error(`radio-control-toolbar panel "${panel.id}" must use iframe component`);
        }
        if (!panel.pageId) {
          throw new Error(`radio-control-toolbar panel "${panel.id}" must declare pageId`);
        }
        if (!uiPageIds.has(panel.pageId)) {
          throw new Error(`Iframe panel "${panel.id}" references unknown ui page "${panel.pageId}"`);
        }
        const page = uiPageById.get(panel.pageId);
        if (plugin.definition.type !== 'utility' || (plugin.definition.instanceScope ?? 'operator') !== 'global') {
          throw new Error('radio-control-toolbar panels are only supported for global utility plugins');
        }
        if (instanceTarget.kind !== 'global') {
          throw new Error(`radio-control-toolbar panel "${panel.id}" must be contributed by a global plugin instance`);
        }
        if ((page?.resourceBinding ?? 'none') !== 'none') {
          throw new Error(`radio-control-toolbar panel "${panel.id}" must reference a UI page with resourceBinding "none"`);
        }
      }

      if (panel.params) {
        for (const [key, value] of Object.entries(panel.params)) {
          if (typeof key !== 'string' || typeof value !== 'string') {
            throw new Error(`Panel "${panel.id}" params must be string key-value pairs`);
          }
        }
      }
    }

    const replacementKey = this.getRuntimePanelContributionKey(pluginName, instanceTarget, groupId);
    const mergedIds = new Set<string>();
    const collect = (panel: PluginPanelDescriptor) => {
      if (mergedIds.has(panel.id)) {
        throw new Error(`Panel id "${panel.id}" conflicts with another contribution in plugin "${pluginName}"`);
      }
      mergedIds.add(panel.id);
    };

    for (const panel of plugin.definition.panels ?? []) {
      collect(panel);
    }
    for (const [key, group] of this.runtimePanelContributions) {
      if (key === replacementKey || group.pluginName !== pluginName) {
        continue;
      }
      if (JSON.stringify(group.instanceTarget) !== JSON.stringify(instanceTarget)) {
        continue;
      }
      for (const panel of group.panels) {
        collect(panel);
      }
    }
    for (const panel of panels) {
      collect(panel);
    }
  }

  private setRuntimePanelContributions(
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    groupId: string,
    panels: PluginPanelDescriptor[],
  ): void {
    this.validateRuntimePanelContributions(pluginName, instanceTarget, groupId, panels);

    const key = this.getRuntimePanelContributionKey(pluginName, instanceTarget, groupId);
    const group: PluginUIPanelContributionGroup = {
      pluginName,
      groupId,
      source: 'runtime',
      instanceTarget,
      panels: panels.map((panel) => ({ ...panel, params: panel.params ? { ...panel.params } : undefined })),
    };

    if (panels.length === 0) {
      this.runtimePanelContributions.delete(key);
    } else {
      this.runtimePanelContributions.set(key, group);
    }

    this.bumpGeneration();
    this.deps.eventEmitter.emit('pluginPanelContributionsChanged', {
      ...group,
      panels: panels.length === 0 ? [] : group.panels,
    });
  }

  private clearRuntimePanelContributionsForInstance(instance: PluginInstance): void {
    const instanceTarget = instance.scope.kind === 'operator'
      ? { kind: 'operator' as const, operatorId: instance.scope.operatorId }
      : { kind: 'global' as const };
    const prefix = `${instance.plugin.definition.name}:${this.getInstanceTargetKey(instanceTarget)}:`;
    const clearedGroups: PluginUIPanelContributionGroup[] = [];

    for (const [key, group] of this.runtimePanelContributions) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.runtimePanelContributions.delete(key);
      clearedGroups.push({ ...group, panels: [] });
    }

    if (clearedGroups.length === 0) {
      return;
    }

    this.bumpGeneration();
    for (const group of clearedGroups) {
      this.deps.eventEmitter.emit('pluginPanelContributionsChanged', group);
    }
  }

  private getPanelMetaSnapshot(): PluginPanelMetaPayload[] {
    return Array.from(this.panelMetaState.values()).map((entry) => ({
      ...entry,
      meta: { ...entry.meta },
    }));
  }

  private getPanelMetaKey(pluginName: string, operatorId: string, panelId: string): string {
    return `${pluginName}:${operatorId}:${panelId}`;
  }

  private recordPanelMeta(payload: PluginPanelMetaPayload): void {
    const key = this.getPanelMetaKey(payload.pluginName, payload.operatorId, payload.panelId);
    this.panelMetaState.set(key, {
      ...payload,
      meta: { ...payload.meta },
    });
  }

  private clearPanelMetaForInstance(instance: PluginInstance): void {
    const operatorId = instance.scope.kind === 'operator'
      ? instance.scope.operatorId
      : GLOBAL_PLUGIN_SCOPE_ID;
    const prefix = `${instance.plugin.definition.name}:${operatorId}:`;
    for (const key of this.panelMetaState.keys()) {
      if (key.startsWith(prefix)) {
        this.panelMetaState.delete(key);
      }
    }
  }

  private broadcastStatusChanged(pluginName: string): void {
    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin) return;
    const representativeInstance = this.getRepresentativeInstance(pluginName);
    const status = {
      ...toPluginStatus(plugin, representativeInstance),
      enabled: plugin.definition.type === 'utility'
        ? (representativeInstance?.enabled ?? this.resolveUtilityEnabled(pluginName, plugin))
        : this.getAssignedOperatorIds(pluginName).length > 0,
      assignedOperatorIds: plugin.definition.type === 'strategy'
        ? this.getAssignedOperatorIds(pluginName)
        : undefined,
      autoCallEnabledOperatorIds: this.getAutoCallEnabledOperatorIds(pluginName),
      pausedOperatorIds: this.getPausedOperatorIds(pluginName),
    };
    this.deps.eventEmitter.emit('pluginStatusChanged', {
      generation: this.systemState.generation,
      plugin: status,
    });
  }

  private activateInstance(operatorId: string, instance: PluginInstance): Promise<void> {
    if (instance.lifecycle === 'disposed' || instance.desiredLifecycle === 'disposed') {
      return Promise.reject(new Error(
        `Cannot reactivate disposed plugin instance: ${instance.plugin.definition.name}`,
      ));
    }
    instance.desiredLifecycle = 'active';
    const revision = ++instance.lifecycleRevision;
    const transition = instance.lifecycleTail.then(() => (
      this.reconcileInstanceLifecycle(operatorId, instance, revision)
    ));
    instance.lifecycleTail = transition.catch(() => undefined);
    return transition;
  }

  private async reconcileInstanceLifecycle(
    operatorId: string,
    instance: PluginInstance,
    revision: number,
  ): Promise<void> {
    if (revision !== instance.lifecycleRevision) {
      return;
    }
    if (instance.desiredLifecycle === 'active') {
      if (!instance.enabled || instance.autoDisabled) {
        return;
      }
      await this.activateInstanceNow(operatorId, instance, revision);
      return;
    }
    await this.deactivateInstanceNow(operatorId, instance);
  }

  private isCurrentActivation(instance: PluginInstance, revision: number): boolean {
    return instance.lifecycleRevision === revision
      && instance.desiredLifecycle === 'active'
      && instance.enabled
      && !instance.autoDisabled;
  }

  private async activateInstanceNow(
    operatorId: string,
    instance: PluginInstance,
    revision: number,
  ): Promise<void> {
    if (!this.isCurrentActivation(instance, revision)) {
      return;
    }
    if (instance.lifecycle === 'active') {
      return;
    }
    if (instance.lifecycle === 'disposed') {
      throw new Error(`Cannot activate disposed plugin: ${instance.plugin.definition.name}`);
    }
    if (instance.lifecycle === 'stopping' || instance.lifecycle === 'quarantined') {
      await this.deactivateInstanceNow(operatorId, instance);
      if (!this.isCurrentActivation(instance, revision)) {
        return;
      }
    }
    instance.lifecycle = 'starting';
    const hook = instance.plugin.definition.onLoad;
    this.clearRuntimePanelContributionsForInstance(instance);
    if (!hook) {
      if (this.isCurrentActivation(instance, revision)) {
        instance.lifecycle = 'active';
      }
      return;
    }
    try {
      this.clearPanelMetaForInstance(instance);
      this._logbookSyncHost.unregisterByPlugin(instance.plugin.definition.name);
      // Run legacy migration for built-in plugins before onLoad
      if (instance.plugin.isBuiltIn) {
        const migrationFn = BUILTIN_MIGRATIONS[instance.plugin.definition.name];
        if (migrationFn) {
          await this.invocationGuard.invoke(
            instance,
            'builtin:migration',
            () => migrationFn(instance.ctx),
          );
          if (!this.isCurrentActivation(instance, revision)) {
            await this.deactivateInstanceNow(operatorId, instance);
            return;
          }
        }
      }
      await this.invocationGuard.invoke(instance, 'onLoad', () => hook(instance.ctx as never));
      if (!this.isCurrentActivation(instance, revision)) {
        await this.deactivateInstanceNow(operatorId, instance);
        return;
      }
      instance.lifecycle = 'active';
    } catch (err) {
      if (!this.isCurrentActivation(instance, revision)) {
        await this.deactivateInstanceNow(operatorId, instance);
        return;
      }
      instance.desiredLifecycle = 'inactive';
      instance.lifecycleRevision += 1;
      instance.lifecycle = 'quarantined';
      instance.autoDisabled = true;
      this.closeInstanceIngress(instance);
      this.invocationGuard.revokeInstance(instance, 'plugin onLoad failed');
      await instance.rawCtx.network?.udp.closeAll().catch(() => undefined);
      this.emitPluginRuntimeLog({
        stage: 'activate',
        level: 'error',
        message: 'Plugin onLoad hook failed',
        pluginName: instance.plugin.definition.name,
        directoryName: instance.plugin.dirPath ? path.basename(instance.plugin.dirPath) : undefined,
        details: {
          operatorId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      logger.error(`onLoad error: plugin=${instance.plugin.definition.name}, operator=${operatorId}`, err);
    }
  }

  private deactivateInstance(
    operatorId: string,
    instance: PluginInstance,
    dispose = false,
  ): Promise<void> {
    if (instance.lifecycle === 'disposed') {
      return Promise.resolve();
    }
    instance.desiredLifecycle = dispose ? 'disposed' : 'inactive';
    const revision = ++instance.lifecycleRevision;
    // Revoke ingress synchronously; queued or hung onLoad work must not gain a
    // command-capable window after disable has already been requested.
    if (instance.lifecycle !== 'inactive') {
      instance.lifecycle = 'stopping';
    }
    this.closeInstanceIngress(instance);
    this.invocationGuard.revokeInstance(instance, 'plugin instance deactivation requested');
    const transition = instance.lifecycleTail.then(() => (
      this.reconcileInstanceLifecycle(operatorId, instance, revision)
    ));
    instance.lifecycleTail = transition.catch(() => undefined);
    return transition;
  }

  private async deactivateInstanceNow(
    operatorId: string,
    instance: PluginInstance,
  ): Promise<void> {
    if (instance.lifecycle === 'disposed') {
      return;
    }
    const wasLoaded = instance.lifecycle !== 'inactive';
    if (!wasLoaded && instance.desiredLifecycle !== 'disposed') return;
    instance.lifecycle = 'stopping';
    this.closeInstanceIngress(instance);
    await instance.rawCtx.network?.udp.closeAll().catch(() => undefined);
    this.invocationGuard.revokeInstance(instance, 'plugin instance stopping');

    const hook = instance.plugin.definition.onUnload;
    if (wasLoaded && hook) {
      try {
        await this.invocationGuard.invoke(
          instance,
          'onUnload',
          () => hook(instance.ctx as never),
          {
            allowedContextRoots: new Set([
              'store',
              'timers',
              'files',
              'operator',
              'ui',
              'hostDependencies',
            ]),
          },
        );
      } catch (err) {
        this.emitPluginRuntimeLog({
          stage: 'activate',
          level: 'warn',
          message: 'Plugin onUnload hook failed',
          pluginName: instance.plugin.definition.name,
          directoryName: instance.plugin.dirPath ? path.basename(instance.plugin.dirPath) : undefined,
          details: {
            operatorId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        logger.warn(`onUnload error: plugin=${instance.plugin.definition.name}, operator=${operatorId}`, err);
      }
    }
    this.closeInstanceIngress(instance);
    this.invocationGuard.revokeInstance(instance, 'plugin instance unloaded');
    this.clearPanelMetaForInstance(instance);
    this.clearRuntimePanelContributionsForInstance(instance);
    this._logbookSyncHost.unregisterByPlugin(instance.plugin.definition.name, instance.generation);
    // PluginContextFactory 总是创建 PluginStorageProvider 实例（实现 FlushableKVStore）
    const globalStore = instance.rawCtx.store.global as FlushableKVStore;
    const operatorStore = instance.rawCtx.store.operator as FlushableKVStore;
    await globalStore.flush().catch(() => {});
    await operatorStore.flush().catch(() => {});
    if (instance.desiredLifecycle === 'disposed') {
      globalStore.dispose?.();
      operatorStore.dispose?.();
      instance.lifecycle = 'disposed';
    } else {
      instance.lifecycle = 'inactive';
    }
  }

  private closeInstanceIngress(instance: PluginInstance): void {
    instance.rawCtx.timers.clearAll();
    const bridge = instance.rawCtx.ui as import('./PluginUIBridge.js').PluginUIBridge;
    bridge.clearPageHandler();
    const instanceTarget: PluginUIInstanceTarget = instance.scope.kind === 'global'
      ? { kind: 'global' }
      : { kind: 'operator', operatorId: instance.scope.operatorId };
    for (const sessionId of this.pageSessions.deleteByPluginInstance(
      instance.plugin.definition.name,
      instanceTarget,
    )) {
      this.pageSessionPushQueues.delete(sessionId);
    }
    this.pluginEventBusHost.unsubscribeAll({
      pluginName: instance.plugin.definition.name,
      instanceScope: instance.scope.kind,
      operatorId: instance.scope.kind === 'operator' ? instance.scope.operatorId : undefined,
    });
  }

  private registerEngineListeners(): void {
    const eventEmitter = this.eventEmitter;
    const onSlotStart = (slotInfo: SlotInfo, slotPack: SlotPack | null) => {
      void this.orchestrator.handleSlotStart(slotInfo, slotPack);
    };
    const onEncodeStart = (slotInfo: SlotInfo) => {
      this.orchestrator.handleEncodeStart(slotInfo);
    };
    const onFrequencyChanged = (state: import('@tx5dr/contracts').FrequencyState) => {
      void Promise.allSettled(this.deps.getOperators().map((operator) => this.dispatcher.dispatchBroadcast(
        operator.config.id,
        'onFrequencyChange',
        (hook, ctx) => hook(snapshotPluginData(state, 'structured'), ctx),
        (instance) => this.getCtxForInstance(instance),
      )));
    };

    eventEmitter.on('slotStart', onSlotStart);
    eventEmitter.on('encodeStart', onEncodeStart);
    eventEmitter.on('frequencyChanged', onFrequencyChanged);
    this.unsubscribeFns.push(() => eventEmitter.off('slotStart', onSlotStart));
    this.unsubscribeFns.push(() => eventEmitter.off('encodeStart', onEncodeStart));
    this.unsubscribeFns.push(() => eventEmitter.off('frequencyChanged', onFrequencyChanged));
  }

  /** @internal Exposed for integration tests that call via `(pm as any).handleSlotStart(...)` */
  private handleSlotStart(slotInfo: SlotInfo, slotPack: SlotPack | null): Promise<void> {
    return this.orchestrator.handleSlotStart(slotInfo, slotPack);
  }

  /** @internal Exposed for integration tests that call via `(pm as any).handleEncodeStart(...)` */
  private handleEncodeStart(slotInfo: SlotInfo): void {
    this.orchestrator.handleEncodeStart(slotInfo);
  }

  private unregisterEngineListeners(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];
  }

  invalidateDecisionMessageSet(operatorId: string): void {
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
  }

  private emitPluginRuntimeLog(event: PluginLoaderRuntimeLogEvent): void {
    const entry: PluginRuntimeLogEntry = {
      source: 'system',
      timestamp: Date.now(),
      stage: event.stage,
      level: event.level,
      message: event.message,
      pluginName: event.pluginName,
      directoryName: event.directoryName,
      details: event.details,
    };
    this.appendPluginLogHistory(entry);
    this.eventEmitter.emit('pluginRuntimeLog', entry);
  }
}
