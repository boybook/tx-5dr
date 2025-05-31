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
  // 时间戳
  timestamp: z.number(),
  // 采样率
  sampleRate: z.number(),
  // 频率范围
  frequencyRange: z.object({
    min: z.number(),
    max: z.number(),
  }),
  // 二进制频谱数据
  binaryData: z.object({
    // 二进制数据，使用base64编码
    data: z.string(),
    // 数据格式描述
    format: z.object({
      type: z.literal('int16'),
      // 数据点数量
      length: z.number(),
      // 缩放因子（可选）
      scale: z.number().optional(),
      // 偏移量（可选）
      offset: z.number().optional(),
    }),
  }),
  // 频谱数据摘要
  summary: z.object({
    // 峰值频率（Hz）
    peakFrequency: z.number(),
    // 峰值幅度（dB）
    peakMagnitude: z.number(),
    // 平均幅度（dB）
    averageMagnitude: z.number(),
    // 动态范围（dB）
    dynamicRange: z.number(),
    // 能量分布（可选）
    energyDistribution: z.array(z.number()).optional(),
  }).optional(),
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

// FT8消息类型常量
export const FT8MessageType = {
  CQ: 'cq',           // CQ呼叫
  CALL: 'call',         // 响应呼叫
  SIGNAL_REPORT: 'signal_report',// 信号报告
  ROGER_REPORT: 'roger_report', // 确认信号报告
  RRR: 'rrr',          // RRR确认
  SEVENTY_THREE: '73',           // 73告别
  CUSTOM: 'custom',       // 自定义消息
  UNKNOWN: 'unknown',      // 未知消息类型
} as const;

// FT8消息类型
export const FT8MessageTypeSchema = z.enum([
  FT8MessageType.CQ,
  FT8MessageType.CALL,
  FT8MessageType.SIGNAL_REPORT,
  FT8MessageType.ROGER_REPORT,
  FT8MessageType.RRR,
  FT8MessageType.SEVENTY_THREE,
  FT8MessageType.CUSTOM,
  FT8MessageType.UNKNOWN,
]);

// FT8消息基础schema
export const FT8MessageBaseSchema = z.object({
  type: FT8MessageTypeSchema,
});

// FT8消息具体类型schema
export const FT8MessageCQSchema = FT8MessageBaseSchema.extend({
  type: z.literal('cq'),
  senderCallsign: z.string(),
  flag: z.string().optional(),
  grid: z.string().optional(),
});

export const FT8MessageCallSchema = FT8MessageBaseSchema.extend({
  type: z.literal('call'),
  senderCallsign: z.string(),
  targetCallsign: z.string(),
  grid: z.string().optional(),
});

export const FT8MessageSignalReportSchema = FT8MessageBaseSchema.extend({
  type: z.literal('signal_report'),
  senderCallsign: z.string(),
  targetCallsign: z.string(),
  report: z.number(),
});

export const FT8MessageRogerReportSchema = FT8MessageBaseSchema.extend({
  type: z.literal('roger_report'),
  senderCallsign: z.string(),
  targetCallsign: z.string(),
  report: z.number(),
});

export const FT8MessageRRRSchema = FT8MessageBaseSchema.extend({
  type: z.literal('rrr'),
  senderCallsign: z.string(),
  targetCallsign: z.string(),
});

export const FT8MessageSeventyThreeSchema = FT8MessageBaseSchema.extend({
  type: z.literal('73'),
  senderCallsign: z.string(),
  targetCallsign: z.string(),
});

export const FT8MessageCustomSchema = FT8MessageBaseSchema.extend({
  type: z.literal('custom'),
});

export const FT8MessageUnknownSchema = FT8MessageBaseSchema.extend({
  type: z.literal('unknown'),
});

// FT8消息联合类型
export const FT8MessageSchema = z.discriminatedUnion('type', [
  FT8MessageCQSchema,
  FT8MessageCallSchema,
  FT8MessageSignalReportSchema,
  FT8MessageRogerReportSchema,
  FT8MessageRRRSchema,
  FT8MessageSeventyThreeSchema,
  FT8MessageCustomSchema,
  FT8MessageUnknownSchema,
]);

// 解析后的FT8消息
export const ParsedFT8MessageSchema = z.object({
  snr: z.number(),
  dt: z.number(),
  df: z.number(),
  rawMessage: z.string(),
  message: FT8MessageSchema,
  slotId: z.string(),
  timestamp: z.number(),
});

export type FT8Decode = z.infer<typeof FT8DecodeSchema>;
export type FT8EncodeRequest = z.infer<typeof FT8EncodeRequestSchema>;
export type FT8EncodeResponse = z.infer<typeof FT8EncodeResponseSchema>;
export type FT8DecodesResponse = z.infer<typeof FT8DecodesResponseSchema>;
export type FT8Spectrum = z.infer<typeof FT8SpectrumSchema>;
export type FT8SpectrumResponse = z.infer<typeof FT8SpectrumResponseSchema>;
export type FT8TransmitRequest = z.infer<typeof FT8TransmitRequestSchema>;
export type FT8TransmitResponse = z.infer<typeof FT8TransmitResponseSchema>;
export type FT8MessageBase = z.infer<typeof FT8MessageBaseSchema>;
export type FT8MessageCQ = z.infer<typeof FT8MessageCQSchema>;
export type FT8MessageCall = z.infer<typeof FT8MessageCallSchema>;
export type FT8MessageSignalReport = z.infer<typeof FT8MessageSignalReportSchema>;
export type FT8MessageRogerReport = z.infer<typeof FT8MessageRogerReportSchema>;
export type FT8MessageRRR = z.infer<typeof FT8MessageRRRSchema>;
export type FT8MessageSeventyThree = z.infer<typeof FT8MessageSeventyThreeSchema>;
export type FT8MessageCustom = z.infer<typeof FT8MessageCustomSchema>;
export type FT8MessageUnknown = z.infer<typeof FT8MessageUnknownSchema>;
export type FT8Message = z.infer<typeof FT8MessageSchema>;
export type ParsedFT8Message = z.infer<typeof ParsedFT8MessageSchema>; 