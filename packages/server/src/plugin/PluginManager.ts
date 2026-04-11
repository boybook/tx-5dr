import type {
  DigitalRadioEngineEvents,
  PluginStatus,
  PluginSystemSnapshot,
  PluginsConfig,
  SlotInfo,
  SlotPack,
  FrameMessage,
  StrategyRuntimeContext,
} from '@tx5dr/contracts';
import type {
  PluginContext,
  StrategyRuntime,
  StrategyRuntimeSlot,
  StrategyRuntimeSnapshot,
} from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import { PluginLoader, validatePluginDefinition } from './PluginLoader.js';
import { PluginHookDispatcher } from './PluginHookDispatcher.js';
import { DecisionOrchestrator } from './DecisionOrchestrator.js';
import { PluginContextFactory } from './PluginContextFactory.js';
import { LogbookSyncHost } from './LogbookSyncHost.js';
import {
  BUILTIN_PLUGINS,
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
} from './builtins/index.js';
import { toPluginStatus, toPluginSystemSnapshot } from './types.js';
import type { LoadedPlugin, PluginInstance, PluginManagerDeps, PluginSystemRuntimeState, FlushableKVStore } from './types.js';
import { createLogger } from '../utils/logger.js';
import path from 'path';

const logger = createLogger('PluginManager');

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
  private loadedPlugins = new Map<string, LoadedPlugin>();
  // operatorId → Map<pluginName, PluginInstance>
  private instances = new Map<string, Map<string, PluginInstance>>();
  private dispatcher!: PluginHookDispatcher;
  private orchestrator!: DecisionOrchestrator;
  private contextFactory: PluginContextFactory;
  private loader = new PluginLoader();
  private running = false;
  private unsubscribeFns: Array<() => void> = [];
  private _logbookSyncHost: import('./LogbookSyncHost.js').LogbookSyncHost;

  private systemState: PluginSystemRuntimeState = {
    state: 'ready',
    generation: 0,
  };

  // 配置（来自 ConfigManager）
  private pluginsConfig: PluginsConfig = {
    configs: {},
    operatorStrategies: {},
    operatorSettings: {},
  };

  constructor(private deps: PluginManagerDeps) {
    this._logbookSyncHost = new LogbookSyncHost();
    // Wire the logbook sync registration callback so plugins can register
    // providers via ctx.logbookSync.register().
    deps.registerLogbookSyncProvider = (pluginName, provider) => {
      this._logbookSyncHost.register(pluginName, provider);
    };
    this.contextFactory = new PluginContextFactory(deps);
    this.dispatcher = new PluginHookDispatcher(
      (operatorId) => this.getActiveInstances(operatorId),
      (operatorId) => this.getStrategyInstance(operatorId),
      (pluginName, reason) => this.handleAutoDisable(pluginName, reason),
    );
    this.orchestrator = new DecisionOrchestrator({
      getOperators: deps.getOperators,
      getOperatorById: deps.getOperatorById,
      getOperatorAutomationSnapshot: deps.getOperatorAutomationSnapshot,
      interruptOperatorTransmission: deps.interruptOperatorTransmission,
      analyzeCallsignForOperator: deps.analyzeCallsignForOperator,
      setOperatorAudioFrequency: deps.setOperatorAudioFrequency,
      getStrategyRuntime: (operatorId) => this.getStrategyRuntime(operatorId),
      getCtxForInstance: (instance) => this.getCtxForInstance(instance),
      dispatcher: this.dispatcher,
      eventEmitter: deps.eventEmitter,
      requestCall: (operatorId, callsign, lastMessage) => this.requestCall(operatorId, callsign, lastMessage),
      notifyTransmissionQueued: (operatorId, transmission) => this.notifyTransmissionQueued(operatorId, transmission),
    });
  }

  private get eventEmitter(): EventEmitter<DigitalRadioEngineEvents> {
    return this.deps.eventEmitter;
  }

  /** 允许在 initialize() 阶段设置正确的数据目录 */
  setDataDir(dataDir: string): void {
    this.deps.dataDir = dataDir;
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.debug('Plugin manager already started');
      return;
    }

    logger.info('Starting plugin manager');
    this.running = true;
    await this.loadPluginsIntoMemory();
    this.registerEngineListeners();
    this.bumpGeneration();
    this.broadcastPluginList();

    logger.info(`Plugin manager started (${this.loadedPlugins.size} plugins)`);
  }

  async shutdown(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping plugin manager');
    await this.teardownAllInstances();
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
      if (operatorInstances.has(pluginName)) continue;

      const configEntry = this.pluginsConfig.configs?.[pluginName];
      const enabled = this.resolveInstanceEnabled(pluginName, plugin, configEntry);

      const pluginStorageDir = path.join(this.deps.dataDir, 'plugin-data', pluginName);
      const instance: PluginInstance = {
        plugin,
        ctx: null as unknown as PluginContext, // 先占位，下面赋值
        runtime: undefined,
        enabled,
        errorCounts: new Map(),
        autoDisabled: false,
      };

      const ctx = this.contextFactory.create(
        plugin,
        operatorId,
        pluginStorageDir,
        (timerId) => {
          if (instance.ctx) {
            plugin.definition.hooks?.onTimer?.(timerId, instance.ctx);
          }
        },
        () => this.buildMergedSettings(plugin, pluginName, operatorId),
      );
      instance.ctx = ctx;
      if (plugin.definition.type === 'strategy') {
        instance.runtime = plugin.definition.createStrategyRuntime?.(ctx);
      }
      operatorInstances.set(pluginName, instance);

      // 调用 onLoad（仅 enabled 的插件）
      if (enabled) {
        await this.activateInstance(operatorId, instance);
      }
    }
  }

  removeInstancesForOperator(operatorId: string): void {
    const operatorInstances = this.instances.get(operatorId);
    if (!operatorInstances) {
      return;
    }

    for (const instance of operatorInstances.values()) {
      if (!instance.enabled) continue;
      void this.deactivateInstance(operatorId, instance);
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

  getCtxForInstance(instance: PluginInstance): PluginContext {
    return instance.ctx;
  }

  getOperatorRuntimeStatus(operatorId: string): {
    strategyName: string;
    currentSlot: string;
    slots?: Record<string, string>;
    context?: Record<string, unknown>;
    availableSlots?: string[];
  } {
    const strategyName = this.getResolvedStrategyName(operatorId);
    const snapshot = this.getOperatorAutomationSnapshot(operatorId);
    if (!snapshot) {
      return { strategyName, currentSlot: 'TX6' };
    }

    try {
      return {
        strategyName,
        currentSlot: typeof snapshot.currentState === 'string' ? snapshot.currentState : 'TX6',
        slots: snapshot.slots && typeof snapshot.slots === 'object'
          ? snapshot.slots as Record<string, string>
          : undefined,
        context: snapshot.context && typeof snapshot.context === 'object'
          ? snapshot.context as Record<string, unknown>
          : undefined,
        availableSlots: snapshot.availableSlots,
      };
    } catch (err) {
      logger.error(`Failed to read strategy status: operator=${operatorId}`, err);
      return { strategyName, currentSlot: 'TX6' };
    }
  }

  getOperatorAutomationSnapshot(operatorId: string): StrategyRuntimeSnapshot | null {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) {
      return null;
    }

    try {
      return runtime.getSnapshot();
    } catch (err) {
      logger.error(`Failed to read strategy snapshot: operator=${operatorId}`, err);
      return null;
    }
  }

  patchOperatorRuntimeContext(
    operatorId: string,
    patch: Partial<StrategyRuntimeContext>,
  ): void {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) return;
    runtime.patchContext(patch);
  }

  setOperatorRuntimeState(operatorId: string, state: StrategyRuntimeSlot): void {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) return;
    runtime.setState(state);
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    this.eventEmitter.emit('operatorSlotChanged', { operatorId, slot: state });
  }

  setOperatorRuntimeSlotContent(
    operatorId: string,
    slot: StrategyRuntimeSlot,
    content: string,
  ): void {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) return;
    runtime.setSlotContent({ slot, content });
    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    this.eventEmitter.emit('operatorSlotContentChanged', { operatorId, slot, content });
  }

  getCurrentTransmission(operatorId: string): string | null {
    return this.orchestrator.readCurrentTransmission(operatorId);
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

    const hook = instance.plugin.definition.hooks?.onUserAction;
    if (!hook) {
      return;
    }
    hook(actionId, payload, instance.ctx);
  }

  requestCall(
    operatorId: string,
    callsign: string,
    lastMessage?: { message: FrameMessage; slotInfo: SlotInfo },
  ): void {
    const operator = this.deps.getOperatorById(operatorId);
    const runtime = this.getStrategyRuntime(operatorId);
    if (!operator || !runtime) return;

    this.orchestrator.invalidateDecisionMessageSet(operatorId);
    operator.start();
    if (lastMessage) {
      operator.setTransmitCycles((lastMessage.slotInfo.cycleNumber + 1) % 2);
    }
    runtime.requestCall(callsign, lastMessage);
  }

  notifyTransmissionQueued(operatorId: string, transmission: string): void {
    const runtime = this.getStrategyRuntime(operatorId);
    runtime?.onTransmissionQueued?.(transmission);
  }

  async reDecideOperator(operatorId: string, slotPack: SlotPack): Promise<boolean> {
    return this.orchestrator.reDecideOperator(operatorId, slotPack);
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

    const previousStrategy = this.pluginsConfig.operatorStrategies?.[operatorId];
    if (!this.pluginsConfig.operatorStrategies) {
      this.pluginsConfig.operatorStrategies = {};
    }
    this.pluginsConfig.operatorStrategies[operatorId] = pluginName;

    const operatorInstances = this.instances.get(operatorId);
    const previousInstance = previousStrategy ? operatorInstances?.get(previousStrategy) : undefined;
    const nextInstance = operatorInstances?.get(pluginName);

    if (previousInstance && previousInstance !== nextInstance) {
      void this.deactivateInstance(operatorId, previousInstance);
    }
    if (nextInstance) {
      nextInstance.enabled = true;
      void this.activateInstance(operatorId, nextInstance);
    }
    this.resetOperatorPluginRuntime(operatorId, `strategy switched to ${pluginName}`);
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
    if (previousStrategy && previousStrategy !== pluginName) {
      this.broadcastStatusChanged(previousStrategy);
    }
    this.broadcastPluginList();
  }

  // ===== 配置 API =====

  loadConfig(config: PluginsConfig): void {
    this.pluginsConfig = {
      ...config,
      configs: config.configs ?? {},
      operatorStrategies: config.operatorStrategies ?? {},
      operatorSettings: config.operatorSettings ?? {},
    };
  }

  getSnapshot(): PluginSystemSnapshot {
    return toPluginSystemSnapshot(this.systemState, this.getPluginStatuses());
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
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(name);
      if (!instance) continue;
      instance.enabled = enabled;
      if (enabled) {
        void this.activateInstance(instance.ctx.operator.id, instance);
      } else {
        void this.deactivateInstance(instance.ctx.operator.id, instance);
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
    // 通知所有操作员实例配置变更（仅 global scope 键）
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(name);
      if (instance?.enabled) {
        instance.plugin.definition.hooks?.onConfigChange?.(settings, instance.ctx);
      }
    }
    this.bumpGeneration();
    this.broadcastStatusChanged(name);
  }

  /** 获取操作员维度的插件设置 */
  getOperatorPluginSettings(operatorId: string, pluginName: string): Record<string, unknown> {
    return this.pluginsConfig.operatorSettings?.[operatorId]?.[pluginName] ?? {};
  }

  /**
   * Returns the loaded plugin metadata for the given name, or `undefined` if
   * the plugin is not loaded. Exposed for route handlers that need access to
   * the plugin's filesystem directory (e.g. serving static UI files).
   */
  getLoadedPlugin(pluginName: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(pluginName);
  }

  /** Host-side manager for logbook sync providers registered by plugins. */
  get logbookSyncHost(): LogbookSyncHost {
    return this._logbookSyncHost;
  }

  /**
   * Invokes a custom page handler registered by the given plugin. The host
   * routes iframe `bridge.invoke()` calls through this method.
   *
   * Returns the handler's response, or throws if no handler is registered.
   * Uses any available operator instance — the page handler is per-plugin,
   * not per-operator.
   */
  async invokePluginPageHandler(
    pluginName: string,
    pageId: string,
    action: string,
    data: unknown,
  ): Promise<unknown> {
    for (const operatorInstances of this.instances.values()) {
      const instance = operatorInstances.get(pluginName);
      if (!instance) continue;
      const bridge = instance.ctx.ui as import('./PluginUIBridge.js').PluginUIBridge;
      if (bridge.hasPageHandler()) {
        return bridge.handlePageInvoke(pageId, action, data);
      }
    }
    throw new Error(`No page handler registered for plugin: ${pluginName}`);
  }

  /** 更新 operator scope 插件设置，并通知相关实例 */
  setOperatorPluginSettings(
    operatorId: string,
    pluginName: string,
    settings: Record<string, unknown>,
  ): void {
    if (!this.pluginsConfig.operatorSettings) this.pluginsConfig.operatorSettings = {};
    if (!this.pluginsConfig.operatorSettings[operatorId]) {
      this.pluginsConfig.operatorSettings[operatorId] = {};
    }
    this.pluginsConfig.operatorSettings[operatorId][pluginName] = settings;

    // 通知该操作员的实例配置变更
    const instance = this.instances.get(operatorId)?.get(pluginName);
    if (instance?.enabled) {
      instance.plugin.definition.hooks?.onConfigChange?.(settings, instance.ctx);
    }
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
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
    const globalSettings = this.pluginsConfig.configs?.[pluginName]?.settings ?? {};
    const operatorSettings = this.pluginsConfig.operatorSettings?.[operatorId]?.[pluginName] ?? {};

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
    return merged;
  }

  getPluginStatuses(): PluginStatus[] {
    const result: PluginStatus[] = [];
    for (const [name, plugin] of this.loadedPlugins) {
      const representativeInstance = this.instances.values().next().value?.get(name);
      const assignedOperatorIds = plugin.definition.type === 'strategy'
        ? this.getAssignedOperatorIds(name)
        : [];
      result.push({
        ...toPluginStatus(plugin, representativeInstance),
        enabled: plugin.definition.type === 'utility'
          ? (representativeInstance?.enabled ?? this.resolveUtilityEnabled(name, plugin))
          : assignedOperatorIds.length > 0,
        assignedOperatorIds: plugin.definition.type === 'strategy' ? assignedOperatorIds : undefined,
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

  private getActiveInstances(operatorId: string): PluginInstance[] {
    const operatorInstances = this.instances.get(operatorId);
    if (!operatorInstances) return [];
    return Array.from(operatorInstances.values()).filter(
      (instance) => instance.plugin.definition.type === 'strategy'
        ? instance === this.getStrategyInstance(operatorId)
        : instance.enabled && !instance.autoDisabled,
    );
  }

  private getStrategyInstance(operatorId: string): PluginInstance | undefined {
    const strategyName = this.getResolvedStrategyName(operatorId);
    const instance = this.instances.get(operatorId)?.get(strategyName);
    if (instance?.enabled && !instance.autoDisabled) {
      return instance;
    }

    const fallback = this.instances.get(operatorId)?.get(BUILTIN_STANDARD_QSO_PLUGIN_NAME);
    if (fallback?.enabled && !fallback.autoDisabled) {
      return fallback;
    }

    return undefined;
  }

  private getStrategyRuntime(operatorId: string): StrategyRuntime | undefined {
    return this.getStrategyInstance(operatorId)?.runtime;
  }

  private resolvePluginActionTarget(pluginName: string, operatorId?: string): PluginInstance | undefined {
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
      validatePluginDefinition(builtin.definition);
      discoveredPlugins.set(builtin.definition.name, {
        definition: builtin.definition,
        isBuiltIn: true,
        locales: builtin.locales,
        dirPath: builtin.dirPath,
      });
    }

    const pluginDir = path.join(this.deps.dataDir, 'plugins');
    const userPlugins = await this.loader.scanAndLoad(pluginDir);
    for (const plugin of userPlugins) {
      if (discoveredPlugins.has(plugin.definition.name)) {
        logger.warn(`Plugin name conflict: ${plugin.definition.name} (user plugin cannot override built-in)`);
        continue;
      }
      discoveredPlugins.set(plugin.definition.name, plugin);
    }

    this.loadedPlugins = discoveredPlugins;
    logger.info(`Plugins discovered: ${Array.from(this.loadedPlugins.keys()).join(', ')}`);

    for (const operator of this.deps.getOperators()) {
      await this.initInstancesForOperator(operator.config.id);
    }
  }

  private async teardownAllInstances(): Promise<void> {
    for (const [operatorId, operatorInstances] of this.instances) {
      for (const [pluginName, instance] of operatorInstances) {
        if (!instance.enabled) continue;
        await this.deactivateInstance(operatorId, instance).catch((err) => {
          logger.warn(`Failed to deactivate plugin instance: plugin=${pluginName}, operator=${operatorId}`, err);
        });
      }
    }

    this.instances.clear();
    this.loadedPlugins.clear();
    this.orchestrator.clearAllDecisionStates();
  }

  private async performReload(reason: string, action: () => Promise<void>): Promise<void> {
    if (!this.running) {
      throw new Error('Plugin manager is not running');
    }

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

  private resetOperatorPluginRuntime(operatorId: string, reason: string): void {
    const runtime = this.getStrategyRuntime(operatorId);
    if (runtime) {
      try {
        runtime.reset(reason);
      } catch (err) {
        logger.warn(`Failed to reset strategy runtime: operator=${operatorId}`, err);
      }
    }
    this.orchestrator.clearDecisionState(operatorId);
    this.deps.resetOperatorRuntime(operatorId, reason);
  }

  private handleAutoDisable(pluginName: string, reason: string): void {
    if (!this.pluginsConfig.configs) {
      this.pluginsConfig.configs = {};
    }
    const existing = this.pluginsConfig.configs[pluginName] ?? { enabled: true, settings: {} };
    this.pluginsConfig.configs[pluginName] = { ...existing, enabled: false };
    logger.warn(`Plugin auto-disabled: ${pluginName}, reason: ${reason}`);
    this.bumpGeneration();
    this.broadcastStatusChanged(pluginName);
  }

  private broadcastPluginList(): void {
    const snapshot = this.getSnapshot();
    this.deps.eventEmitter.emit('pluginList', snapshot);
  }

  private broadcastStatusChanged(pluginName: string): void {
    const plugin = this.loadedPlugins.get(pluginName);
    if (!plugin) return;
    const firstInstance = this.instances.values().next().value?.get(pluginName);
    const status = {
      ...toPluginStatus(plugin, firstInstance),
      enabled: plugin.definition.type === 'utility'
        ? (firstInstance?.enabled ?? this.resolveUtilityEnabled(pluginName, plugin))
        : this.getAssignedOperatorIds(pluginName).length > 0,
      assignedOperatorIds: plugin.definition.type === 'strategy'
        ? this.getAssignedOperatorIds(pluginName)
        : undefined,
    };
    this.deps.eventEmitter.emit('pluginStatusChanged', {
      generation: this.systemState.generation,
      plugin: status,
    });
  }

  private async activateInstance(operatorId: string, instance: PluginInstance): Promise<void> {
    const hook = instance.plugin.definition.onLoad;
    if (!hook) return;
    try {
      await hook(instance.ctx);
    } catch (err) {
      logger.error(`onLoad error: plugin=${instance.plugin.definition.name}, operator=${operatorId}`, err);
    }
  }

  private async deactivateInstance(operatorId: string, instance: PluginInstance): Promise<void> {
    const hook = instance.plugin.definition.onUnload;
    if (hook) {
      try {
        await hook(instance.ctx);
      } catch (err) {
        logger.warn(`onUnload error: plugin=${instance.plugin.definition.name}, operator=${operatorId}`, err);
      }
    }
    instance.ctx.timers.clearAll();
    // PluginContextFactory 总是创建 PluginStorageProvider 实例（实现 FlushableKVStore）
    const globalStore = instance.ctx.store.global as FlushableKVStore;
    const operatorStore = instance.ctx.store.operator as FlushableKVStore;
    await globalStore.flush().catch(() => {});
    await operatorStore.flush().catch(() => {});
  }

  private registerEngineListeners(): void {
    const eventEmitter = this.eventEmitter;
    const onSlotStart = (slotInfo: SlotInfo, slotPack: SlotPack | null) => {
      void this.orchestrator.handleSlotStart(slotInfo, slotPack);
    };
    const onEncodeStart = (slotInfo: SlotInfo) => {
      this.orchestrator.handleEncodeStart(slotInfo);
    };

    eventEmitter.on('slotStart', onSlotStart);
    eventEmitter.on('encodeStart', onEncodeStart);
    this.unsubscribeFns.push(() => eventEmitter.off('slotStart', onSlotStart));
    this.unsubscribeFns.push(() => eventEmitter.off('encodeStart', onEncodeStart));
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
}
