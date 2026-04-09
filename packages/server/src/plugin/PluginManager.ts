import type {
  DigitalRadioEngineEvents,
  LogbookAnalysis,
  PluginStatus,
  PluginSystemSnapshot,
  PluginsConfig,
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
  FrameMessage,
  StrategyRuntimeContext,
} from '@tx5dr/contracts';
import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  PluginContext,
  StrategyDecisionMeta,
  StrategyRuntime,
  StrategyRuntimeSlot,
  StrategyRuntimeSnapshot,
} from '@tx5dr/plugin-api';
import type { EventEmitter } from 'eventemitter3';
import { PluginLoader, validatePluginDefinition } from './PluginLoader.js';
import { PluginHookDispatcher } from './PluginHookDispatcher.js';
import type { AutoCallProposalResult } from './PluginHookDispatcher.js';
import { evaluateAutomaticTargetEligibility } from './AutoTargetEligibility.js';
import { PluginContextFactory } from './PluginContextFactory.js';
import {
  BUILTIN_PLUGINS,
  BUILTIN_STANDARD_QSO_PLUGIN_NAME,
} from './builtins/index.js';
import { toPluginStatus, toPluginSystemSnapshot } from './types.js';
import type { LoadedPlugin, PluginInstance, PluginManagerDeps, PluginSystemRuntimeState } from './types.js';
import { createLogger } from '../utils/logger.js';
import path from 'path';
import { FT8MessageParser, CycleUtils } from '@tx5dr/core';

const logger = createLogger('PluginManager');

interface OperatorDecisionState {
  decisionInProgress: boolean;
  lastDecisionTransmission: string | null;
  lastDecisionMessageSet: Set<string> | null;
}

interface PluginManagerEvents extends DigitalRadioEngineEvents {
  encodeStart: (slotInfo: SlotInfo) => void;
  operatorSlotChanged: (data: { operatorId: string; slot: StrategyRuntimeSlot }) => void;
  operatorSlotContentChanged: (data: { operatorId: string; slot: StrategyRuntimeSlot; content: string }) => void;
}

function getParsedMessageSenderCallsign(message: ParsedFT8Message['message']): string | undefined {
  return 'senderCallsign' in message && typeof message.senderCallsign === 'string'
    ? message.senderCallsign.toUpperCase()
    : undefined;
}

function getParsedMessageGrid(message: ParsedFT8Message['message']): string | undefined {
  return 'grid' in message && typeof message.grid === 'string' && message.grid.trim().length > 0
    ? message.grid.trim().toUpperCase()
    : undefined;
}

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
  private contextFactory: PluginContextFactory;
  private loader = new PluginLoader();
  private running = false;
  private unsubscribeFns: Array<() => void> = [];
  private decisionStates = new Map<string, OperatorDecisionState>();
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
    this.contextFactory = new PluginContextFactory(deps);
    this.dispatcher = new PluginHookDispatcher(
      (operatorId) => this.getActiveInstances(operatorId),
      (operatorId) => this.getStrategyInstance(operatorId),
      (pluginName, reason) => this.handleAutoDisable(pluginName, reason),
    );
  }

  private get eventEmitter(): EventEmitter<PluginManagerEvents> {
    return this.deps.eventEmitter as unknown as EventEmitter<PluginManagerEvents>;
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
    this.getOrCreateDecisionState(operatorId);

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
    this.decisionStates.delete(operatorId);
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
    this.invalidateDecisionMessageSet(operatorId);
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
    this.invalidateDecisionMessageSet(operatorId);
    this.eventEmitter.emit('operatorSlotContentChanged', { operatorId, slot, content });
  }

  getCurrentTransmission(operatorId: string): string | null {
    return this.readCurrentTransmission(operatorId);
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

    this.invalidateDecisionMessageSet(operatorId);
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
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator || !operator.isTransmitting) {
      return false;
    }

    const session = this.getOrCreateDecisionState(operatorId);
    if (session.decisionInProgress) {
      return false;
    }

    const newMessageSet = this.buildDecisionMessageSet(slotPack, operatorId);
    if (session.lastDecisionMessageSet) {
      const hasNewMessage = Array.from(newMessageSet).some((message) => !session.lastDecisionMessageSet?.has(message));
      if (!hasNewMessage) {
        return false;
      }
    }

    const parsedMessages = await this.parseSlotPackMessages(slotPack, operatorId);
    const automaticTargetMessages = this.filterAutomaticTargetMessages(operatorId, parsedMessages);
    const filtered = await this.dispatcher.dispatchFilterCandidates(
      operatorId,
      automaticTargetMessages,
      (instance) => this.getCtxForInstance(instance),
    );
    const scored = await this.dispatcher.dispatchScoreCandidates(
      operatorId,
      filtered.map((message) => ({ ...message, score: 0 })),
      (instance) => this.getCtxForInstance(instance),
    );
    scored.sort((a, b) => b.score - a.score);

    let decisionStop = false;
    session.decisionInProgress = true;
    try {
      const decision = await this.invokeStrategyDecision(operatorId, scored, { isReDecision: true });
      decisionStop = decision?.stop ?? false;
    } finally {
      session.decisionInProgress = false;
    }

    if (decisionStop) {
      operator.stop();
      return false;
    }

    session.lastDecisionMessageSet = newMessageSet;
    const newTransmission = this.readCurrentTransmission(operatorId);
    if (newTransmission !== session.lastDecisionTransmission) {
      logger.info(`Late decode re-decision changed transmission: operator=${operatorId}`, {
        previousTransmission: session.lastDecisionTransmission,
        nextTransmission: newTransmission,
      });
      session.lastDecisionTransmission = newTransmission;
      return true;
    }

    return false;
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
    this.decisionStates.clear();
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
    this.clearDecisionState(operatorId);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.deps.eventEmitter as any).emit('pluginList', snapshot);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.deps.eventEmitter as any).emit('pluginStatusChanged', {
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
    const globalStore = instance.ctx.store.global as typeof instance.ctx.store.global & { flush?: () => Promise<void> };
    const operatorStore = instance.ctx.store.operator as typeof instance.ctx.store.operator & { flush?: () => Promise<void> };
    await globalStore.flush?.().catch(() => {});
    await operatorStore.flush?.().catch(() => {});
  }

  private registerEngineListeners(): void {
    const eventEmitter = this.eventEmitter;
    const onSlotStart = (slotInfo: SlotInfo, slotPack: SlotPack | null) => {
      void this.handleSlotStart(slotInfo, slotPack);
    };
    const onEncodeStart = (slotInfo: SlotInfo) => {
      this.handleEncodeStart(slotInfo);
    };

    eventEmitter.on('slotStart', onSlotStart);
    eventEmitter.on('encodeStart', onEncodeStart);
    this.unsubscribeFns.push(() => eventEmitter.off('slotStart', onSlotStart));
    this.unsubscribeFns.push(() => eventEmitter.off('encodeStart', onEncodeStart));
  }

  private unregisterEngineListeners(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];
  }

  private async handleSlotStart(slotInfo: SlotInfo, slotPack: SlotPack | null): Promise<void> {
    for (const operator of this.deps.getOperators()) {
      const parsedMessages = slotPack
        ? await this.parseSlotPackMessages(slotPack, operator.config.id)
        : [];

      await this.dispatcher.dispatchBroadcast(
        operator.config.id,
        'onSlotStart',
        (hook, ctx) => (hook as (slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContext) => void)(slotInfo, parsedMessages, ctx),
        (instance) => this.getCtxForInstance(instance),
      );

      await this.dispatcher.dispatchBroadcast(
        operator.config.id,
        'onDecode',
        (hook, ctx) => (hook as (messages: ParsedFT8Message[], ctx: PluginContext) => void)(parsedMessages, ctx),
        (instance) => this.getCtxForInstance(instance),
      );

      const autoCallProposals = await this.dispatcher.dispatchAutoCallCandidates(
        operator.config.id,
        slotInfo,
        parsedMessages,
        (instance) => this.getCtxForInstance(instance),
      );
      await this.applyAutoCallProposal(operator.config.id, slotInfo, parsedMessages, autoCallProposals);

      if (!operator.isTransmitting) continue;

      const session = this.getOrCreateDecisionState(operator.config.id);
      session.lastDecisionTransmission = null;
      session.lastDecisionMessageSet = null;
      const automaticTargetMessages = this.filterAutomaticTargetMessages(operator.config.id, parsedMessages);

      const filtered = await this.dispatcher.dispatchFilterCandidates(
        operator.config.id,
        automaticTargetMessages,
        (instance) => this.getCtxForInstance(instance),
      );
      const scored = await this.dispatcher.dispatchScoreCandidates(
        operator.config.id,
        filtered.map((message) => ({ ...message, score: 0 })),
        (instance) => this.getCtxForInstance(instance),
      );
      scored.sort((a, b) => b.score - a.score);

      let decision;
      session.decisionInProgress = true;
      try {
        decision = await this.invokeStrategyDecision(operator.config.id, scored, { isReDecision: false });
      } finally {
        session.decisionInProgress = false;
      }

      if (slotPack) {
        session.lastDecisionMessageSet = this.buildDecisionMessageSet(slotPack, operator.config.id);
      }
      session.lastDecisionTransmission = this.readCurrentTransmission(operator.config.id);

      if (decision?.stop) {
        operator.stop();
      }
    }
  }

  private handleEncodeStart(slotInfo: SlotInfo): void {
    for (const operator of this.deps.getOperators()) {
      if (!operator.isTransmitting) continue;

      const isTransmitSlot = CycleUtils.isOperatorTransmitCycle(
        operator.getTransmitCycles(),
        slotInfo.utcSeconds,
        operator.config.mode.slotMs,
      );
      if (!isTransmitSlot) continue;

      const runtime = this.getStrategyRuntime(operator.config.id);
      if (!runtime) continue;

      try {
        const transmission = runtime.getTransmitText();
        if (!transmission) continue;
        this.eventEmitter.emit('requestTransmit', {
          operatorId: operator.config.id,
          transmission,
        });
        this.notifyTransmissionQueued(operator.config.id, transmission);
      } catch (err) {
        logger.error(`strategy runtime getTransmitText error: operator=${operator.config.id}`, err);
      }
    }
  }

  private async parseSlotPackMessages(slotPack: SlotPack, operatorId: string): Promise<ParsedFT8Message[]> {
    const LOCAL_OPERATOR_SIMULATED_SNR = 10;
    return Promise.all(slotPack.frames.map(async (frame) => {
      const parsedMessage: ParsedFT8Message = {
        message: FT8MessageParser.parseMessage(frame.message),
        snr: frame.snr === -999 && frame.operatorId === operatorId ? LOCAL_OPERATOR_SIMULATED_SNR : frame.snr,
        dt: frame.dt,
        df: frame.freq,
        rawMessage: frame.message,
        slotId: slotPack.slotId,
        timestamp: slotPack.startMs,
        logbookAnalysis: frame.logbookAnalysis,
      };

      if (frame.snr === -999) {
        return parsedMessage;
      }

      const analysis = await this.analyzeMessageForOperator(parsedMessage, operatorId);
      return {
        ...parsedMessage,
        logbookAnalysis: analysis ?? parsedMessage.logbookAnalysis,
      };
    }));
  }

  private async analyzeMessageForOperator(
    parsedMessage: ParsedFT8Message,
    operatorId: string,
  ): Promise<LogbookAnalysis | undefined> {
    if (!this.deps.analyzeCallsignForOperator) {
      return parsedMessage.logbookAnalysis;
    }

    const callsign = getParsedMessageSenderCallsign(parsedMessage.message);
    if (!callsign) {
      return parsedMessage.logbookAnalysis;
    }

    const grid = getParsedMessageGrid(parsedMessage.message);
    try {
      return await this.deps.analyzeCallsignForOperator(operatorId, callsign, grid)
        ?? parsedMessage.logbookAnalysis;
    } catch (error) {
      logger.warn(`Failed to analyze parsed message for operator ${operatorId}`, error);
      return parsedMessage.logbookAnalysis;
    }
  }

  private isOperatorPureStandby(operatorId: string): boolean {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator || operator.isTransmitting) {
      return false;
    }

    const automation = this.deps.getOperatorAutomationSnapshot(operatorId);
    if (!automation) {
      return true;
    }

    const targetCallsign = typeof automation.context?.targetCallsign === 'string'
      ? automation.context.targetCallsign.trim()
      : '';
    return automation.currentState === 'TX6' && targetCallsign.length === 0;
  }

  private findMatchedParsedMessage(
    lastMessage: { message: FrameMessage; slotInfo: SlotInfo } | undefined,
    messages: ParsedFT8Message[],
  ): ParsedFT8Message | undefined {
    if (!lastMessage) {
      return undefined;
    }

    return messages.find((message) => (
      message.rawMessage === lastMessage.message.message
      && message.df === lastMessage.message.freq
      && message.dt === lastMessage.message.dt
    )) ?? messages.find((message) => (
      message.rawMessage === lastMessage.message.message
    ));
  }

  private findProposalSourceMessage(
    proposal: AutoCallProposalResult['proposal'],
    messages: ParsedFT8Message[],
  ): ParsedFT8Message | undefined {
    const exactMatch = this.findMatchedParsedMessage(proposal.lastMessage, messages);
    if (exactMatch) {
      return exactMatch;
    }

    const proposalCallsign = proposal.callsign.trim().toUpperCase();
    return messages.find((message) => getParsedMessageSenderCallsign(message.message) === proposalCallsign);
  }

  private filterAutomaticTargetMessages(
    operatorId: string,
    messages: ParsedFT8Message[],
  ): ParsedFT8Message[] {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return messages;
    }

    return messages.filter((message) => {
      const decision = evaluateAutomaticTargetEligibility(operator.config.myCallsign, message);
      if (decision.eligible) {
        return true;
      }

      logger.debug('Automatic target message filtered by CQ modifier eligibility', {
        operatorId,
        callsign: getParsedMessageSenderCallsign(message.message),
        modifier: decision.modifier,
        reason: decision.reason,
        rawMessage: message.rawMessage,
      });
      return false;
    });
  }

  private isAutoCallProposalEligible(
    operatorId: string,
    entry: AutoCallProposalResult,
    messages: ParsedFT8Message[],
  ): boolean {
    const operator = this.deps.getOperatorById(operatorId);
    if (!operator) {
      return false;
    }

    const sourceMessage = this.findProposalSourceMessage(entry.proposal, messages);
    if (!sourceMessage) {
      logger.debug('Auto call proposal could not be validated against a source message, keeping proposal for compatibility', {
        operatorId,
        pluginName: entry.pluginName,
        callsign: entry.proposal.callsign,
      });
      return true;
    }

    const decision = evaluateAutomaticTargetEligibility(operator.config.myCallsign, sourceMessage);
    if (decision.eligible) {
      return true;
    }

    logger.info('Auto call proposal rejected by CQ modifier eligibility', {
      operatorId,
      pluginName: entry.pluginName,
      callsign: entry.proposal.callsign,
      modifier: decision.modifier,
      reason: decision.reason,
      rawMessage: sourceMessage.rawMessage,
    });
    return false;
  }

  private buildSourceSlotInfoFromParsedMessage(
    operatorId: string,
    parsedMessage: ParsedFT8Message,
    fallbackSlotInfo: SlotInfo,
  ): SlotInfo {
    const operatorMode = this.deps.getOperatorById(operatorId)?.config.mode;
    if (!operatorMode) {
      return fallbackSlotInfo;
    }

    const startMs = parsedMessage.timestamp;
    const utcSeconds = Math.floor(startMs / 1000);
    const cycleNumber = CycleUtils.calculateCycleNumber(utcSeconds, operatorMode.slotMs);

    return {
      id: parsedMessage.slotId,
      startMs,
      utcSeconds,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber,
      mode: operatorMode.name,
    };
  }

  private normalizeAutoCallProposal(
    operatorId: string,
    currentSlotInfo: SlotInfo,
    messages: ParsedFT8Message[],
    entry: AutoCallProposalResult,
  ): AutoCallProposalResult {
    const matchedMessage = this.findMatchedParsedMessage(entry.proposal.lastMessage, messages);
    if (!matchedMessage || !entry.proposal.lastMessage) {
      return entry;
    }

    return {
      ...entry,
      proposal: {
        ...entry.proposal,
        lastMessage: {
          ...entry.proposal.lastMessage,
          slotInfo: this.buildSourceSlotInfoFromParsedMessage(operatorId, matchedMessage, currentSlotInfo),
        },
      },
    };
  }

  private resolveProposalMessageOrder(
    proposal: AutoCallProposalResult['proposal'],
    messages: ParsedFT8Message[],
  ): number {
    const lastMessage = proposal.lastMessage;
    if (!lastMessage) {
      return Number.MAX_SAFE_INTEGER;
    }

    const exactIndex = messages.findIndex((message) => (
      message.rawMessage === lastMessage.message.message
      && message.df === lastMessage.message.freq
      && message.dt === lastMessage.message.dt
    ));
    if (exactIndex >= 0) {
      return exactIndex;
    }

    const rawIndex = messages.findIndex((message) => (
      message.rawMessage === lastMessage.message.message
    ));
    return rawIndex >= 0 ? rawIndex : Number.MAX_SAFE_INTEGER;
  }

  private async resolveAutoCallExecutionPlan(
    operatorId: string,
    request: AutoCallExecutionRequest,
  ): Promise<AutoCallExecutionPlan> {
    return this.dispatcher.dispatchAutoCallExecutionPlan(
      operatorId,
      request,
      {},
      (instance) => this.getCtxForInstance(instance),
    );
  }

  private async applyAutoCallExecutionPlan(
    operatorId: string,
    request: AutoCallExecutionRequest,
    plan: AutoCallExecutionPlan,
  ): Promise<void> {
    if (!this.deps.setOperatorAudioFrequency) {
      return;
    }

    const requestedFrequency = plan.audioFrequency;
    if (typeof requestedFrequency !== 'number' || !Number.isFinite(requestedFrequency)) {
      return;
    }

    const operator = this.deps.getOperatorById(operatorId);
    if (operator && operator.config.frequency === requestedFrequency) {
      return;
    }

    try {
      await this.deps.setOperatorAudioFrequency(operatorId, requestedFrequency);
      logger.info('Auto call execution plan applied audio frequency', {
        operatorId,
        slotId: request.slotInfo.id,
        callsign: request.callsign,
        frequency: requestedFrequency,
      });
    } catch (error) {
      logger.warn(`Failed to apply auto call execution plan for operator ${operatorId}`, error);
    }
  }

  private async applyAutoCallProposal(
    operatorId: string,
    slotInfo: SlotInfo,
    messages: ParsedFT8Message[],
    proposals: AutoCallProposalResult[],
  ): Promise<void> {
    if (proposals.length === 0 || !this.isOperatorPureStandby(operatorId)) {
      return;
    }

    const ranked = proposals
      .filter((entry) => this.isAutoCallProposalEligible(operatorId, entry, messages))
      .map((entry) => this.normalizeAutoCallProposal(operatorId, slotInfo, messages, entry))
      .map((entry) => ({
        ...entry,
        priority: typeof entry.proposal.priority === 'number' ? entry.proposal.priority : 0,
        messageOrder: this.resolveProposalMessageOrder(entry.proposal, messages),
      }))
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        if (left.messageOrder !== right.messageOrder) {
          return left.messageOrder - right.messageOrder;
        }
        return left.pluginName.localeCompare(right.pluginName);
      });

    const winner = ranked[0];
    if (!winner) {
      return;
    }

    if (ranked.length > 1) {
      logger.info('Auto call proposals arbitrated', {
        operatorId,
        selectedPlugin: winner.pluginName,
        selectedCallsign: winner.proposal.callsign,
        candidateCount: ranked.length,
      });
    }

    logger.info('Auto call proposal accepted', {
      operatorId,
      pluginName: winner.pluginName,
      callsign: winner.proposal.callsign,
      priority: winner.priority,
    });

    const request: AutoCallExecutionRequest = {
      sourcePluginName: winner.pluginName,
      callsign: winner.proposal.callsign,
      slotInfo,
      lastMessage: winner.proposal.lastMessage,
    };
    const executionPlan = await this.resolveAutoCallExecutionPlan(operatorId, request);
    await this.applyAutoCallExecutionPlan(operatorId, request, executionPlan);
    this.requestCall(operatorId, request.callsign, request.lastMessage);
  }

  private getOrCreateDecisionState(operatorId: string): OperatorDecisionState {
    let state = this.decisionStates.get(operatorId);
    if (!state) {
      state = {
        decisionInProgress: false,
        lastDecisionTransmission: null,
        lastDecisionMessageSet: null,
      };
      this.decisionStates.set(operatorId, state);
    }
    return state;
  }

  private clearDecisionState(operatorId: string): void {
    this.decisionStates.set(operatorId, {
      decisionInProgress: false,
      lastDecisionTransmission: null,
      lastDecisionMessageSet: null,
    });
  }

  invalidateDecisionMessageSet(operatorId: string): void {
    const state = this.getOrCreateDecisionState(operatorId);
    state.lastDecisionMessageSet = null;
  }

  private buildDecisionMessageSet(slotPack: SlotPack, operatorId: string): Set<string> {
    return new Set(
      slotPack.frames
        .filter((frame) => !(frame.snr === -999 && frame.operatorId === operatorId))
        .map((frame) => frame.message),
    );
  }

  private async invokeStrategyDecision(
    operatorId: string,
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMeta,
  ): Promise<{ stop?: boolean } | null> {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) {
      return null;
    }

    const result = runtime.decide(messages, meta);
    return result instanceof Promise ? await result : result;
  }

  private readCurrentTransmission(operatorId: string): string | null {
    const runtime = this.getStrategyRuntime(operatorId);
    if (!runtime) {
      return null;
    }

    try {
      return runtime.getTransmitText() ?? null;
    } catch (err) {
      logger.error(`Failed to read current transmission: operator=${operatorId}`, err);
      return null;
    }
  }
}
