import { z } from 'zod';

/**
 * FT8周期枚举
 */
export enum FT8Cycle {
  EVEN = 0,
  ODD = 1
}

/**
 * 周期信息
 */
export const CycleInfoSchema = z.object({
  /** 当前周期 */
  cycle: z.number(),
  /** 是否为发射周期 */
  isTransmit: z.boolean(),
  /** 周期开始时间（毫秒时间戳） */
  startTime: z.number(),
  /** 周期结束时间（毫秒时间戳） */
  endTime: z.number()
});

export type CycleInfo = z.infer<typeof CycleInfoSchema>; 