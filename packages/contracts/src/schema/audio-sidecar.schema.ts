import { z } from 'zod';

/**
 * AudioSidecar 状态：描述本地音频子系统的旁路生命周期。
 * 与电台 CAT 连接解耦——主引擎已进入 RUNNING，但音频可能仍在重试或已停用。
 */
export enum AudioSidecarStatus {
  /** 引擎未运行或 sidecar 未启动 */
  IDLE = 'idle',
  /** 首次尝试启动音频流中 */
  CONNECTING = 'connecting',
  /** 音频输入/输出/监听均已就绪 */
  CONNECTED = 'connected',
  /** 上一次尝试失败，等待下一次退避重试 */
  RETRYING = 'retrying',
  /** 配置错误或不可恢复的失败，已停止重试 */
  DISABLED = 'disabled',
}

export const AudioSidecarStatusSchema = z.nativeEnum(AudioSidecarStatus);

export const AudioSidecarErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  userMessage: z.string().optional(),
  userMessageKey: z.string().optional(),
  userMessageParams: z.record(z.union([z.string(), z.number()])).optional(),
});

export type AudioSidecarError = z.infer<typeof AudioSidecarErrorSchema>;

/**
 * AudioSidecar 状态变化载荷。
 * 前端以此渲染 RadioControl 中的音频副状态 spinner + Popover。
 */
export const AudioSidecarStatusPayloadSchema = z.object({
  /** 当前状态 */
  status: AudioSidecarStatusSchema,
  /** 音频输入/输出是否已就绪可用 */
  isConnected: z.boolean(),
  /** 当前重试尝试计数（0 表示首次未重试过） */
  retryAttempt: z.number().int().min(0),
  /** 下次重试延迟 ms（仅 RETRYING 有值） */
  nextRetryMs: z.number().int().min(0).nullable(),
  /** 连续失败超过阈值时置 true，用于前端提示"长时间未就绪" */
  longRunning: z.boolean(),
  /** 最近一次错误摘要 */
  lastError: AudioSidecarErrorSchema.nullable(),
  /** 当前目标设备名（来自 AudioConfig.inputDeviceName） */
  deviceName: z.string().nullable(),
});

export type AudioSidecarStatusPayload = z.infer<typeof AudioSidecarStatusPayloadSchema>;
