// @tx5dr/plugin-api — Type definitions for TX-5DR plugin development
//
// This package provides TypeScript types for building TX-5DR plugins.
// It has no runtime code — only type definitions for IDE autocompletion.
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
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
  QSORecord,
  FrameMessage,
  PluginType,
  PluginPermission,
  PluginSettingDescriptor,
  PluginQuickAction,
  PluginQuickSetting,
  PluginPanelDescriptor,
  PluginPanelComponent,
  PluginSettingOption,
  PluginManifest,
  PluginStatus,
} from '@tx5dr/contracts';
