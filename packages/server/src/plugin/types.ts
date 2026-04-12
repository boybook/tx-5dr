import type {
  PluginDefinition,
  PluginContext,
  StrategyRuntime,
  KVStore,
  PluginUIInstanceTarget,
} from '@tx5dr/plugin-api';
import type { PluginStatus, PluginSystemSnapshot, PluginSystemState } from '@tx5dr/contracts';

/**
 * 内部 KVStore 扩展，暴露 flush() 供宿主生命周期管理使用。
 * 不导出到 plugin-api 公共接口。
 */
export interface FlushableKVStore extends KVStore {
  flush(): Promise<void>;
}

/**
 * 已加载的插件（内存中的运行时表示）
 */
export interface LoadedPlugin {
  definition: PluginDefinition;
  /** 是否为内置插件（不可禁用、不来自文件系统） */
  isBuiltIn: boolean;
  /** 插件目录路径（内置插件若有 UI 文件也需提供） */
  dirPath?: string;
  /** 插件加载的 i18n 资源 */
  locales?: Record<string, Record<string, string>>;
}

/**
 * 插件实例 — 运行期间为每个操作员维护一个
 */
export interface PluginInstance {
  plugin: LoadedPlugin;
  scope: { kind: 'operator'; operatorId: string } | { kind: 'global' };
  /** 当前操作员的 PluginContext */
  ctx: PluginContext;
  /** strategy 插件的显式运行时 */
  runtime?: StrategyRuntime;
  /** 是否已启用（enabled in config） */
  enabled: boolean;
  /** 连续错误计数（按 hook 名统计） */
  errorCounts: Map<string, number>;
  /** 是否已被自动禁用（由错误追踪触发） */
  autoDisabled: boolean;
  /** 最近一次错误信息 */
  lastError?: string;
}

export interface PluginSystemRuntimeState {
  state: PluginSystemState;
  generation: number;
  lastError?: string;
}

/**
 * 操作员决策状态 — 由 DecisionOrchestrator 管理
 */
export interface OperatorDecisionState {
  decisionInProgress: boolean;
  lastDecisionTransmission: string | null;
  lastDecisionMessageSet: Set<string> | null;
}

/**
 * DecisionOrchestrator 所需依赖
 */
export interface DecisionOrchestratorDeps {
  getOperators: () => import('@tx5dr/core').RadioOperator[];
  getOperatorById: (id: string) => import('@tx5dr/core').RadioOperator | undefined;
  getOperatorAutomationSnapshot: (id: string) => import('@tx5dr/plugin-api').StrategyRuntimeSnapshot | null;
  interruptOperatorTransmission: (operatorId: string) => Promise<void>;
  analyzeCallsignForOperator?: (
    operatorId: string,
    callsign: string,
    grid?: string,
  ) => Promise<import('@tx5dr/contracts').LogbookAnalysis | null>;
  setOperatorAudioFrequency?: (operatorId: string, frequency: number) => Promise<void>;
  getStrategyRuntime: (operatorId: string) => import('@tx5dr/plugin-api').StrategyRuntime | undefined;
  getCtxForInstance: (instance: PluginInstance) => PluginContext;
  dispatcher: import('./PluginHookDispatcher.js').PluginHookDispatcher;
  eventEmitter: import('eventemitter3').EventEmitter<import('@tx5dr/contracts').DigitalRadioEngineEvents>;
  requestCall: (
    operatorId: string,
    callsign: string,
    lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo },
  ) => void;
  notifyTransmissionQueued: (operatorId: string, transmission: string) => void;
}

/**
 * PluginManager 所需依赖
 */
export interface PluginManagerDeps {
  eventEmitter: import('eventemitter3').EventEmitter<import('@tx5dr/contracts').DigitalRadioEngineEvents>;
  getOperators: () => import('@tx5dr/core').RadioOperator[];
  getOperatorById: (id: string) => import('@tx5dr/core').RadioOperator | undefined;
  getOperatorAutomationSnapshot: (id: string) => import('@tx5dr/plugin-api').StrategyRuntimeSnapshot | null;
  requestOperatorCall: (
    operatorId: string,
    callsign: string,
    lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo },
  ) => void;
  getRadioFrequency: () => Promise<number | null>;
  setRadioFrequency: (freq: number) => void;
  getRadioBand: () => string;
  getRadioConnected: () => boolean;
  getLatestSlotPack: (operatorId?: string) => import('@tx5dr/contracts').SlotPack | null;
  findBestTransmitFrequency?: (
    slotId: string,
    minFreq?: number,
    maxFreq?: number,
    guardBandwidth?: number,
  ) => number | undefined;
  setOperatorAudioFrequency?: (operatorId: string, frequency: number) => Promise<void>;
  interruptOperatorTransmission: (operatorId: string) => Promise<void>;
  hasWorkedCallsign: (operatorId: string, callsign: string) => Promise<boolean>;
  hasWorkedDXCC?: (operatorId: string, dxccEntity: string) => Promise<boolean>;
  hasWorkedGrid?: (operatorId: string, grid: string) => Promise<boolean>;
  analyzeCallsignForOperator?: (
    operatorId: string,
    callsign: string,
    grid?: string,
  ) => Promise<import('@tx5dr/contracts').LogbookAnalysis | null>;
  resetOperatorRuntime: (operatorId: string, reason: string) => void;
  dataDir: string;
  /** Optional callback for logbook sync provider registration. */
  registerLogbookSyncProvider?: (
    pluginName: string,
    provider: import('@tx5dr/plugin-api').LogbookSyncProvider,
  ) => void;
  listPluginPageSessions?: (
    pluginName: string,
    instanceTarget: PluginUIInstanceTarget,
    pageId?: string,
  ) => import('./PluginPageSessionStore.js').PluginPageSession[];
}

/**
 * 将 LoadedPlugin + 运行时状态合并为 PluginStatus（用于推送前端）
 */
export function toPluginStatus(plugin: LoadedPlugin, instance?: PluginInstance): PluginStatus {
  const capabilities: PluginStatus['capabilities'] = [];
  if (plugin.definition.hooks?.onAutoCallCandidate) {
    capabilities.push('auto_call_candidate');
  }
  if (plugin.definition.hooks?.onConfigureAutoCallExecution) {
    capabilities.push('auto_call_execution');
  }

  return {
    name: plugin.definition.name,
    type: plugin.definition.type,
    instanceScope: plugin.definition.instanceScope ?? 'operator',
    version: plugin.definition.version,
    description: plugin.definition.description,
    isBuiltIn: plugin.isBuiltIn,
    loaded: true,
    enabled: instance?.enabled ?? false,
    autoDisabled: instance?.autoDisabled ?? false,
    errorCount: instance
      ? Array.from(instance.errorCounts.values()).reduce((sum, c) => sum + c, 0)
      : 0,
    lastError: instance?.lastError,
    settings: plugin.definition.settings,
    quickActions: plugin.definition.quickActions,
    quickSettings: plugin.definition.quickSettings,
    panels: plugin.definition.panels,
    permissions: plugin.definition.permissions,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    ui: plugin.definition.ui ? {
      dir: plugin.definition.ui.dir ?? 'ui',
      pages: plugin.definition.ui.pages ?? [],
    } : undefined,
    locales: plugin.locales,
  };
}

export function toPluginSystemSnapshot(
  state: PluginSystemRuntimeState,
  plugins: PluginStatus[],
): PluginSystemSnapshot {
  return {
    state: state.state,
    generation: state.generation,
    lastError: state.lastError,
    plugins,
  };
}
