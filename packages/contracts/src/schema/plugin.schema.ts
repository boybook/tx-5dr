import { z } from 'zod';

// ===== 核心枚举 =====

/**
 * High-level plugin category.
 *
 * - `strategy`: owns the operator's automation runtime and is mutually
 *   exclusive per operator.
 * - `utility`: composes with other utility plugins to filter, score, monitor or
 *   augment UI.
 */
export const PluginTypeSchema = z.enum(['strategy', 'utility']);

/**
 * High-level plugin category used by manifests and runtime status objects.
 */
export type PluginType = z.infer<typeof PluginTypeSchema>;

/**
 * Runtime instance scope for a plugin.
 *
 * - `operator`: the host creates one instance per operator.
 * - `global`: the host creates a single shared instance for the whole station.
 */
export const PluginInstanceScopeSchema = z.enum(['operator', 'global']);

/**
 * Runtime instance scope for a plugin.
 */
export type PluginInstanceScope = z.infer<typeof PluginInstanceScopeSchema>;

/**
 * Explicit permission declarations requested by a plugin.
 *
 * Permissions let the host gate sensitive capabilities behind manifest-level
 * intent. Plugins should request the smallest possible set.
 */
export const PluginPermissionSchema = z.enum(['network', 'radio:read', 'radio:control', 'radio:power']);

/**
 * Explicit permission declarations requested by a plugin.
 */
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/**
 * Built-in frontend renderer kinds supported by declarative plugin panels.
 */
export const PluginPanelComponentSchema = z.enum(['table', 'key-value', 'chart', 'log', 'iframe']);

/**
 * Built-in frontend renderer kinds supported by declarative plugin panels.
 */
export type PluginPanelComponent = z.infer<typeof PluginPanelComponentSchema>;

// ===== 设置声明 =====

/**
 * Supported generated-form field types for plugin settings.
 *
 * These values control both validation expectations and default frontend
 * rendering in plugin settings UIs.
 */
export const PluginSettingTypeSchema = z.enum(['boolean', 'number', 'string', 'string[]', 'object[]', 'info']);

/**
 * Supported generated-form field types for plugin settings.
 */
export type PluginSettingType = z.infer<typeof PluginSettingTypeSchema>;

/**
 * Label/value pair used by select-like plugin settings.
 */
export const PluginSettingOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

/**
 * Label/value pair used by select-like plugin settings.
 */
export type PluginSettingOption = z.infer<typeof PluginSettingOptionSchema>;

export const PluginObjectArrayFieldSchema = z.object({
  key: z.string(),
  type: z.enum(['string', 'number', 'boolean']).optional().default('string'),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});
export type PluginObjectArrayField = z.infer<typeof PluginObjectArrayFieldSchema>;

/**
 * Persistence and UI scope for a plugin setting.
 *
 * - `global`: shared by the whole station and typically edited in plugin
 *   management views.
 * - `operator`: isolated per operator and typically edited in operator-specific
 *   automation settings.
 */
export const PluginSettingScopeSchema = z.enum(['global', 'operator']);

/**
 * Persistence and UI scope for a plugin setting.
 */
export type PluginSettingScope = z.infer<typeof PluginSettingScopeSchema>;

/**
 * Declarative description of a persisted plugin setting.
 *
 * The host uses this schema to generate configuration forms, validate updates
 * and resolve default values before injecting them into `ctx.config`.
 */
export const PluginSettingDescriptorSchema = z.object({
  type: PluginSettingTypeSchema,
  default: z.unknown(),
  label: z.string(),
  description: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(PluginSettingOptionSchema).optional(),
  /** Field schema used by generated editors for `object[]` settings. */
  itemFields: z.array(PluginObjectArrayFieldSchema).optional(),
  /** Internal settings are persisted/injected but hidden from generated UIs. */
  hidden: z.boolean().optional(),
  /** 设置作用域：global（所有操作员共享）或 operator（每操作员独立），默认 global */
  scope: PluginSettingScopeSchema.optional().default('global'),
});

/**
 * Declarative description of a persisted plugin setting.
 *
 * `default` is the resolved fallback value, `label`/`description` power the UI,
 * `min` and `max` constrain numeric fields, `options` enumerates valid choices
 * for select-like inputs, and `scope` controls whether the value is shared or
 * operator-specific.
 */
export type PluginSettingDescriptor = z.infer<typeof PluginSettingDescriptorSchema>;

// ===== 快捷操作 =====

/**
 * Declarative quick-action button shown in operator-facing plugin UI.
 *
 * Quick actions are intended for one-shot commands and are dispatched through
 * the plugin user-action channel when clicked.
 */
export const PluginQuickActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});

/**
 * Declarative quick-action button shown in operator-facing plugin UI.
 */
export type PluginQuickAction = z.infer<typeof PluginQuickActionSchema>;

/**
 * Shortcut reference to an operator-scope setting that should be surfaced in a
 * compact quick-settings panel.
 */
export const PluginQuickSettingSchema = z.object({
  settingKey: z.string(),
});

/**
 * Shortcut reference to an operator-scope setting that should be surfaced in a
 * compact quick-settings panel.
 */
export type PluginQuickSetting = z.infer<typeof PluginQuickSettingSchema>;

// ===== 能力标签 =====

/**
 * Host-derived capability tags exposed to the frontend.
 *
 * These tags are computed from the plugin definition so the UI can reason
 * about plugin roles without hard-coding specific plugin names.
 */
export const PluginCapabilitySchema = z.enum([
  'auto_call_candidate',
  'auto_call_execution',
]);

/**
 * Host-derived capability tags exposed to the frontend.
 */
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

// ===== 面板 =====

/**
 * Rendering slot that determines where a panel appears in the UI.
 *
 * - `operator`: shown in the expanded operator card's live-panel area (default).
 * - `automation`: shown inside the top-right automation quick-action popover.
 * - `main-right`: shown in the optional main layout plugin pane on the far right.
 * - `voice-left-top`: shown above the voice frequency control card.
 * - `voice-right-top`: shown in the tabbed top area of the voice right panel.
 */
export const PluginPanelSlotSchema = z.enum(['operator', 'automation', 'main-right', 'voice-left-top', 'voice-right-top']);

/**
 * Rendering slot that determines where a panel appears in the UI.
 */
export type PluginPanelSlot = z.infer<typeof PluginPanelSlotSchema>;

/**
 * Preferred width hint for plugin-owned panels.
 *
 * Hosts may interpret this hint differently per slot. Today the operator-card
 * host treats `full` as "span the full row on desktop", while automation
 * popover hosts may choose to ignore it.
 */
export const PluginPanelWidthSchema = z.enum(['half', 'full']);

/**
 * Preferred width hint for plugin-owned panels.
 */
export type PluginPanelWidth = z.infer<typeof PluginPanelWidthSchema>;

/**
 * Declarative definition of a plugin-owned panel in the frontend.
 *
 * Panels are passive containers rendered by the host. A plugin sends data into
 * them through `ctx.ui.send(panelId, data)`. When `component` is `'iframe'`,
 * the panel renders a custom UI page inside a sandboxed iframe instead. Static
 * manifest panels and runtime UI contributions use this same descriptor.
 */
export const PluginPanelDescriptorSchema = z.object({
  id: z.string(),
  title: z.string(),
  component: PluginPanelComponentSchema,
  /** Required when `component` is `'iframe'`. References a page id from `ui.pages`. */
  pageId: z.string().optional(),
  /** Optional string params forwarded to iframe panels as URL/init params. */
  params: z.record(z.string(), z.string()).optional(),
  /** Where the panel renders. Defaults to `'operator'` (operator card live-panel area). */
  slot: PluginPanelSlotSchema.optional(),
  /** Preferred width hint. Defaults to `'half'`. */
  width: PluginPanelWidthSchema.optional(),
});

/**
 * Declarative definition of a plugin-owned panel in the frontend.
 */
export type PluginPanelDescriptor = z.infer<typeof PluginPanelDescriptorSchema>;

export const PluginUIPanelContributionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('operator'), operatorId: z.string() }),
]);
export type PluginUIPanelContributionTarget = z.infer<typeof PluginUIPanelContributionTargetSchema>;

/**
 * A normalized group of plugin UI panels.
 *
 * Static `PluginDefinition.panels` are emitted by the host as the reserved
 * `manifest` group. Runtime groups are replaced by
 * `ctx.ui.setPanelContributions(groupId, panels)` and cleared by publishing an
 * empty panel list for the same group.
 */
export const PluginUIPanelContributionGroupSchema = z.object({
  pluginName: z.string(),
  groupId: z.string(),
  source: z.enum(['manifest', 'runtime']),
  instanceTarget: PluginUIPanelContributionTargetSchema.optional(),
  panels: z.array(PluginPanelDescriptorSchema),
});
export type PluginUIPanelContributionGroup = z.infer<typeof PluginUIPanelContributionGroupSchema>;

// ===== 自定义 UI 页面 =====

/**
 * Declarative descriptor for a custom UI page served from a plugin's static
 * file directory and rendered inside an iframe by the host.
 *
 * Pages are registered in `PluginDefinition.ui.pages` and can be consumed by
 * any host component via `<PluginIframeHost pluginName={...} pageId={...} />`.
 */
export const PluginUIPageDescriptorSchema = z.object({
  /** Unique page identifier within the plugin (e.g. 'settings', 'dashboard'). */
  id: z.string(),
  /** Display title (i18n key or literal text). */
  title: z.string(),
  /** Entry HTML file path relative to the UI directory (e.g. 'settings.html'). */
  entry: z.string(),
  /** Optional icon identifier. */
  icon: z.string().optional(),
  /** Who may access this page through the host iframe bridge. Defaults to admin. */
  accessScope: z.enum(['admin', 'operator']).optional().default('admin'),
  /** Optional resource binding enforced by the host for iframe invoke requests. */
  resourceBinding: z.enum(['none', 'callsign', 'operator']).optional().default('none'),
});

/**
 * Declarative descriptor for a custom UI page served from a plugin's static
 * file directory.
 */
export type PluginUIPageDescriptor = z.infer<typeof PluginUIPageDescriptorSchema>;

/**
 * Declares that a plugin provides custom UI pages hosted in an iframe.
 */
export const PluginUIConfigSchema = z.object({
  /** Static file directory relative to the plugin root (default: 'ui'). */
  dir: z.string().optional().default('ui'),
  /** Registered custom UI pages. */
  pages: z.array(PluginUIPageDescriptorSchema).optional().default([]),
});

/**
 * Declares that a plugin provides custom UI pages hosted in an iframe.
 */
export type PluginUIConfig = z.infer<typeof PluginUIConfigSchema>;

// ===== 存储配置 =====

/**
 * Storage scope requested by a plugin.
 */
export const PluginStorageScopeSchema = z.enum(['global', 'operator']);

/**
 * Storage scope requested by a plugin.
 */
export type PluginStorageScope = z.infer<typeof PluginStorageScopeSchema>;

/**
 * Declares which persistent storage scopes the host should provision.
 */
export const PluginStorageConfigSchema = z.object({
  scopes: z.array(PluginStorageScopeSchema),
});

/**
 * Declares which persistent storage scopes the host should provision.
 */
export type PluginStorageConfig = z.infer<typeof PluginStorageConfigSchema>;

// ===== 插件清单 =====

/**
 * Normalized manifest describing a plugin's static metadata and declarations.
 *
 * This is effectively the serializable subset of a plugin definition that the
 * host can expose to management UI and diagnostics.
 */
export const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: PluginTypeSchema,
  instanceScope: PluginInstanceScopeSchema.optional().default('operator'),
  description: z.string().optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  settings: z.record(z.string(), PluginSettingDescriptorSchema).optional(),
  quickActions: z.array(PluginQuickActionSchema).optional(),
  quickSettings: z.array(PluginQuickSettingSchema).optional(),
  panels: z.array(PluginPanelDescriptorSchema).optional(),
  storage: PluginStorageConfigSchema.optional(),
  ui: PluginUIConfigSchema.optional(),
});

/**
 * Normalized manifest describing a plugin's static metadata and declarations.
 */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ===== 运行时状态（推送给前端） =====

export const PluginMarketChannelSchema = z.enum(['stable', 'nightly']);
export type PluginMarketChannel = z.infer<typeof PluginMarketChannelSchema>;

export const PluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('marketplace'),
    version: z.string(),
    channel: PluginMarketChannelSchema,
    artifactUrl: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    installedAt: z.number().int().nonnegative(),
  }),
]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const PluginLocalesSchema = z.record(z.string(), z.record(z.string(), z.string()));
export type PluginLocales = z.infer<typeof PluginLocalesSchema>;

/**
 * Runtime-facing plugin status snapshot exposed to the frontend.
 *
 * This extends the static manifest with host state such as whether the plugin
 * is loaded, enabled, auto-disabled or currently assigned to operators.
 */
export const PluginStatusSchema = z.object({
  name: z.string(),
  type: PluginTypeSchema,
  instanceScope: PluginInstanceScopeSchema.optional().default('operator'),
  version: z.string(),
  description: z.string().optional(),
  isBuiltIn: z.boolean(),
  loaded: z.boolean().default(true),
  enabled: z.boolean(),
  /** 是否被自动禁用（连续错误达到阈值） */
  autoDisabled: z.boolean().optional().default(false),
  errorCount: z.number(),
  lastError: z.string().optional(),
  /** 仅对 strategy 插件有意义：当前被哪些 operator 选中 */
  assignedOperatorIds: z.array(z.string()).optional(),
  settings: z.record(z.string(), PluginSettingDescriptorSchema).optional(),
  quickActions: z.array(PluginQuickActionSchema).optional(),
  quickSettings: z.array(PluginQuickSettingSchema).optional(),
  panels: z.array(PluginPanelDescriptorSchema).optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  capabilities: z.array(PluginCapabilitySchema).optional(),
  ui: PluginUIConfigSchema.optional(),
  locales: PluginLocalesSchema.optional(),
  source: PluginSourceSchema.optional(),
});

/**
 * Runtime-facing plugin status snapshot exposed to the frontend.
 */
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

const PluginMarketInstallRecordInternalSchema = z.object({
  version: z.string(),
  channel: PluginMarketChannelSchema,
  artifactUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  installedAt: z.number().int().nonnegative(),
});

export const PluginSystemStateSchema = z.enum(['ready', 'reloading', 'error']);
export type PluginSystemState = z.infer<typeof PluginSystemStateSchema>;

/**
 * Dynamic plugin panel metadata pushed by runtime code.
 */
export const PluginPanelMetaSchema = z.object({
  title: z.string().nullable().optional(),
  titleValues: z.record(z.unknown()).optional(),
  visible: z.boolean().optional(),
});
export type PluginPanelMeta = z.infer<typeof PluginPanelMetaSchema>;

/**
 * Plugin panel metadata payload for websocket deltas and initial snapshots.
 */
export const PluginPanelMetaPayloadSchema = z.object({
  pluginName: z.string(),
  operatorId: z.string(),
  panelId: z.string(),
  meta: PluginPanelMetaSchema,
});
export type PluginPanelMetaPayload = z.infer<typeof PluginPanelMetaPayloadSchema>;

export const PluginSystemSnapshotSchema = z.object({
  state: PluginSystemStateSchema,
  generation: z.number().int().nonnegative(),
  plugins: z.array(PluginStatusSchema),
  panelMeta: z.array(PluginPanelMetaPayloadSchema).optional().default([]),
  panelContributions: z.array(PluginUIPanelContributionGroupSchema).optional().default([]),
  lastError: z.string().optional(),
});
export type PluginSystemSnapshot = z.infer<typeof PluginSystemSnapshotSchema>;

// ===== 插件宿主运行时信息 =====

export const PluginDistributionSchema = z.enum([
  'electron',
  'docker',
  'linux-service',
  'generic-server',
  'web-dev',
]);
export type PluginDistribution = z.infer<typeof PluginDistributionSchema>;

export const PluginRuntimeInfoSchema = z.object({
  pluginDir: z.string(),
  pluginDataDir: z.string(),
  dataDir: z.string(),
  configDir: z.string(),
  logsDir: z.string(),
  cacheDir: z.string(),
  distribution: PluginDistributionSchema,
  hostPluginDirHint: z.string().optional(),
});
export type PluginRuntimeInfo = z.infer<typeof PluginRuntimeInfoSchema>;

// ===== 持久化配置（存入 config.json） =====

/**
 * 单个插件的持久化配置
 */
export const PluginConfigEntrySchema = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
});
export type PluginConfigEntry = z.infer<typeof PluginConfigEntrySchema>;

// ===== 插件市场（官方索引） =====

export const PluginMarketScreenshotSchema = z.object({
  src: z.string().url(),
  alt: z.string().optional(),
});
export type PluginMarketScreenshot = z.infer<typeof PluginMarketScreenshotSchema>;

export const PluginMarketCatalogEntrySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  locales: PluginLocalesSchema.optional(),
  latestVersion: z.string(),
  minHostVersion: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  repository: z.string().url().optional(),
  homepage: z.string().url().optional(),
  categories: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
  permissions: z.array(PluginPermissionSchema).optional().default([]),
  screenshots: z.array(PluginMarketScreenshotSchema).optional().default([]),
  artifactUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().nonnegative(),
  publishedAt: z.string(),
});
export type PluginMarketCatalogEntry = z.infer<typeof PluginMarketCatalogEntrySchema>;

export const PluginMarketCatalogSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string(),
  channel: PluginMarketChannelSchema,
  plugins: z.array(PluginMarketCatalogEntrySchema),
});
export type PluginMarketCatalog = z.infer<typeof PluginMarketCatalogSchema>;

export const PluginMarketCatalogResponseSchema = z.object({
  catalog: PluginMarketCatalogSchema,
  sourceUrl: z.string().url(),
});
export type PluginMarketCatalogResponse = z.infer<typeof PluginMarketCatalogResponseSchema>;

export const PluginMarketCatalogEntryResponseSchema = z.object({
  plugin: PluginMarketCatalogEntrySchema,
  sourceUrl: z.string().url(),
  channel: PluginMarketChannelSchema,
});
export type PluginMarketCatalogEntryResponse = z.infer<typeof PluginMarketCatalogEntryResponseSchema>;

export const PluginMarketInstallRecordSchema = PluginMarketInstallRecordInternalSchema;
export type PluginMarketInstallRecord = z.infer<typeof PluginMarketInstallRecordSchema>;

export const PluginMarketInstallActionSchema = z.enum(['install', 'update', 'uninstall']);
export type PluginMarketInstallAction = z.infer<typeof PluginMarketInstallActionSchema>;

export const PluginMarketInstallResultSchema = z.object({
  success: z.literal(true),
  action: PluginMarketInstallActionSchema,
  pluginName: z.string(),
  record: PluginMarketInstallRecordSchema.optional(),
});
export type PluginMarketInstallResult = z.infer<typeof PluginMarketInstallResultSchema>;

/**
 * 所有插件的持久化配置
 */
export const PluginsConfigSchema = z.object({
  /** 全局插件配置（enabled 状态 + global scope settings） */
  configs: z.record(z.string(), PluginConfigEntrySchema).optional().default({}),
  /** 每操作员的策略插件选择 */
  operatorStrategies: z.record(z.string(), z.string()).optional().default({}),
  /** 每操作员的 operator scope plugin settings：operatorId → pluginName → settings */
  operatorSettings: z.record(
    z.string(),
    z.record(z.string(), z.record(z.string(), z.unknown()))
  ).optional().default({}),
});
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

// ===== WebSocket 数据载荷 =====

/**
 * 插件数据推送载荷（ctx.ui.send() 发送到前端）
 */
export const PluginDataPayloadSchema = z.object({
  pluginName: z.string(),
  operatorId: z.string(),
  panelId: z.string(),
  data: z.unknown(),
});
export type PluginDataPayload = z.infer<typeof PluginDataPayloadSchema>;

/**
 * 插件日志条目
 */
export const PluginLogEntrySchema = z.object({
  pluginName: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.unknown().optional(),
  timestamp: z.number(),
});
export type PluginLogEntry = z.infer<typeof PluginLogEntrySchema>;

export const PluginRuntimeLogStageSchema = z.enum([
  'scan',
  'load',
  'validate',
  'reload',
  'activate',
]);
export type PluginRuntimeLogStage = z.infer<typeof PluginRuntimeLogStageSchema>;

/**
 * 宿主级插件运行日志条目
 */
export const PluginRuntimeLogEntrySchema = z.object({
  source: z.literal('system'),
  stage: PluginRuntimeLogStageSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  timestamp: z.number(),
  pluginName: z.string().optional(),
  directoryName: z.string().optional(),
  details: z.unknown().optional(),
});
export type PluginRuntimeLogEntry = z.infer<typeof PluginRuntimeLogEntrySchema>;

/**
 * 宿主级插件运行日志历史响应载荷
 */
export const PluginRuntimeLogHistoryPayloadSchema = z.object({
  entries: z.array(PluginRuntimeLogEntrySchema),
});
export type PluginRuntimeLogHistoryPayload = z.infer<typeof PluginRuntimeLogHistoryPayloadSchema>;

/**
 * 插件用户操作载荷（前端 → 后端）
 */
export const PluginUserActionPayloadSchema = z.object({
  pluginName: z.string(),
  actionId: z.string(),
  operatorId: z.string().optional(),
  payload: z.unknown().optional(),
});
export type PluginUserActionPayload = z.infer<typeof PluginUserActionPayloadSchema>;

/**
 * 操作员维度的插件设置更新载荷
 */
export const PluginOperatorSettingsPayloadSchema = z.object({
  pluginName: z.string(),
  operatorId: z.string(),
  settings: z.record(z.string(), z.unknown()),
});
export type PluginOperatorSettingsPayload = z.infer<typeof PluginOperatorSettingsPayloadSchema>;
