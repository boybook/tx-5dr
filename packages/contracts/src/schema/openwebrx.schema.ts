import { z } from 'zod';

/**
 * OpenWebRX SDR Profile 频率覆盖范围（持久化缓存）
 * Profile API 只返回 {id, name}，覆盖范围需切换到该 profile 后从 config 获取。
 * 缓存后避免重复探测（每次探测需 11s 冷却以规避 bot 检测）。
 */
export const OpenWebRXProfileCoverageSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  centerFreq: z.number(),
  sampRate: z.number(),
  lastUpdated: z.number(),
});

/**
 * OpenWebRX SDR 站点配置 Schema
 */
export const OpenWebRXStationConfigSchema = z.object({
  /** 站点唯一ID */
  id: z.string(),
  /** 用户定义的站点名称 */
  name: z.string().min(1),
  /** WebSocket URL，如 "ws://host:8073" 或 "wss://..." */
  url: z.string().url(),
  /** 站点描述 */
  description: z.string().optional(),
  /** 已知的 Profile 频率覆盖范围缓存（持久化，重启后无需重新探测） */
  profileCoverages: z.array(OpenWebRXProfileCoverageSchema).optional(),
});

/**
 * OpenWebRX SDR Profile 信息（远端服务器返回）
 */
export const OpenWebRXProfileSchema = z.object({
  /** Profile ID，格式为 "sdr_id|profile_id" */
  id: z.string(),
  /** 显示名称 */
  name: z.string(),
});

/**
 * OpenWebRX 连接测试结果
 */
export const OpenWebRXTestResultSchema = z.object({
  success: z.boolean(),
  /** 服务器版本 */
  serverVersion: z.string().optional(),
  /** 可用的 SDR Profile 列表 */
  profiles: z.array(OpenWebRXProfileSchema).optional(),
  /** 错误信息 */
  error: z.string().optional(),
});

/**
 * OpenWebRX 试听状态
 */
export const OpenWebRXListenStatusSchema = z.object({
  /** 试听会话ID，用于生成 LiveKit preview 房间 */
  previewSessionId: z.string().optional(),
  /** 站点ID */
  stationId: z.string(),
  /** 是否已连接 */
  connected: z.boolean(),
  /** 服务器版本 */
  serverVersion: z.string().optional(),
  /** 可用 Profile 列表 */
  profiles: z.array(OpenWebRXProfileSchema),
  /** 当前选中的 Profile ID */
  currentProfileId: z.string().optional(),
  /** 当前中心频率 (Hz) */
  centerFreq: z.number().optional(),
  /** 当前采样率 (Hz) */
  sampleRate: z.number().optional(),
  /** 当前 tune 频率 (Hz) */
  frequency: z.number().optional(),
  /** 当前调制模式 */
  modulation: z.string().optional(),
  /** S-Meter 读数 (dBFS) */
  smeterDb: z.number().optional(),
  /** 是否正在试听 */
  isListening: z.boolean(),
  /** 错误信息 */
  error: z.string().optional(),
});

/**
 * OpenWebRX 试听启动参数
 */
export const OpenWebRXListenStartSchema = z.object({
  /** 站点ID */
  stationId: z.string(),
  /** 指定 Profile ID（可选，不指定则使用默认） */
  profileId: z.string().optional(),
  /** 频率 (Hz) */
  frequency: z.number().optional(),
  /** 调制模式 */
  modulation: z.string().optional(),
});

/**
 * OpenWebRX 试听调整参数
 */
export const OpenWebRXListenTuneSchema = z.object({
  /** 切换到的 Profile ID */
  profileId: z.string().optional(),
  /** 频率 (Hz) */
  frequency: z.number().optional(),
  /** 调制模式 */
  modulation: z.string().optional(),
  /** 带通滤波器低端 (Hz) */
  bandpassLow: z.number().optional(),
  /** 带通滤波器高端 (Hz) */
  bandpassHigh: z.number().optional(),
});

/**
 * Server → Client: 请求管理员手动选择 SDR Profile
 * 当引擎自动匹配（缓存 + 名称启发式）全部失败时发出
 */
export const OpenWebRXProfileSelectRequestSchema = z.object({
  requestId: z.string(),
  targetFrequency: z.number(),
  profiles: z.array(z.object({ id: z.string(), name: z.string() })),
  currentProfileId: z.string().optional(),
});

/**
 * Client → Server: 用户选择了 Profile 并请求验证
 */
export const OpenWebRXProfileSelectResponseSchema = z.object({
  requestId: z.string(),
  profileId: z.string(),
  targetFrequency: z.number(),
});

/**
 * Server → Client: Profile 验证结果
 */
export const OpenWebRXProfileVerifyResultSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  profileId: z.string(),
  profileName: z.string().optional(),
  centerFreq: z.number().optional(),
  sampRate: z.number().optional(),
  error: z.string().optional(),
});

// 导出类型
export type OpenWebRXStationConfig = z.infer<typeof OpenWebRXStationConfigSchema>;
export type OpenWebRXProfile = z.infer<typeof OpenWebRXProfileSchema>;
export type OpenWebRXProfileCoverage = z.infer<typeof OpenWebRXProfileCoverageSchema>;
export type OpenWebRXTestResult = z.infer<typeof OpenWebRXTestResultSchema>;
export type OpenWebRXListenStatus = z.infer<typeof OpenWebRXListenStatusSchema>;
export type OpenWebRXListenStart = z.infer<typeof OpenWebRXListenStartSchema>;
export type OpenWebRXListenTune = z.infer<typeof OpenWebRXListenTuneSchema>;
export type OpenWebRXProfileSelectRequest = z.infer<typeof OpenWebRXProfileSelectRequestSchema>;
export type OpenWebRXProfileSelectResponse = z.infer<typeof OpenWebRXProfileSelectResponseSchema>;
export type OpenWebRXProfileVerifyResult = z.infer<typeof OpenWebRXProfileVerifyResultSchema>;
