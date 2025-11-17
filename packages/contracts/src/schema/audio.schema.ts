import { z } from 'zod';

// 音频设备信息
export const AudioDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  channels: z.number(),
  sampleRate: z.number(),
  type: z.enum(['input', 'output']),
});

// 音频设备列表响应
export const AudioDevicesResponseSchema = z.object({
  inputDevices: z.array(AudioDeviceSchema),
  outputDevices: z.array(AudioDeviceSchema),
});

// 音频设备设置请求
export const AudioDeviceSettingsSchema = z.object({
  inputDeviceName: z.string().optional(),  // 使用设备名称而非ID
  outputDeviceName: z.string().optional(), // 使用设备名称而非ID  
  sampleRate: z.number().optional(),
  bufferSize: z.number().optional(),
});

// 音频设备设置响应
export const AudioDeviceSettingsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  currentSettings: AudioDeviceSettingsSchema,
});

// 音频流配置参数 (用于 naudiodon2)
export const AudioStreamConfigSchema = z.object({
  channelCount: z.number().int().min(1).max(32),
  sampleFormat: z.number().int(), // naudiodon SampleFormat 枚举值
  sampleRate: z.number().int().min(8000).max(192000),
  deviceId: z.string().optional(),
  maxQueue: z.number().int().optional(),
  queueHighWaterMark: z.number().int().optional(),
});

// 音频流事件数据
export const AudioStreamEventDataSchema = z.object({
  type: z.enum(['started', 'stopped', 'error', 'audioData']),
  error: z.string().optional(),
  samples: z.number().optional(), // audioData 事件的样本数
});

// 音频混音配置
export const AudioMixerConfigSchema = z.object({
  operatorId: z.string(),
  audioData: z.instanceof(Float32Array).optional(), // 实际数据在运行时传递
  targetPlaybackTime: z.number(), // 目标播放时间戳 (ms)
  volumeGain: z.number().min(0).max(10).default(1.0),
});

// 音频音量控制
export const VolumeGainSchema = z.object({
  gain: z.number().min(0.001).max(10), // 线性增益
  gainDb: z.number().min(-60).max(20), // dB 单位增益
});

// 导出类型
export type AudioDevice = z.infer<typeof AudioDeviceSchema>;
export type AudioDevicesResponse = z.infer<typeof AudioDevicesResponseSchema>;
export type AudioDeviceSettings = z.infer<typeof AudioDeviceSettingsSchema>;
export type AudioDeviceSettingsResponse = z.infer<typeof AudioDeviceSettingsResponseSchema>;
export type AudioStreamConfig = z.infer<typeof AudioStreamConfigSchema>;
export type AudioStreamEventData = z.infer<typeof AudioStreamEventDataSchema>;
export type AudioMixerConfig = z.infer<typeof AudioMixerConfigSchema>;
export type VolumeGain = z.infer<typeof VolumeGainSchema>; 