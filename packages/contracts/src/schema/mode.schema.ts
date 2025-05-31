import { z } from 'zod';

/**
 * 周期类型枚举
 */
export enum CycleType {
  /** 偶数/奇数周期（如 FT8） */
  EVEN_ODD = 'EVEN_ODD',
  /** 连续周期（如 FT4） */
  CONTINUOUS = 'CONTINUOUS'
}

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
   * 周期类型
   * EVEN_ODD: 偶数/奇数周期（如 FT8）
   * CONTINUOUS: 连续周期（如 FT4）
   */
  cycleType: z.nativeEnum(CycleType)
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
    windowTiming: [-2000, -1500, -1000, -500, -250, 0, 250, 500, 1000],
    cycleType: CycleType.EVEN_ODD
  } as ModeDescriptor,
  FT4: {
    name: 'FT4', 
    slotMs: 7500,
    toleranceMs: 50,
    // 双窗口模式：在时隙结束时和结束后3.75秒时进行解码
    windowTiming: [0, 3750],
    cycleType: CycleType.CONTINUOUS
  } as ModeDescriptor,
  
} as const; 