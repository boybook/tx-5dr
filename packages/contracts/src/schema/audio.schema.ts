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
  inputDeviceId: z.string().optional(),
  outputDeviceId: z.string().optional(),
  sampleRate: z.number().optional(),
  bufferSize: z.number().optional(),
});

// 音频设备设置响应
export const AudioDeviceSettingsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  currentSettings: AudioDeviceSettingsSchema,
});

export type AudioDevice = z.infer<typeof AudioDeviceSchema>;
export type AudioDevicesResponse = z.infer<typeof AudioDevicesResponseSchema>;
export type AudioDeviceSettings = z.infer<typeof AudioDeviceSettingsSchema>;
export type AudioDeviceSettingsResponse = z.infer<typeof AudioDeviceSettingsResponseSchema>; 