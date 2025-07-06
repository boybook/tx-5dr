import { z } from 'zod';

/**
 * 预设频率Schema
 */
export const PresetFrequencySchema = z.object({
  band: z.string(),
  mode: z.string(),
  frequency: z.number(),
  description: z.string().optional(),
});

/**
 * 频率列表响应Schema
 */
export const FrequencyListResponseSchema = z.object({
  success: z.boolean(),
  presets: z.array(PresetFrequencySchema),
});

/**
 * Hamlib配置Schema
 */
export const HamlibConfigSchema = z.object({
  type: z.enum(['none', 'network', 'serial']),
  // 网络模式配置
  host: z.string().optional(),
  port: z.number().optional(),
  // 串口模式配置  
  path: z.string().optional(),
  rigModel: z.number().optional(),
});

/**
 * 电台配置响应Schema
 */
export const RadioConfigResponseSchema = z.object({
  success: z.boolean(),
  config: HamlibConfigSchema,
});

/**
 * 支持的电台型号Schema
 */
export const SupportedRigSchema = z.object({
  rigModel: z.number(),
  mfgName: z.string(),
  modelName: z.string(),
});

/**
 * 支持的电台列表响应Schema
 */
export const SupportedRigsResponseSchema = z.object({
  rigs: z.array(SupportedRigSchema),
});

/**
 * 串口信息Schema
 */
export const SerialPortSchema = z.object({
  path: z.string(),
  manufacturer: z.string().optional(),
  serialNumber: z.string().optional(),
  pnpId: z.string().optional(),
  locationId: z.string().optional(),
  productId: z.string().optional(),
  vendorId: z.string().optional(),
});

/**
 * 串口列表响应Schema
 */
export const SerialPortsResponseSchema = z.object({
  ports: z.array(SerialPortSchema),
});

/**
 * 测试响应Schema
 */
export const TestResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

// 导出类型
export type PresetFrequency = z.infer<typeof PresetFrequencySchema>;
export type FrequencyListResponse = z.infer<typeof FrequencyListResponseSchema>;
export type HamlibConfig = z.infer<typeof HamlibConfigSchema>;
export type RadioConfigResponse = z.infer<typeof RadioConfigResponseSchema>;
export type SupportedRig = z.infer<typeof SupportedRigSchema>;
export type SupportedRigsResponse = z.infer<typeof SupportedRigsResponseSchema>;
export type SerialPort = z.infer<typeof SerialPortSchema>;
export type SerialPortsResponse = z.infer<typeof SerialPortsResponseSchema>;
export type TestResponse = z.infer<typeof TestResponseSchema>;
