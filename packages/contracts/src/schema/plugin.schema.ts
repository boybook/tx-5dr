import { z } from 'zod';

// ===== 核心枚举 =====

/**
 * 插件类型
 * - strategy: 策略插件，每操作员只能激活一个（互斥）
 * - utility: 工具插件，可多个叠加使用
 */
export const PluginTypeSchema = z.enum(['strategy', 'utility']);
export type PluginType = z.infer<typeof PluginTypeSchema>;

/**
 * 插件权限声明
 * - network: 允许使用 ctx.fetch() 进行网络请求
 */
export const PluginPermissionSchema = z.enum(['network']);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/**
 * 插件面板组件类型
 * - table: 表格展示
 * - key-value: 键值对展示
 * - chart: 图表展示
 * - log: 日志/消息流展示
 */
export const PluginPanelComponentSchema = z.enum(['table', 'key-value', 'chart', 'log']);
export type PluginPanelComponent = z.infer<typeof PluginPanelComponentSchema>;

// ===== 设置声明 =====

/**
 * 插件设置项的类型
 */
export const PluginSettingTypeSchema = z.enum(['boolean', 'number', 'string', 'string[]', 'info']);
export type PluginSettingType = z.infer<typeof PluginSettingTypeSchema>;

/**
 * 插件设置项的选项（用于 Select 下拉选择）
 */
export const PluginSettingOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type PluginSettingOption = z.infer<typeof PluginSettingOptionSchema>;

/**
 * 插件设置项的作用域
 * - global: 所有操作员共享（如 API key、黑名单），在 PluginSettingsTab 中展示
 * - operator: 每个操作员独立（如自动化行为），在 OperatorSettings 中展示
 */
export const PluginSettingScopeSchema = z.enum(['global', 'operator']);
export type PluginSettingScope = z.infer<typeof PluginSettingScopeSchema>;

/**
 * 插件设置描述符
 * 声明一个设置项的类型、默认值、UI 显示信息等
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
export type PluginSettingDescriptor = z.infer<typeof PluginSettingDescriptorSchema>;

// ===== 快捷操作 =====

/**
 * 插件快捷操作按钮定义
 */
export const PluginQuickActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});
export type PluginQuickAction = z.infer<typeof PluginQuickActionSchema>;

/**
 * 插件快捷设置定义
 * - 直接引用一个 operator-scope setting key，在右上角自动化面板中渲染
 */
export const PluginQuickSettingSchema = z.object({
  settingKey: z.string(),
});
export type PluginQuickSetting = z.infer<typeof PluginQuickSettingSchema>;

// ===== 面板 =====

/**
 * 插件面板描述符
 */
export const PluginPanelDescriptorSchema = z.object({
  id: z.string(),
  title: z.string(),
  component: PluginPanelComponentSchema,
});
export type PluginPanelDescriptor = z.infer<typeof PluginPanelDescriptorSchema>;

// ===== 存储配置 =====

/**
 * 插件存储作用域
 */
export const PluginStorageScopeSchema = z.enum(['global', 'operator']);
export type PluginStorageScope = z.infer<typeof PluginStorageScopeSchema>;

/**
 * 插件存储配置
 */
export const PluginStorageConfigSchema = z.object({
  scopes: z.array(PluginStorageScopeSchema),
});
export type PluginStorageConfig = z.infer<typeof PluginStorageConfigSchema>;

// ===== 插件清单 =====

/**
 * 插件清单 — 描述插件的元数据和声明
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
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ===== 运行时状态（推送给前端） =====

/**
 * 插件运行时状态
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
  locales: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
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
