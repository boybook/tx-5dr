import { z } from 'zod';

/**
 * 模式描述符 - 定义 FT8/FT4 等模式的时序参数
 */
export const ModeDescriptorSchema = z.object({
  /** 模式名称，如 "FT8", "FT4" */
  name: z.string(),
  /** 时隙长度（毫秒），FT8=15000, FT4=7500 */
  slotMs: z.number().positive(),
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
   * FT8: 约1180ms (使12.64秒的音频在15秒时隙中居中)
   * FT4: 约550ms (使6.4秒的音频在7.5秒时隙中居中)
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
    windowTiming: [-1500, -1000, -500, 0, 250],
    transmitTiming: 1180, // (15000 - 12640) / 2 = 1180ms - 使音频在时隙中居中
    encodeAdvance: 400    // 提前开始编码准备
  } as ModeDescriptor,
  FT4: {
    name: 'FT4',
    slotMs: 7500,
    toleranceMs: 50,
    windowTiming: [0],
    transmitTiming: 550, // (7500 - 6400) / 2 = 550ms
    encodeAdvance: 500   // 提前500ms开始编码准备
  } as ModeDescriptor,
} as const; 