import { z } from 'zod';
import {
  KeyboardMessagePanelSchema,
  KeyboardMessagePanelUpdateSchema,
  KeyboardMessageSlotSchema,
  KeyboardMessageSlotSwapSchema,
  KeyboardMessageSlotUpdateSchema,
  KeyboardPlaceholderValuesSchema,
} from './keyboard-message.schema.js';

/**
 * CW 键控器配置
 */
export const CWKeyerBackendSchema = z.enum(['cat', 'serial']);
export type CWKeyerBackend = z.infer<typeof CWKeyerBackendSchema>;

export const CWKeyActiveLevelSchema = z.enum(['high', 'low']);
export type CWKeyActiveLevel = z.infer<typeof CWKeyActiveLevelSchema>;

export const CWKeyerConfigSchema = z.object({
  /** CW 发报后端：cat=Hamlib 整报文，serial=DTR/RTS 时序键控 */
  backend: CWKeyerBackendSchema.default('cat'),
  /** CW 键控串口路径（用于 DTR/RTS 引脚控制） */
  keyPort: z.string(),
  /** CW 键控引脚类型 */
  keyMethod: z.enum(['dtr', 'rts']),
  /** CW 键控有效电平：high=高电平按下，low=低电平按下 */
  keyActiveLevel: CWKeyActiveLevelSchema.default('high'),
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
  /** 当前正在发送的文本（只读状态字段） */
  currentText: z.string().nullable().optional(),
  /** 最近一次发送的文本（只读状态字段） */
  lastText: z.string().nullable().optional(),
});

export type CWKeyerStatus = z.infer<typeof CWKeyerStatusSchema>;

/**
 * CW 报文槽位
 */
export const CWMessageSlotSchema = KeyboardMessageSlotSchema;

export type CWMessageSlot = z.infer<typeof CWMessageSlotSchema>;

/**
 * CW 报文面板
 */
export const CWMessagePanelSchema = KeyboardMessagePanelSchema;

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
export const CWPlaceholderValuesSchema = KeyboardPlaceholderValuesSchema;

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
export const CWMessageSlotUpdateSchema = KeyboardMessageSlotUpdateSchema;

export type CWMessageSlotUpdate = z.infer<typeof CWMessageSlotUpdateSchema>;

/**
 * CW 报文面板更新
 */
export const CWMessagePanelUpdateSchema = KeyboardMessagePanelUpdateSchema;

export type CWMessagePanelUpdate = z.infer<typeof CWMessagePanelUpdateSchema>;

/**
 * CW 报文槽位交换请求
 */
export const CWMessageSlotSwapSchema = KeyboardMessageSlotSwapSchema;

export type CWMessageSlotSwap = z.infer<typeof CWMessageSlotSwapSchema>;
