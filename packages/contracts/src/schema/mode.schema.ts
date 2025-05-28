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
  windowTiming: z.array(z.number())
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
    // 单窗口模式：在时隙结束时立即进行解码（偏移0秒，获取完整15秒数据）
    windowTiming: [0]
  } as ModeDescriptor,
  
  FT4: {
    name: 'FT4', 
    slotMs: 7500,
    toleranceMs: 50,
    // 双窗口模式：在时隙结束时和结束后3.75秒时进行解码
    windowTiming: [0, 3750]
  } as ModeDescriptor,
  
  // 多窗口 FT8 测试模式 - 在15秒时隙结束后进行4次解码，包含负偏移
  'FT8-MultiWindow': {
    name: 'FT8-MultiWindow',
    slotMs: 15000,
    toleranceMs: 100,
    // 四个解码窗口的偏移：结束前1秒、结束时、结束后1秒、结束后2秒
    // 每个窗口都会获取15秒的音频数据进行解码
    // 负偏移可以获取时隙结束前的音频数据
    windowTiming: [-3000, -2000, -1000, 0, 1000, 2000]
  } as ModeDescriptor,
} as const; 