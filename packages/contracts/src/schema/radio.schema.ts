import { z } from 'zod';

/**
 * 预设频率Schema
 */
export const PresetFrequencySchema = z.object({
  band: z.string(),
  mode: z.string(), // 协议模式，如 FT8, FT4
  radioMode: z.string().optional(), // 电台调制模式，如 USB, LSB, AM, FM
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
 * 串口配置参数Schema
 */
export const SerialConfigSchema = z.object({
  // 基础串口设置
  data_bits: z.enum(['5', '6', '7', '8']).optional(),
  stop_bits: z.enum(['1', '2']).optional(),
  serial_parity: z.enum(['None', 'Even', 'Odd', 'Mark', 'Space']).optional(),
  serial_handshake: z.enum(['None', 'Hardware', 'Software']).optional(),
  
  // 控制信号
  rts_state: z.enum(['ON', 'OFF', 'UNSET']).optional(),
  dtr_state: z.enum(['ON', 'OFF', 'UNSET']).optional(),
  
  // 通信设置
  rate: z.number().int().min(150).max(4000000).optional(), // 波特率
  timeout: z.number().int().min(0).optional(), // 超时时间(ms)
  retry: z.number().int().min(0).optional(), // 重试次数
  
  // 时序控制
  write_delay: z.number().int().min(0).optional(), // 字节间延迟(ms)
  post_write_delay: z.number().int().min(0).optional(), // 命令间延迟(ms)
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
  serialConfig: SerialConfigSchema.optional(),
  // 发射时序补偿（毫秒）- 用于补偿电台和网络的处理延迟
  // 正值表示提前发射，负值表示延后发射
  // 范围限制：-1000~1000ms，适用于各种网络和设备延迟场景
  transmitCompensationMs: z.number().int().min(-1000).max(1000).optional(),
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
export type SerialConfig = z.infer<typeof SerialConfigSchema>;
export type HamlibConfig = z.infer<typeof HamlibConfigSchema>;
export type RadioConfigResponse = z.infer<typeof RadioConfigResponseSchema>;
export type SupportedRig = z.infer<typeof SupportedRigSchema>;
export type SupportedRigsResponse = z.infer<typeof SupportedRigsResponseSchema>;
export type SerialPort = z.infer<typeof SerialPortSchema>;
export type SerialPortsResponse = z.infer<typeof SerialPortsResponseSchema>;
export type TestResponse = z.infer<typeof TestResponseSchema>;
