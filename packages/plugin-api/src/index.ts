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
  HostDependencies,
  HamlibHostDependency,
  HamlibRotator,
  HamlibRotatorConstructor,
  HamlibSupportedRotatorInfo,
  HamlibRotatorConnectionInfo,
  HamlibRotatorPosition,
  HamlibRotatorStatus,
  HamlibRotatorDirection,
  HamlibRotatorResetType,
  HamlibConfigFieldDescriptor,
  HamlibPortCaps,
  HamlibRotatorCaps,
} from './host-dependencies.js';
export type {
  PluginHooks,
  AutoCallProposal,
  AutoCallExecutionRequest,
  AutoCallExecutionPlan,
  SlotActivityEvent,
  FrequencyChangeState,
  ScoredCandidate,
  StrategyDecision,
  StrategyDecisionMeta,
  LastMessageInfo,
  QSOFailureInfo,
} from './hooks.js';
export type {
  StrategyRuntime,
  StrategyRuntimeContext,
  StrategyRuntimeSnapshot,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
} from './runtime.js';
export type {
  HostSettingsControl,
  HostSettingsNamespace,
  HostFrequencyPresetsSettingsNamespace,
  HostFT8Settings,
  HostFT8SettingsPatch,
  HostFrequencyPresetsSettings,
  HostStationInfoPatch,
  HostPSKReporterSettingsPatch,
} from './settings.js';

/** Host-provided helper interfaces available through {@link PluginContext}. */
export type {
  KVStore,
  PluginLogger,
  PluginTimers,
  OtherOperatorSnapshot,
  OperatorControl,
  RadioControl,
  RadioOperatingMode,
  RadioCapabilitiesControl,
  RadioPowerControl,
  RadioPowerSetOptions,
  LogbookAccess,
  CallsignLogbookAccess,
  QSOQueryFilter,
  BandAccess,
  IdleTransmitFrequencyOptions,
  AutoTargetEligibilityReason,
  AutoTargetEligibilityDecision,
  UIBridge,
  PanelMeta,
  PluginUIHandler,
  PluginUIRequestContext,
  PluginUIRequestUser,
  PluginUIBoundResource,
  PluginUIInstanceTarget,
  PluginUIPageSessionInfo,
  PluginUIPageContext,
  PluginFileStore,
  PluginNetworkControl,
  PluginUdpControl,
  PluginUdpSocket,
  PluginUdpSocketOptions,
  PluginUdpBindOptions,
  PluginUdpRemoteInfo,
} from './helpers.js';


/** Callsign and DXCC helpers available to plugins. */
export {
  getCallsignInfo,
  listDXCCEntities,
  resolveDXCCEntity,
} from '@tx5dr/core';
export type {
  CallsignInfo,
  DXCCEntity,
  DXCCResolutionResult,
} from '@tx5dr/core';

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
  FrequencyState,
  QSORecord,
  FrameMessage,
  ModeDescriptor,
  OperatorSlots,
  DxccStatus,
  TargetSelectionPriorityMode,
  PluginType,
  PluginInstanceScope,
  PluginPermission,
  PluginSettingType,
  PluginSettingDescriptor,
  PluginSettingScope,
  PluginQuickAction,
  PluginQuickSetting,
  PluginCapability,
  PluginPanelDescriptor,
  PluginPanelComponent,
  PluginPanelWidth,
  PluginPanelOpenMode,
  PluginPanelUISize,
  PluginUIPanelContributionGroup,
  PluginUIPanelContributionTarget,
  PluginObjectArrayField,
  PluginKeyedStringArrayKey,
  PluginSettingCondition,
  PluginSettingConditionalDescription,
  PluginSettingOption,
  PluginStorageScope,
  PluginStorageConfig,
  PluginManifest,
  PluginStatus,
  PluginUIPageDescriptor,
  PluginUIConfig,
  CapabilityList,
  CapabilityState,
  CapabilityDescriptor,
  CapabilityValue,
  WriteCapabilityPayload,
  RadioPowerRequest,
  RadioPowerResponse,
  RadioPowerState,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
  DecodeWindowSettings,
  RealtimeSettings,
  RealtimeSettingsResponseData,
  PresetFrequency,
  StationInfo,
  PSKReporterConfig,
  NtpServerListSettings,
  UpdateNtpServerListRequest,
} from '@tx5dr/contracts';

/** Logbook sync provider interfaces. */
export type {
  LogbookSyncProvider,
  LogbookSyncRegistrar,
  SyncAction,
  SyncFailure,
  SyncFailureInput,
  SyncFailureOperation,
  SyncFailureSource,
  SyncTestResult,
  SyncUploadProgress,
  SyncUploadOptions,
  SyncUploadPreflightOptions,
  SyncUploadResult,
  SyncPreflightIssue,
  SyncUploadPreflightResult,
  SyncDownloadProgress,
  SyncDownloadResult,
  SyncDownloadOptions,
} from './sync.js';

export {
  createSyncFailure,
  errorToSyncFailure,
  failureMessage,
  sanitizeSyncFailureText,
} from './sync.js';

/** Stable runtime enum values commonly referenced by plugin implementations. */
export { FT8MessageType } from './ft8-message-type.js';

/** Utility functions for plugin authors. */
export { normalizeCallsign } from './utils/callsign.js';

/** ADIF (Amateur Data Interchange Format) utilities. */
export {
  parseADIFContent,
  parseADIFRecord,
  parseADIFFields,
  convertQSOToADIF,
  generateADIFFile,
  formatADIFDate,
  formatADIFTime,
  parseADIFDateTime,
} from './utils/adif.js';

/** Plugin page scope path utilities. */
export {
  getPluginPageFileScopePath,
  getPluginPageScopePath,
  getPluginPageScopeSegments,
  getPluginPageStorePath,
} from './utils/page-scope.js';
export type { PluginPageBoundResource } from './utils/page-scope.js';

/** QSO text field utilities. */
export {
  buildSignalReportComment,
  parseQsoTextFields,
  parseLegacyComment,
  parseMessageHistoryText,
  resolveQsoComment,
  buildCommentFromMessageHistory,
  normalizeMessageHistory,
  sanitizeAdifFieldValue,
} from './utils/qso-text-fields.js';
