import { z } from 'zod';

/**
 * Shared message-panel contract for keyboard operating modes (CW, RTTY).
 * Each mode stores its own panels; the wire shape is identical.
 */

/** 报文槽位 */
export const KeyboardMessageSlotSchema = z.object({
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
export type KeyboardMessageSlot = z.infer<typeof KeyboardMessageSlotSchema>;

/** 报文面板 */
export const KeyboardMessagePanelSchema = z.object({
  /** 呼号 */
  callsign: z.string(),
  /** 当前槽位数 */
  slotCount: z.number().int().min(3).max(12),
  /** 最大槽位数 */
  maxSlotCount: z.number().int().min(12),
  /** 槽位列表 */
  slots: z.array(KeyboardMessageSlotSchema),
});
export type KeyboardMessagePanel = z.infer<typeof KeyboardMessagePanelSchema>;

/** 报文占位符值（由前端根据当前 UI 上下文提供） */
export const KeyboardPlaceholderValuesSchema = z.object({
  /** 当前操作员呼号，用于 {MYCALL} */
  myCall: z.string().optional(),
  /** 当前通联对象呼号，用于 {HISCALL} */
  hisCall: z.string().optional(),
  /** 发送的 RST 信号报告，用于 {TRST} */
  trst: z.string().optional(),
  /** 接收的 RST 信号报告，用于 {RRST} */
  rrst: z.string().optional(),
});
export type KeyboardPlaceholderValues = z.infer<typeof KeyboardPlaceholderValuesSchema>;

/** 报文槽位更新 */
export const KeyboardMessageSlotUpdateSchema = z.object({
  label: z.string().max(32).optional(),
  text: z.string().max(500).optional(),
  repeatEnabled: z.boolean().optional(),
  repeatIntervalSec: z.number().int().min(1).max(300).optional(),
});
export type KeyboardMessageSlotUpdate = z.infer<typeof KeyboardMessageSlotUpdateSchema>;

/** 报文面板更新 */
export const KeyboardMessagePanelUpdateSchema = z.object({
  slotCount: z.number().int().min(3).max(12),
});
export type KeyboardMessagePanelUpdate = z.infer<typeof KeyboardMessagePanelUpdateSchema>;

/** 报文槽位交换请求 */
export const KeyboardMessageSlotSwapSchema = z.object({
  slotIdA: z.string(),
  slotIdB: z.string(),
});
export type KeyboardMessageSlotSwap = z.infer<typeof KeyboardMessageSlotSwapSchema>;
