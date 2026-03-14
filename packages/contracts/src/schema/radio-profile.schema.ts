import { z } from 'zod';
import { HamlibConfigSchema } from './radio.schema.js';
import { AudioDeviceSettingsSchema } from './audio.schema.js';

/**
 * Radio Profile Schema
 *
 * Profile 是电台+音频配置的一等公民，取代分散的 radio/audio 配置。
 * 底层系统从 activeProfile 派生运行时配置。
 */
export const RadioProfileSchema = z.object({
  id: z.string(),
  name: z.string(),                        // "IC-705 WiFi", "FT-991A 串口", "纯监听"
  radio: HamlibConfigSchema,               // 电台连接配置
  audio: AudioDeviceSettingsSchema,        // 音频设备配置
  audioLockedToRadio: z.boolean(),         // ICOM WLAN = true，音频由电台决定
  createdAt: z.number(),
  updatedAt: z.number(),
  description: z.string().optional(),
});

export type RadioProfile = z.infer<typeof RadioProfileSchema>;

/**
 * 创建 Profile 请求
 */
export const CreateProfileRequestSchema = z.object({
  name: z.string().min(1, 'Profile 名称不能为空'),
  radio: HamlibConfigSchema,
  audio: AudioDeviceSettingsSchema.optional(),
  description: z.string().optional(),
});

export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

/**
 * 更新 Profile 请求
 */
export const UpdateProfileRequestSchema = z.object({
  name: z.string().min(1).optional(),
  radio: HamlibConfigSchema.optional(),
  audio: AudioDeviceSettingsSchema.optional(),
  audioLockedToRadio: z.boolean().optional(),
  description: z.string().optional(),
});

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

/**
 * Profile 列表响应
 */
export const ProfileListResponseSchema = z.object({
  profiles: z.array(RadioProfileSchema),
  activeProfileId: z.string().nullable(),
});

export type ProfileListResponse = z.infer<typeof ProfileListResponseSchema>;

/**
 * Profile 操作响应
 */
export const ProfileActionResponseSchema = z.object({
  success: z.boolean(),
  profile: RadioProfileSchema.optional(),
  message: z.string().optional(),
});

export type ProfileActionResponse = z.infer<typeof ProfileActionResponseSchema>;

/**
 * Profile 激活响应
 */
export const ActivateProfileResponseSchema = z.object({
  success: z.boolean(),
  profile: RadioProfileSchema,
  wasRunning: z.boolean(),
});

export type ActivateProfileResponse = z.infer<typeof ActivateProfileResponseSchema>;

/**
 * Profile 变更事件数据
 */
export const ProfileChangedEventSchema = z.object({
  profileId: z.string(),
  profile: RadioProfileSchema,
  previousProfileId: z.string().nullable(),
  wasRunning: z.boolean(),
});

export type ProfileChangedEvent = z.infer<typeof ProfileChangedEventSchema>;
