import type {
  AnyPluginDefinition,
  RuntimePluginContext,
  PluginOperatorCommand,
  PluginOperatorCommandResult,
  StrategyRuntime,
  KVStore,
  PluginUIInstanceTarget,
} from '@tx5dr/plugin-api';
import type { PluginEventBusHost } from './PluginEventBusHost.js';
import type {
  PluginPanelMetaPayload,
  PluginUIPanelContributionGroup,
  PluginSource,
  PluginStatus,
  PluginSystemSnapshot,
  PluginSystemState,
  CapabilityList,
  CapabilityValue,
  EngineMode,
  RadioPowerResponse,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
  WriteCapabilityPayload,
} from '@tx5dr/contracts';

/**
 * 内部 KVStore 扩展，暴露 flush() 供宿主生命周期管理使用。
 * 不导出到 plugin-api 公共接口。
 */
export interface FlushableKVStore extends KVStore {
  flush(): Promise<void>;
  dispose?(): void;
}

/**
 * 已加载的插件（内存中的运行时表示）
 */
export interface LoadedPlugin {
  definition: AnyPluginDefinition;
  /** 是否为内置插件（不可禁用、不来自文件系统） */
  isBuiltIn: boolean;
  /** 插件目录路径（内置插件若有 UI 文件也需提供） */
  dirPath?: string;
  /** 插件来源声明，由宿主扫描插件目录后读取 */
  source?: PluginSource;
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
  ctx: RuntimePluginContext;
  /** Unguarded context retained only for host-owned teardown. */
  rawCtx: RuntimePluginContext;
  /** strategy 插件的显式运行时 */
  runtime?: StrategyRuntime;
  /** Monotonic host generation used to revoke stale async continuations. */
  generation: number;
  /** Host-owned lifecycle gate. Only `active` instances may accept new ingress. */
  lifecycle: 'inactive' | 'starting' | 'active' | 'stopping' | 'quarantined' | 'disposed';
  /** Serializes enable, disable, reload and teardown for this instance. */
  lifecycleTail: Promise<void>;
  /** Latest requested lifecycle state; queued transitions reconcile to this value. */
  desiredLifecycle: 'active' | 'inactive' | 'disposed';
  /** Monotonic request generation used to tombstone obsolete transitions. */
  lifecycleRevision: number;
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
  lastDecisionTransmission: string | null;
  lastDecisionMessageSet: Set<string> | null;
  /** handleEncodeStart 已排队的发射文本（用于检测 slotStart/encodeStart 竞态） */
  preDecisionEncodedTransmission?: string;
}

export interface TransmissionRefreshOptions {
  source?: 'late-decode' | 'operator-edit' | 'plugin';
  reason?: string;
  decisionEpoch?: number;
}

/**
 * DecisionOrchestrator 所需依赖
 */
export interface DecisionOrchestratorDeps {
  getOperators: () => import('@tx5dr/core').RadioOperator[];
  getOperatorById: (id: string) => import('@tx5dr/core').RadioOperator | undefined;
  /**
   * 当前引擎模式 — **唯一权威来源**。切勿使用 operator.config.mode（它在创建后不会随引擎 setMode
   * 而更新，FT8↔FT4 切换后会带来错误的 slotMs，导致周期判断按错误的时隙长度进行）。
   */
  getCurrentMode: () => import('@tx5dr/contracts').ModeDescriptor;
  getOperatorAutomationSnapshot: (id: string) => import('@tx5dr/plugin-api').StrategyRuntimeSnapshot | null;
  interruptOperatorTransmission: (operatorId: string) => Promise<void>;
  requestOperatorStrategyStop?: (operatorId: string, reason: string) => void;
  transitionTargetReservation?: (operatorId: string, epoch: number, targetCallsign?: string) => boolean;
  transitionTargetReservations?: (
    operatorId: string,
    epoch: number,
    targets: Array<{ streamId: string; targetCallsign: string }>,
  ) => boolean;
  releaseTargetReservation?: (operatorId: string, epoch?: number) => void;
  analyzeCallsignForOperator?: (
    operatorId: string,
    callsign: string,
    grid?: string,
  ) => Promise<import('@tx5dr/contracts').LogbookAnalysis | null>;
  resolveGrid?: (callsign: string) => string | undefined;
  setOperatorAudioFrequency?: (
    operatorId: string,
    frequency: number,
    commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
  ) => Promise<void>;
  isSnrPriorityEnabled?: (operatorId: string) => boolean;
  isStoppedDirectCallAutoReplyEnabled?: (operatorId: string) => boolean;
  hasTargetQueue?: (operatorId: string) => boolean;
  observeStrategyMessages?: (
    operatorId: string,
    messages: import('@tx5dr/contracts').ParsedFT8Message[],
    slotInfo: import('@tx5dr/contracts').SlotInfo,
    source: import('@tx5dr/plugin-api').StrategyDecisionSource,
    token: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
    signal: AbortSignal,
  ) => boolean;
  notifyOperatorStatusChanged?: (operatorId: string) => void;
  isQueueExecutionSuspended?: (operatorId: string) => boolean;
  markQueueExecutionValidated?: (operatorId: string) => void;
  getStrategyRuntime: (operatorId: string) => import('@tx5dr/plugin-api').StrategyRuntime | undefined;
  getStrategyRuntimeGeneration: (operatorId: string) => number | undefined;
  getStrategyMaxConcurrentStreams?: (operatorId: string) => number | undefined;
  getEffectiveOperatorMaxConcurrentStreams?: (operatorId: string) => number;
  invokeStrategyRuntime: <T>(
    operatorId: string,
    operation: string,
    callback: (runtime: import('@tx5dr/plugin-api').StrategyRuntime) => T | Promise<T>,
    options?: { signal?: AbortSignal },
  ) => Promise<T | undefined>;
  invokeStrategyRuntimeSync: <T>(
    operatorId: string,
    operation: string,
    callback: (runtime: import('@tx5dr/plugin-api').StrategyRuntime) => T,
  ) => T | undefined;
  getCtxForInstance: (instance: PluginInstance) => RuntimePluginContext;
  dispatcher: import('./PluginHookDispatcher.js').PluginHookDispatcher;
  eventEmitter: import('eventemitter3').EventEmitter<import('@tx5dr/contracts').DigitalRadioEngineEvents>;
  requestCall: (
    operatorId: string,
    callsign: string,
    lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo },
    options?: { commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken },
  ) => void;
  notifyQSOFail: (
    operatorId: string,
    info: import('@tx5dr/plugin-api').QSOFailureInfo,
  ) => Promise<void>;
  /** 触发操作员重新编码（用于 slotStart/encodeStart 竞态修正） */
  triggerReEncode?: (operatorId: string, options?: TransmissionRefreshOptions) => void;
  intentCoordinator: import('../transmission/OperatorIntentCoordinator.js').OperatorIntentCoordinator;
}

/**
 * PluginManager 所需依赖
 */
export interface PluginManagerDeps {
  eventEmitter: import('eventemitter3').EventEmitter<import('@tx5dr/contracts').DigitalRadioEngineEvents>;
  getOperators: () => import('@tx5dr/core').RadioOperator[];
  getOperatorById: (id: string) => import('@tx5dr/core').RadioOperator | undefined;
  /** 见 DecisionOrchestratorDeps.getCurrentMode 的注释 */
  getCurrentMode: () => import('@tx5dr/contracts').ModeDescriptor;
  preflightDigitalMessage?: (
    request: import('@tx5dr/plugin-api').DigitalMessagePreflightRequest,
  ) => Promise<import('@tx5dr/plugin-api').DigitalMessagePreflightResult>;
  getOperatorAutomationSnapshot: (id: string) => import('@tx5dr/plugin-api').StrategyRuntimeSnapshot | null;
  requestOperatorCall: (
    operatorId: string,
    callsign: string,
    lastMessage?: { message: import('@tx5dr/contracts').FrameMessage; slotInfo: import('@tx5dr/contracts').SlotInfo },
  ) => void;
  notifyOperatorStatusChanged?: (operatorId: string) => void;
  getRadioFrequency: () => Promise<number | null>;
  getKnownRadioFrequency?: () => number | null;
  getEngineMode?: () => EngineMode;
  getCurrentRadioMode?: () => string | null;
  setRadioFrequency: (freq: number) => void | boolean | Promise<boolean | void>;
  submitRadioMaintenanceCommand?: (
    command: import('@tx5dr/plugin-api').PluginRadioCommand
      | import('@tx5dr/plugin-api').PluginRadioTunerCommand,
  ) => Promise<void>;
  getRadioBand: () => string;
  getRadioConnected: () => boolean;
  getRadioCapabilitySnapshot?: () => CapabilityList;
  refreshRadioCapabilities?: () => Promise<CapabilityList>;
  writeRadioCapability?: (payload: WriteCapabilityPayload & { value?: CapabilityValue }) => Promise<void>;
  getRadioPowerSupport?: (profileId?: string) => Promise<RadioPowerSupportInfo>;
  getRadioPowerState?: (profileId?: string) => RadioPowerStateEvent | null;
  setRadioPower?: (
    state: RadioPowerTarget,
    options?: { profileId?: string; autoEngine?: boolean },
  ) => Promise<RadioPowerResponse>;
  getLatestSlotPack: (operatorId?: string) => import('@tx5dr/contracts').SlotPack | null;
  findBestTransmitFrequency?: (
    slotId: string,
    minFreq?: number,
    maxFreq?: number,
    guardBandwidth?: number,
    additionalOccupiedFrequenciesHz?: readonly number[],
  ) => number | undefined;
  setOperatorAudioFrequency?: (
    operatorId: string,
    frequency: number,
    commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken,
  ) => Promise<void>;
  interruptOperatorTransmission: (operatorId: string) => Promise<void>;
  requestOperatorStrategyStop?: (operatorId: string, reason: string) => void;
  transitionTargetReservation?: (operatorId: string, epoch: number, targetCallsign?: string) => boolean;
  transitionTargetReservations?: (
    operatorId: string,
    epoch: number,
    targets: Array<{ streamId: string; targetCallsign: string }>,
  ) => boolean;
  releaseTargetReservation?: (operatorId: string, epoch?: number) => void;
  removeOperatorContribution?: (
    operatorId: string,
    options: {
      signal: AbortSignal;
      commandToken: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
    },
  ) => Promise<void>;
  submitOperatorCommand?: (
    operatorId: string,
    command: PluginOperatorCommand,
    pluginName: string,
  ) => Promise<PluginOperatorCommandResult>;
  hasWorkedCallsign: (operatorId: string, callsign: string, options?: { anyBand?: boolean }) => Promise<boolean>;
  hasWorkedDXCC?: (operatorId: string, dxccEntity: string) => Promise<boolean>;
  hasWorkedGrid?: (operatorId: string, grid: string) => Promise<boolean>;
  analyzeCallsignForOperator?: (
    operatorId: string,
    callsign: string,
    grid?: string,
  ) => Promise<import('@tx5dr/contracts').LogbookAnalysis | null>;
  resolveGrid?: (callsign: string) => string | undefined;
  resetOperatorRuntime: (operatorId: string, reason: string) => void;
  /** 将已更新的操作员上下文提交给当前数字帧。 */
  triggerReEncode?: (operatorId: string, options?: TransmissionRefreshOptions) => void;
  intentCoordinator?: import('../transmission/OperatorIntentCoordinator.js').OperatorIntentCoordinator;
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
  pluginEventBusHost?: PluginEventBusHost;
}

/**
 * 将 LoadedPlugin + 运行时状态合并为 PluginStatus（用于推送前端）
 */
export function toPluginStatus(plugin: LoadedPlugin, instance?: PluginInstance): PluginStatus {
  const capabilities: PluginStatus['capabilities'] = [];
  if (plugin.definition.isAutoCallEnabled) {
    capabilities.push('auto_call_control');
  }
  if (plugin.definition.hooks?.onAutoCallCandidate) {
    capabilities.push('auto_call_candidate');
  }
  if (plugin.definition.hooks?.onConfigureAutoCallExecution) {
    capabilities.push('auto_call_execution');
  }

  return {
    name: plugin.definition.name,
    type: plugin.definition.type,
    strategyFeatures: plugin.definition.strategyFeatures,
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
    permissions: plugin.definition.permissions ? [...plugin.definition.permissions] : undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    ui: plugin.definition.ui ? {
      dir: plugin.definition.ui.dir ?? 'ui',
      pages: plugin.definition.ui.pages ?? [],
    } : undefined,
    locales: plugin.locales,
    source: plugin.source,
  };
}

export function toPluginSystemSnapshot(
  state: PluginSystemRuntimeState,
  plugins: PluginStatus[],
  panelMeta: PluginPanelMetaPayload[],
  panelContributions: PluginUIPanelContributionGroup[],
): PluginSystemSnapshot {
  return {
    state: state.state,
    generation: state.generation,
    lastError: state.lastError,
    plugins,
    panelMeta,
    panelContributions,
  };
}
