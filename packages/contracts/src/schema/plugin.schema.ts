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
 * Explicit permission declarations requested by a plugin.
 *
 * Permissions let the host gate sensitive capabilities behind manifest-level
 * intent. Plugins should request the smallest possible set.
 */
export const PluginPermissionSchema = z.enum(['network']);

/**
 * Explicit permission declarations requested by a plugin.
 */
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/**
 * Built-in frontend renderer kinds supported by declarative plugin panels.
 */
export const PluginPanelComponentSchema = z.enum(['table', 'key-value', 'chart', 'log']);

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
export const PluginSettingTypeSchema = z.enum(['boolean', 'number', 'string', 'string[]', 'info']);

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
 * Declarative definition of a plugin-owned panel in the frontend.
 *
 * Panels are passive containers rendered by the host. A plugin sends data into
 * them through `ctx.ui.send(panelId, data)`.
 */
export const PluginPanelDescriptorSchema = z.object({
  id: z.string(),
  title: z.string(),
  component: PluginPanelComponentSchema,
});

/**
 * Declarative definition of a plugin-owned panel in the frontend.
 */
export type PluginPanelDescriptor = z.infer<typeof PluginPanelDescriptorSchema>;

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
  description: z.string().optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  settings: z.record(z.string(), PluginSettingDescriptorSchema).optional(),
  quickActions: z.array(PluginQuickActionSchema).optional(),
  quickSettings: z.array(PluginQuickSettingSchema).optional(),
  panels: z.array(PluginPanelDescriptorSchema).optional(),
  storage: PluginStorageConfigSchema.optional(),
});

/**
 * Normalized manifest describing a plugin's static metadata and declarations.
 */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ===== 运行时状态（推送给前端） =====

/**
 * Runtime-facing plugin status snapshot exposed to the frontend.
 *
 * This extends the static manifest with host state such as whether the plugin
 * is loaded, enabled, auto-disabled or currently assigned to operators.
 */
export const PluginStatusSchema = z.object({
  name: z.string(),
  type: PluginTypeSchema,
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
  locales: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

/**
 * Runtime-facing plugin status snapshot exposed to the frontend.
 */
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

export const PluginSystemStateSchema = z.enum(['ready', 'reloading', 'error']);
export type PluginSystemState = z.infer<typeof PluginSystemStateSchema>;

export const PluginSystemSnapshotSchema = z.object({
  state: PluginSystemStateSchema,
  generation: z.number().int().nonnegative(),
  plugins: z.array(PluginStatusSchema),
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
