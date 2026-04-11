/**
 * Stable public development surface for TX-5DR plugins.
 *
 * Plugin authors should import from this package instead of reaching into
 * internal monorepo packages. The package intentionally combines:
 * - plugin-specific contracts such as {@link PluginDefinition};
 * - runtime helper interfaces such as {@link PluginContext};
 * - a curated subset of shared radio/message types re-exported from
 *   `@tx5dr/contracts`.
 *
 * Typical usage:
 *
 * ```ts
 * import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
 * ```
 *
 * ```js
 * /** @type {import('@tx5dr/plugin-api').PluginDefinition} *\/
 * export default { ... };
 * ```
 */

/** Core plugin definition and lifecycle interfaces. */
export type { PluginDefinition } from './definition.js';
export type { PluginContext } from './context.js';
export type {
  PluginHooks,
  AutoCallProposal,
  AutoCallExecutionRequest,
  AutoCallExecutionPlan,
  ScoredCandidate,
  StrategyDecision,
  StrategyDecisionMeta,
  LastMessageInfo,
} from './hooks.js';
export type {
  StrategyRuntime,
  StrategyRuntimeContext,
  StrategyRuntimeSnapshot,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
} from './runtime.js';

/** Host-provided helper interfaces available through {@link PluginContext}. */
export type {
  KVStore,
  PluginLogger,
  PluginTimers,
  OperatorControl,
  RadioControl,
  LogbookAccess,
  BandAccess,
  IdleTransmitFrequencyOptions,
  AutoTargetEligibilityReason,
  AutoTargetEligibilityDecision,
  UIBridge,
} from './helpers.js';

/** Common radio/message/settings types re-exported for plugin author convenience. */
export type {
  FT8Message,
  FT8MessageBase,
  FT8MessageCQ,
  FT8MessageCall,
  FT8MessageSignalReport,
  FT8MessageRogerReport,
  FT8MessageRRR,
  FT8MessageSeventyThree,
  FT8MessageFoxRR73,
  FT8MessageCustom,
  FT8MessageUnknown,
  ParsedFT8Message,
  LogbookAnalysis,
  SlotInfo,
  SlotPack,
  QSORecord,
  FrameMessage,
  ModeDescriptor,
  OperatorSlots,
  DxccStatus,
  TargetSelectionPriorityMode,
  PluginType,
  PluginPermission,
  PluginSettingType,
  PluginSettingDescriptor,
  PluginSettingScope,
  PluginQuickAction,
  PluginQuickSetting,
  PluginCapability,
  PluginPanelDescriptor,
  PluginPanelComponent,
  PluginSettingOption,
  PluginStorageScope,
  PluginStorageConfig,
  PluginManifest,
  PluginStatus,
} from '@tx5dr/contracts';

/** Stable runtime enum values commonly referenced by plugin implementations. */
export { FT8MessageType } from './ft8-message-type.js';
