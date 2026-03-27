import { z } from 'zod';

/**
 * 能力分类
 * - antenna: 天线相关（天调等）
 * - rf: 射频相关（发射功率等）
 * - audio: 音频相关（AF增益、静噪等）
 */
export const CapabilityCategorySchema = z.enum(['antenna', 'rf', 'audio']);
export type CapabilityCategory = z.infer<typeof CapabilityCategorySchema>;

/**
 * 能力值类型
 * - boolean: 布尔开关
 * - number: 数值（滑块）
 * - action: 纯动作按钮（无持久值，如手动调谐）
 */
export const CapabilityValueTypeSchema = z.enum(['boolean', 'number', 'action']);
export type CapabilityValueType = z.infer<typeof CapabilityValueTypeSchema>;

/**
 * 能力更新模式
 * - polling: 服务端定时轮询检测变化
 * - event: 由电台事件驱动（如连接时一次性读取）
 * - none: 不主动更新（action 类或只写能力）
 */
export const CapabilityUpdateModeSchema = z.enum(['polling', 'event', 'none']);
export type CapabilityUpdateMode = z.infer<typeof CapabilityUpdateModeSchema>;

/**
 * 能力描述符
 * 静态定义，前后端各持副本，不通过网络传输。
 * 描述一个可控能力的元数据（类型、范围、轮询策略、UI 配置等）。
 */
export const CapabilityDescriptorSchema = z.object({
  /** 全局唯一能力 ID，如 'tuner_switch', 'rf_power', 'af_gain', 'sql' */
  id: z.string(),

  /** 能力分类，用于前端面板分组渲染 */
  category: CapabilityCategorySchema,

  /** 能力值类型 */
  valueType: CapabilityValueTypeSchema,

  /**
   * 数值范围（仅 valueType='number' 时有效）
   * 值均为归一化范围（如 0-1），或实际范围（如 -60~0 dB），由具体能力定义
   */
  range: z.object({
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
  }).optional(),

  /** 是否可读取当前值（false = 只写，UI 无初始值） */
  readable: z.boolean(),

  /** 是否可写入（false = 只读展示） */
  writable: z.boolean(),

  /** 服务端更新策略 */
  updateMode: CapabilityUpdateModeSchema,

  /**
   * 轮询间隔（ms），仅 updateMode='polling' 时有效。
   * 建议：天调 5000ms，其他 Level 类 10000ms
   */
  pollIntervalMs: z.number().optional(),

  /**
   * 复合能力分组 ID。
   * 同一 group 的描述符在面板中合并为一张卡片（如天调开关和手动调谐按钮）
   */
  compoundGroup: z.string().optional(),

  /**
   * 在复合能力组中的角色
   * - switch: 布尔开关（主控制）
   * - action: 动作按钮
   */
  compoundRole: z.enum(['switch', 'action']).optional(),

  /** 前端标签 i18n key，如 'radio:capability.tuner_switch' */
  labelI18nKey: z.string(),

  /** 前端描述文字 i18n key（可选） */
  descriptionI18nKey: z.string().optional(),

  /** 是否在 RadioControl 工具栏 surface 区域露出紧凑控件 */
  hasSurfaceControl: z.boolean(),

  /**
   * surface 控件的分组 ID。
   * 同一 surfaceGroup 的控件聚合为一个 Popover（如天调开关和调谐按钮）
   */
  surfaceGroup: z.string().optional(),
});

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

/**
 * 能力运行时状态
 * 动态数据，通过 WebSocket 实时同步到前端。
 */
export const CapabilityStateSchema = z.object({
  /** 能力 ID，与 CapabilityDescriptor.id 对应 */
  id: z.string(),

  /** 当前连接的电台是否支持此能力（探测结果） */
  supported: z.boolean(),

  /**
   * 当前值
   * - boolean 类能力：true/false
   * - number 类能力：数值（范围由 descriptor.range 定义）
   * - action 类能力：始终为 null
   */
  value: z.union([z.boolean(), z.number()]).nullable(),

  /**
   * 附加元数据（能力特有信息）
   * 例：tuner_switch 的 meta 可携带 { status: 'tuning' | 'idle' | 'success' | 'failed', swr?: number }
   */
  meta: z.record(z.unknown()).optional(),

  /** 最后更新时间戳（ms） */
  updatedAt: z.number(),
});

export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

/**
 * 能力列表快照（radioCapabilityList WS 消息的 data 部分）
 */
export const CapabilityListSchema = z.object({
  capabilities: z.array(CapabilityStateSchema),
});

export type CapabilityList = z.infer<typeof CapabilityListSchema>;

/**
 * 写命令负载（writeRadioCapability WS 命令的 data 部分）
 */
export const WriteCapabilityPayloadSchema = z.object({
  /** 能力 ID */
  id: z.string(),
  /** 写入值（boolean/number 类能力） */
  value: z.union([z.boolean(), z.number()]).optional(),
  /** 触发动作（action 类能力，传 true） */
  action: z.boolean().optional(),
});

export type WriteCapabilityPayload = z.infer<typeof WriteCapabilityPayloadSchema>;

// ============================================================
// v1 能力 ID 的字面量联合类型（方便类型检查）
// ============================================================

export const CAPABILITY_IDS = [
  'tuner_switch',
  'tuner_tune',
  'rf_power',
  'af_gain',
  'sql',
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];
