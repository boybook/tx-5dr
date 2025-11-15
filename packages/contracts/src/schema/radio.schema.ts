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
 * 网络 RigCtld 连接配置Schema
 */
export const NetworkConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});

/**
 * ICOM WLAN 连接配置Schema
 */
export const IcomWlanConfigSchema = z.object({
  ip: z.string(),
  port: z.number().int().min(1).max(65535),
  userName: z.string().optional(),
  password: z.string().optional(),
  /**
   * 数据模式（Data Mode）
   * 启用时使用 USB-D 等数字模式，适用于 FT8/FT4 等数字通信
   * 默认值: true
   */
  dataMode: z.boolean().optional().default(true),
});

/**
 * 串口连接配置Schema
 */
export const SerialConnectionConfigSchema = z.object({
  path: z.string(),
  rigModel: z.number().int(),
  serialConfig: SerialConfigSchema.optional(),
});

/**
 * Hamlib配置Schema - 嵌套对象结构
 *
 * 设计理念：
 * - type: 当前使用的连接类型
 * - network/icomWlan/serial: 各连接类型的独立配置对象
 * - 所有配置对象共存，切换连接类型时保留历史配置
 * - 根据 type 字段读取对应的配置对象
 */
export const HamlibConfigSchema = z.object({
  type: z.enum(['none', 'network', 'serial', 'icom-wlan']),

  // 网络模式配置
  network: NetworkConfigSchema.optional(),

  // ICOM WLAN 模式配置
  icomWlan: IcomWlanConfigSchema.optional(),

  // 串口模式配置
  serial: SerialConnectionConfigSchema.optional(),

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
 * 电台信息Schema
 * 用于描述当前连接的电台的详细信息
 */
export const RadioInfoSchema = z.object({
  /** 制造商名称，如 "Yaesu", "ICOM", "Network" */
  manufacturer: z.string(),
  /** 型号名称，如 "FT-991A", "IC-705", "RigCtrl" */
  model: z.string(),
  /** Hamlib 电台型号 ID (serial/network 模式使用，icom-wlan 模式可选) */
  rigModel: z.number().optional(),
  /** 连接类型 */
  connectionType: z.enum(['serial', 'network', 'icom-wlan']),
  /** 固件版本 (如果可获取) */
  firmwareVersion: z.string().optional(),
  /** 序列号 (如果可获取) */
  serialNumber: z.string().optional(),
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
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
export type IcomWlanConfig = z.infer<typeof IcomWlanConfigSchema>;
export type SerialConnectionConfig = z.infer<typeof SerialConnectionConfigSchema>;
export type HamlibConfig = z.infer<typeof HamlibConfigSchema>;
export type RadioConfigResponse = z.infer<typeof RadioConfigResponseSchema>;
export type SupportedRig = z.infer<typeof SupportedRigSchema>;
export type SupportedRigsResponse = z.infer<typeof SupportedRigsResponseSchema>;
export type RadioInfo = z.infer<typeof RadioInfoSchema>;
export type SerialPort = z.infer<typeof SerialPortSchema>;
export type SerialPortsResponse = z.infer<typeof SerialPortsResponseSchema>;
export type TestResponse = z.infer<typeof TestResponseSchema>;
