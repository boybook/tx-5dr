import { z } from 'zod';

export const AudioDeviceBackendSchema = z.enum([
  'rtaudio',
  'android',
  'icom-wlan',
  'openwebrx',
  'tci',
  'network',
]);

export const AudioDeviceKindSchema = z.enum([
  'usb',
  'wired-headset',
  'wired-headphones',
  'analog-line',
  'builtin-mic',
  'builtin-speaker',
  'network',
  'virtual',
  'unknown',
]);

export const AudioDeviceTransportSchema = z.enum([
  'usb',
  'analog',
  'builtin',
  'network',
  'virtual',
  'unknown',
]);

export const AudioDeviceConnectorSchema = z.enum([
  'usb',
  '3.5mm',
  'builtin',
  'network',
  'virtual',
  'unknown',
]);

export const AudioDeviceRouteStateSchema = z.enum([
  'idle',
  'opening',
  'verified',
  'lost',
  'unavailable',
  'failed',
]);

export const AudioDeviceCapabilitiesSchema = z.object({
  sampleRates: z.array(z.number().int().positive()).optional(),
  bufferSizes: z.array(z.number().int().positive()).optional(),
  channelCounts: z.array(z.number().int().positive()).optional(),
  sampleFormats: z.array(z.enum(['float32', 'int16'])).optional(),
  channelModes: z.array(z.enum(['mono', 'left', 'right', 'both'])).optional(),
  sampleRateConfigurable: z.boolean().optional(),
  bufferSizeConfigurable: z.boolean().optional(),
  sampleFormatConfigurable: z.boolean().optional(),
  channelModeConfigurable: z.boolean().optional(),
  outputRouteAck: z.boolean().optional(),
  fixedSampleRate: z.number().int().positive().optional(),
  fixedBufferSize: z.number().int().positive().optional(),
  fixedChannelCount: z.number().int().positive().optional(),
});

// 音频设备信息
export const AudioDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  channels: z.number(),
  sampleRate: z.number(),
  sampleRates: z.array(z.number().int().positive()).optional(),
  type: z.enum(['input', 'output']),
  availability: z.enum(['available', 'cached', 'active']).optional(),
  isActiveByTx5dr: z.boolean().optional(),
  lastSeenAt: z.number().int().positive().optional(),
  backend: AudioDeviceBackendSchema.optional(),
  kind: AudioDeviceKindSchema.optional(),
  routeKey: z.string().min(1).optional(),
  transport: AudioDeviceTransportSchema.optional(),
  connector: AudioDeviceConnectorSchema.optional(),
  clientConnected: z.boolean().optional(),
  routeVerified: z.boolean().optional(),
  routeState: AudioDeviceRouteStateSchema.optional(),
  failureReason: z.string().min(1).optional(),
  capabilities: AudioDeviceCapabilitiesSchema.optional(),
});

export const AudioDeviceResolutionStatusSchema = z.enum([
  'selected',
  'default',
  'virtual-selected',
  'missing',
]);

export const AudioDeviceResolutionSchema = z.object({
  configuredDeviceName: z.string().nullable(),
  configuredRouteKey: z.string().nullable().optional(),
  configuredDevice: AudioDeviceSchema.nullable(),
  effectiveDevice: AudioDeviceSchema.nullable(),
  status: AudioDeviceResolutionStatusSchema,
  reason: z.string().nullable().optional(),
});

export const AudioDeviceResolutionSetSchema = z.object({
  input: AudioDeviceResolutionSchema,
  output: AudioDeviceResolutionSchema,
});

export const AudioOutputSampleFormatSchema = z.enum(['float32', 'int16']);
export const AudioOutputChannelModeSchema = z.enum(['mono', 'left', 'right', 'both']);

// 音频设备列表响应
export const AudioDevicesResponseSchema = z.object({
  inputDevices: z.array(AudioDeviceSchema),
  outputDevices: z.array(AudioDeviceSchema),
  inputBufferSizes: z.array(z.number().int().positive()),
  outputBufferSizes: z.array(z.number().int().positive()),
});

// 音频设备设置请求
export const AudioDeviceSettingsSchema = z.object({
  inputDeviceName: z.string().optional(),  // 使用设备名称而非ID
  outputDeviceName: z.string().optional(), // 使用设备名称而非ID  
  inputRouteKey: z.string().min(1).nullable().optional(),
  outputRouteKey: z.string().min(1).nullable().optional(),
  inputSampleRate: z.number().optional(),
  outputSampleRate: z.number().optional(),
  inputBufferSize: z.number().optional(),
  outputBufferSize: z.number().optional(),
  outputSampleFormat: AudioOutputSampleFormatSchema.optional(),
  outputChannelMode: AudioOutputChannelModeSchema.optional(),
  sampleRate: z.number().optional(),
  bufferSize: z.number().optional(),
});

// 音频设备设置响应
export const AudioDeviceSettingsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  currentSettings: AudioDeviceSettingsSchema,
  deviceResolution: AudioDeviceResolutionSetSchema,
});

export const AudioSettingsResolveRequestSchema = z.object({
  audio: AudioDeviceSettingsSchema,
  radioType: z.enum(['none', 'network', 'serial', 'icom-wlan', 'tci']).optional(),
});

export const AudioSettingsResolveResponseSchema = z.object({
  success: z.boolean(),
  deviceResolution: AudioDeviceResolutionSetSchema,
});

// 音频流配置参数 (用于 Audify/RtAudio)
export const AudioStreamConfigSchema = z.object({
  channelCount: z.number().int().min(1).max(32),
  sampleFormat: z.number().int(), // RtAudio SampleFormat 枚举值
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
export type AudioDeviceBackend = z.infer<typeof AudioDeviceBackendSchema>;
export type AudioDeviceKind = z.infer<typeof AudioDeviceKindSchema>;
export type AudioDeviceTransport = z.infer<typeof AudioDeviceTransportSchema>;
export type AudioDeviceConnector = z.infer<typeof AudioDeviceConnectorSchema>;
export type AudioDeviceRouteState = z.infer<typeof AudioDeviceRouteStateSchema>;
export type AudioDeviceCapabilities = z.infer<typeof AudioDeviceCapabilitiesSchema>;
export type AudioDeviceResolutionStatus = z.infer<typeof AudioDeviceResolutionStatusSchema>;
export type AudioDeviceResolution = z.infer<typeof AudioDeviceResolutionSchema>;
export type AudioDeviceResolutionSet = z.infer<typeof AudioDeviceResolutionSetSchema>;
export type AudioOutputSampleFormat = z.infer<typeof AudioOutputSampleFormatSchema>;
export type AudioOutputChannelMode = z.infer<typeof AudioOutputChannelModeSchema>;
export type AudioDevicesResponse = z.infer<typeof AudioDevicesResponseSchema>;
export type AudioDeviceSettings = z.infer<typeof AudioDeviceSettingsSchema>;
export type AudioDeviceSettingsResponse = z.infer<typeof AudioDeviceSettingsResponseSchema>;
export type AudioSettingsResolveRequest = z.infer<typeof AudioSettingsResolveRequestSchema>;
export type AudioSettingsResolveResponse = z.infer<typeof AudioSettingsResolveResponseSchema>;
export type AudioStreamConfig = z.infer<typeof AudioStreamConfigSchema>;
export type AudioStreamEventData = z.infer<typeof AudioStreamEventDataSchema>;
export type AudioMixerConfig = z.infer<typeof AudioMixerConfigSchema>;
export type VolumeGain = z.infer<typeof VolumeGainSchema>;
