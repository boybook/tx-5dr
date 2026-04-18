import { z } from 'zod';

/**
 * 模式描述符 - 定义 FT8/FT4 等模式的时序参数
 */
export const ModeDescriptorSchema = z.object({
  /** 模式名称，如 "FT8", "FT4" */
  name: z.string(),
  /** 时隙长度（毫秒），FT8=15000, FT4=7500, VOICE=0 */
  slotMs: z.number().nonnegative(),
  /** 时钟容差（毫秒） */
  toleranceMs: z.number().nonnegative().default(100),
  /** 
   * 窗口时机（毫秒）- 必需
   * 使用这些时机作为从时隙结束时间的偏移量
   * 每个窗口都会获取固定长度的解码数据（FT8: 15秒，FT4: 7.5秒）
   * 数组长度决定了子窗口的数量
   * 支持负偏移，可以获取时隙结束前或其他周期的音频数据
   */
  windowTiming: z.array(z.number()),
  /**
   * 发射时机（毫秒）- 从时隙开始的延迟
   * 对齐 WSJT-X 标准：信号在时隙边界后 ~0.5s 开始
   * FT8: 500ms（信号 T+0.5s 起，12.64s 长，T+13.14s 结束）
   * FT4: 500ms（信号 T+0.5s 起，6.0s 长，T+6.5s 结束，留 1.0s 给末端解码）
   */
  transmitTiming: z.number().nonnegative(),
  /**
   * 编码提前量（毫秒）- 在transmitTiming之前多久开始编码
   * 默认400ms,用于补偿编码+混音时间
   */
  encodeAdvance: z.number().nonnegative().default(400)
});

export type ModeDescriptor = z.infer<typeof ModeDescriptorSchema>;

/**
 * 预定义的模式
 */
export const MODES = {
  FT8: {
    name: 'FT8',
    slotMs: 15000,
    toleranceMs: 100,
    windowTiming: [-3200, -1500, -300], // WSJT-X 标准：11.8s / 13.5s / 14.7s 三轮解码
    transmitTiming: 500,  // WSJT-X 标准：信号在时隙边界后 ~0.5s 开始
    encodeAdvance: 0      // 编码在 transmitStart 时触发，留出 500ms 给策略决策
  } as ModeDescriptor,
  FT4: {
    name: 'FT4',
    slotMs: 7500,
    toleranceMs: 50,
    // 双 pass 解码：T+6000ms 早 pass（让下一周期 encodeStart 之前能拿到对端消息）+ T+7500ms 末 pass
    windowTiming: [-1500, 0],
    transmitTiming: 500, // WSJT-X 标准：FT4 信号 T+0.5s 起，6.0s 长
    encodeAdvance: 300   // encodeStart 在 T+200ms 触发，留 ~300ms 给编码完成，使 transmitStart 时音频已就绪
  } as ModeDescriptor,
  VOICE: {
    name: 'VOICE',
    slotMs: 0,            // 语音模式无时隙概念
    toleranceMs: 0,
    windowTiming: [],     // 无解码窗口
    transmitTiming: 0,
    encodeAdvance: 0,
  } as ModeDescriptor,
} as const;

/**
 * 解码窗口预设
 */
export const DecodeWindowPreset = {
  MAXIMUM: 'maximum',
  BALANCED: 'balanced',
  LIGHTWEIGHT: 'lightweight',
  MINIMUM: 'minimum',
  CUSTOM: 'custom',
} as const;

/**
 * FT8 解码窗口预设映射
 * 偏移量基于时隙结束时间（T+15000ms），即 offset = 实际触发时间 - 15000
 * FT8 信号：T+500ms 开始，T+13140ms 结束（12.64s）
 * WSJT-X 标准三轮：T+11.8s(-3200) / T+13.5s(-1500) / T+14.7s(-300)
 */
export const FT8_WINDOW_PRESETS: Record<string, number[]> = {
  maximum: [-3200, -1500, -800, -300, -150],  // 5 轮
  balanced: [-3200, -1500, -300],               // 3 轮：WSJT-X 标准时序
  lightweight: [-3200, -300],                    // 2 轮：首尾两轮
  minimum: [-300],                               // 1 轮：信号结束后最终解码
};

/**
 * FT4 解码窗口预设映射
 * 偏移量基于时隙结束时间（T+7500ms）
 * FT4 信号：T+500ms 开始，T+6500ms 结束（6.0s）
 * 双 pass 设计对齐 WSJT-X/JTDX：早 pass 让下一周期 encodeStart 前能用上结果
 */
export const FT4_WINDOW_PRESETS: Record<string, number[]> = {
  maximum: [-2000, -1000, 0],   // 3 轮：T+5.5s / T+6.5s / T+7.5s
  balanced: [-1500, 0],          // 2 轮：T+6.0s（早 pass）+ T+7.5s（末 pass）
  lightweight: [0],              // 1 轮：仅末端
};

/**
 * 解码窗口设置 Schema
 */
export const DecodeWindowSettingsSchema = z.object({
  ft8: z.object({
    preset: z.enum(['maximum', 'balanced', 'lightweight', 'minimum', 'custom']).default('balanced'),
    customWindowTiming: z.array(z.number().int().min(-5000).max(1000)).optional(),
  }).optional(),
  ft4: z.object({
    preset: z.enum(['maximum', 'balanced', 'lightweight', 'custom']).default('balanced'),
    customWindowTiming: z.array(z.number().int().min(-5000).max(1000)).optional(),
  }).optional(),
});

export type DecodeWindowSettings = z.infer<typeof DecodeWindowSettingsSchema>;

export const DEFAULT_DECODE_WINDOW_SETTINGS: DecodeWindowSettings = {
  ft8: {
    preset: 'balanced',
  },
  ft4: {
    preset: 'balanced',
  },
};

/**
 * 根据模式名和设置解析实际的 windowTiming
 * 返回 null 表示使用 MODES 中的默认值
 */
export function resolveWindowTiming(
  modeName: string,
  settings?: DecodeWindowSettings
): number[] | null {
  if (!settings) return null;

  const modeKey = modeName.toUpperCase();

  if (modeKey === 'FT8' && settings.ft8) {
    const { preset, customWindowTiming } = settings.ft8;
    if (preset === 'custom' && customWindowTiming && customWindowTiming.length > 0) {
      return [...customWindowTiming].sort((a, b) => a - b);
    }
    return FT8_WINDOW_PRESETS[preset] ?? null;
  }

  if (modeKey === 'FT4' && settings.ft4) {
    const { preset, customWindowTiming } = settings.ft4;
    if (preset === 'custom' && customWindowTiming && customWindowTiming.length > 0) {
      return [...customWindowTiming].sort((a, b) => a - b);
    }
    return FT4_WINDOW_PRESETS[preset] ?? null;
  }

  return null;
}
