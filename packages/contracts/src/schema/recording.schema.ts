import { z } from 'zod';

export const RecordingFormatSchema = z.enum(['wav', 'mp3']);
export const RecordingSourceSchema = z.enum(['rx', 'tx', 'both']);
export const RecordingSampleRateSchema = z.union([z.literal(16000), z.literal(24000), z.literal(44100), z.literal(48000)]);
export const RecordingBitDepthSchema = z.union([z.literal(16), z.literal(24), z.literal(32)]);

export const RecordingSettingsSchema = z.object({
  format: RecordingFormatSchema.default('wav'),
  sampleRate: RecordingSampleRateSchema.default(24000),
  bitDepth: RecordingBitDepthSchema.default(16),
  source: RecordingSourceSchema.default('both'),
  directory: z.string().min(1).default('recordings'),
});

export const RecordingEntrySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  format: RecordingFormatSchema,
  source: RecordingSourceSchema,
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number().nonnegative(),
  sizeBytes: z.number().nonnegative(),
});

export const RecordingStatusSchema = z.object({
  recording: z.boolean(),
  entry: RecordingEntrySchema.nullable(),
  error: z.string().nullable(),
});

export const RecordingSettingsResponseSchema = RecordingSettingsSchema.extend({
  mp3Supported: z.boolean(),
});

export type RecordingSettings = z.infer<typeof RecordingSettingsSchema>;
export type RecordingEntry = z.infer<typeof RecordingEntrySchema>;
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;
export type RecordingSettingsResponse = z.infer<typeof RecordingSettingsResponseSchema>;
