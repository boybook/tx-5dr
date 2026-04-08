// @tx5dr/plugin-api — Public development surface for TX-5DR plugins
//
// This package provides the stable public API for building TX-5DR plugins.
// Plugin authors should import from this package instead of reaching into
// internal monorepo packages such as @tx5dr/contracts.
//
// Usage (TypeScript):
//   import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
//
// Usage (JavaScript with JSDoc):
//   /** @type {import('@tx5dr/plugin-api').PluginDefinition} */
//   export default { ... };

// Core interfaces
export type { PluginDefinition } from './definition.js';
export type { PluginContext } from './context.js';
export type {
  PluginHooks,
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

// Helper interfaces
export type {
  KVStore,
  PluginLogger,
  PluginTimers,
  OperatorControl,
  RadioControl,
  LogbookAccess,
  BandAccess,
  UIBridge,
} from './helpers.js';

// Re-export commonly used types from contracts for convenience
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
  PluginPanelDescriptor,
  PluginPanelComponent,
  PluginSettingOption,
  PluginStorageScope,
  PluginStorageConfig,
  PluginManifest,
  PluginStatus,
} from '@tx5dr/contracts';

// Re-export a small set of stable runtime values commonly used by plugins
export { FT8MessageType } from '@tx5dr/contracts';
