import { z } from 'zod';

export const AndroidOperatorAudioDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  socketPath: z.string(),
  sampleRate: z.number().int().positive(),
  connected: z.boolean().optional(),
});
export type AndroidOperatorAudioDevice = z.infer<typeof AndroidOperatorAudioDeviceSchema>;

export const AndroidOperatorAudioCaptureStateSchema = z.enum(['idle', 'preparing', 'capturing', 'error']);
export type AndroidOperatorAudioCaptureState = z.infer<typeof AndroidOperatorAudioCaptureStateSchema>;

export const AndroidOperatorAudioMonitorStateSchema = z.enum(['idle', 'starting', 'playing', 'paused-for-ptt', 'error']);
export type AndroidOperatorAudioMonitorState = z.infer<typeof AndroidOperatorAudioMonitorStateSchema>;

export const AndroidOperatorAudioStatusSchema = z.object({
  available: z.boolean(),
  captureState: AndroidOperatorAudioCaptureStateSchema,
  monitorState: AndroidOperatorAudioMonitorStateSchema,
  participantIdentity: z.string().nullable(),
  inputLevel: z.number().min(0).max(1),
  inputPeak: z.number().min(0).max(1),
  rawInputLevel: z.number().min(0).max(1).optional(),
  rawInputPeak: z.number().min(0).max(1).optional(),
  inputSilenced: z.boolean(),
  micGainDb: z.number(),
  micGainMinDb: z.number(),
  micGainMaxDb: z.number(),
  micDevice: AndroidOperatorAudioDeviceSchema.nullable(),
  speakerDevice: AndroidOperatorAudioDeviceSchema.nullable(),
  lastError: z.string().nullable(),
});
export type AndroidOperatorAudioStatus = z.infer<typeof AndroidOperatorAudioStatusSchema>;

export const AndroidOperatorAudioGainUpdateSchema = z.object({
  micGainDb: z.number(),
});
export type AndroidOperatorAudioGainUpdate = z.infer<typeof AndroidOperatorAudioGainUpdateSchema>;
