import { z } from 'zod';

// FT8解码帧信息（基于wsjtx-lib的数据类型）
export const FT8DecodeSchema = z.object({
  // 时间戳
  timestamp: z.number(),
  // 信噪比
  snr: z.number(),
  // 时间偏移（秒）
  dt: z.number(),
  // 频率偏移（Hz）
  df: z.number(),
  // 解码的消息文本
  message: z.string(),
  // 是否为低置信度解码
  lowConfidence: z.boolean().optional(),
  // 解码周期（15秒周期内的序号）
  cycle: z.number(),
});

// FT8编码请求
export const FT8EncodeRequestSchema = z.object({
  message: z.string(),
  frequency: z.number().optional(),
  // 发射功率（dBm）
  power: z.number().optional(),
});

// FT8编码响应
export const FT8EncodeResponseSchema = z.object({
  success: z.boolean(),
  audioData: z.array(z.number()).optional(),
  duration: z.number().optional(),
  error: z.string().optional(),
});

// FT8解码帧列表响应
export const FT8DecodesResponseSchema = z.object({
  decodes: z.array(FT8DecodeSchema),
  cycle: z.number(),
  timestamp: z.number(),
});

// FT8频谱数据
export const FT8SpectrumSchema = z.object({
  // FFT数据
  fftData: z.array(z.number()),
  // 频率范围
  frequencyRange: z.object({
    min: z.number(),
    max: z.number(),
  }),
  // 时间戳
  timestamp: z.number(),
  // 采样率
  sampleRate: z.number(),
});

// FT8频谱响应
export const FT8SpectrumResponseSchema = z.object({
  spectrum: FT8SpectrumSchema,
});

// FT8发射控制请求
export const FT8TransmitRequestSchema = z.object({
  message: z.string(),
  frequency: z.number(),
  // 是否立即发射
  immediate: z.boolean().optional(),
  // 发射周期（如果不是立即发射）
  cycle: z.number().optional(),
});

// FT8发射控制响应
export const FT8TransmitResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  scheduledCycle: z.number().optional(),
});

export type FT8Decode = z.infer<typeof FT8DecodeSchema>;
export type FT8EncodeRequest = z.infer<typeof FT8EncodeRequestSchema>;
export type FT8EncodeResponse = z.infer<typeof FT8EncodeResponseSchema>;
export type FT8DecodesResponse = z.infer<typeof FT8DecodesResponseSchema>;
export type FT8Spectrum = z.infer<typeof FT8SpectrumSchema>;
export type FT8SpectrumResponse = z.infer<typeof FT8SpectrumResponseSchema>;
export type FT8TransmitRequest = z.infer<typeof FT8TransmitRequestSchema>;
export type FT8TransmitResponse = z.infer<typeof FT8TransmitResponseSchema>; 