import { z } from 'zod';

/**
 * CW 键控器配置
 */
export const CWKeyerBackendSchema = z.enum(['cat', 'serial']);
export type CWKeyerBackend = z.infer<typeof CWKeyerBackendSchema>;

export const CWKeyerConfigSchema = z.object({
  /** CW 发报后端：cat=Hamlib 整报文，serial=DTR/RTS 时序键控 */
  backend: CWKeyerBackendSchema.default('cat'),
  /** CW 键控串口路径（用于 DTR/RTS 引脚控制） */
  keyPort: z.string(),
  /** CW 键控引脚类型 */
  keyMethod: z.enum(['dtr', 'rts']),
  /** 莫尔斯码速度 (WPM, 5-60) */
  wpm: z.number().int().min(5).max(60).default(20),
});

export type CWKeyerConfig = z.infer<typeof CWKeyerConfigSchema>;

/**
 * CW 键控器状态
 */
export const CWKeyerStatusSchema = z.object({
  /** 是否有活动键控 */
  active: z.boolean(),
  /** 当前状态模式 */
  mode: z.enum(['idle', 'keying', 'playing', 'repeat-waiting', 'error']),
  /** 发起键控的客户端 ID */
  startedBy: z.string().nullable(),
  /** 发起键控的客户端显示名 */
  startedByLabel: z.string().nullable(),
  /** 当前播放的报文 ID */
  messageId: z.string().nullable(),
  /** 下次执行时间戳 (repeat-waiting 时有效) */
  nextRunAt: z.number().nullable(),
  /** 错误信息 */
  error: z.string().nullable(),
  /** 当前 CW 发报后端 */
  backend: CWKeyerBackendSchema.optional(),
  /** 当前后端是否具备发报条件 */
  backendAvailable: z.boolean().optional(),
  /** 当前后端不可用原因 */
  backendError: z.string().nullable().optional(),
});

export type CWKeyerStatus = z.infer<typeof CWKeyerStatusSchema>;

/**
 * CW 报文槽位
 */
export const CWMessageSlotSchema = z.object({
  /** 槽位唯一 ID */
  id: z.string(),
  /** 显示序号 (1-based) */
  index: z.number().int().min(1),
  /** 报文标签 */
  label: z.string(),
  /** 报文文本内容 */
  text: z.string(),
  /** 是否启用循环播放 */
  repeatEnabled: z.boolean(),
  /** 循环播放间隔（秒） */
  repeatIntervalSec: z.number().int().min(1).max(300),
});

export type CWMessageSlot = z.infer<typeof CWMessageSlotSchema>;

/**
 * CW 报文面板
 */
export const CWMessagePanelSchema = z.object({
  /** 呼号 */
  callsign: z.string(),
  /** 当前槽位数 */
  slotCount: z.number().int().min(3).max(12),
  /** 最大槽位数 */
  maxSlotCount: z.number().int().min(12),
  /** 槽位列表 */
  slots: z.array(CWMessageSlotSchema),
});

export type CWMessagePanel = z.infer<typeof CWMessagePanelSchema>;

/**
 * CW 手键动作
 */
export const CWKeyActionSchema = z.object({
  /** 键控动作 */
  action: z.enum(['key-down', 'key-up']),
});

export type CWKeyAction = z.infer<typeof CWKeyActionSchema>;

/**
 * CW 报文占位符值（由前端根据当前 UI 上下文提供）
 */
export const CWPlaceholderValuesSchema = z.object({
  /** 当前操作员呼号，用于 {MYCALL} */
  myCall: z.string().optional(),
  /** 当前通联对象呼号，用于 {HISCALL} */
  hisCall: z.string().optional(),
});

export type CWPlaceholderValues = z.infer<typeof CWPlaceholderValuesSchema>;

/**
 * CW 文字输入
 */
export const CWTextInputSchema = z.object({
  /** 要发送的文字 */
  text: z.string().min(1).max(500),
  /** 操作员呼号，用于占位符替换（如 {MYCALL}） */
  callsign: z.string().optional(),
  /** 前端解析出的占位符值 */
  placeholderValues: CWPlaceholderValuesSchema.optional(),
});

export type CWTextInput = z.infer<typeof CWTextInputSchema>;

/**
 * CW 播放预设报文请求
 */
export const CWPlayMessageSchema = z.object({
  /** 呼号 */
  callsign: z.string(),
  /** 报文槽位 ID */
  slotId: z.string(),
  /** 是否循环播放 */
  repeat: z.boolean().optional().default(false),
  /** 是否立即发送；false 时仅进入循环等待 */
  startImmediately: z.boolean().optional(),
  /** 前端解析出的占位符值 */
  placeholderValues: CWPlaceholderValuesSchema.optional(),
});

export type CWPlayMessage = z.infer<typeof CWPlayMessageSchema>;

/**
 * CW 报文槽位更新
 */
export const CWMessageSlotUpdateSchema = z.object({
  label: z.string().max(32).optional(),
  text: z.string().max(500).optional(),
  repeatEnabled: z.boolean().optional(),
  repeatIntervalSec: z.number().int().min(1).max(300).optional(),
});

export type CWMessageSlotUpdate = z.infer<typeof CWMessageSlotUpdateSchema>;

/**
 * CW 报文面板更新
 */
export const CWMessagePanelUpdateSchema = z.object({
  slotCount: z.number().int().min(3).max(12),
});

export type CWMessagePanelUpdate = z.infer<typeof CWMessagePanelUpdateSchema>;

/**
 * CW 报文槽位交换请求
 */
export const CWMessageSlotSwapSchema = z.object({
  slotIdA: z.string(),
  slotIdB: z.string(),
});

export type CWMessageSlotSwap = z.infer<typeof CWMessageSlotSwapSchema>;
