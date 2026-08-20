import { z } from 'zod';

export const OBSERVABILITY_NOTICE_VERSION = 1;

export const ObservabilitySettingsSchema = z.object({
  enabled: z.boolean(),
  noticeVersion: z.number().int().nonnegative(),
});
export type ObservabilitySettings = z.infer<typeof ObservabilitySettingsSchema>;

export const UpdateObservabilitySettingsSchema = z.object({
  enabled: z.boolean(),
  noticeVersion: z.literal(OBSERVABILITY_NOTICE_VERSION),
});
export type UpdateObservabilitySettingsRequest = z.infer<typeof UpdateObservabilitySettingsSchema>;

export const ObservabilityStatusSchema = z.object({
  settings: ObservabilitySettingsSchema,
  effectiveEnabled: z.boolean(),
  noticeRequired: z.boolean(),
  endpointConfigured: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  lastSentAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
});
export type ObservabilityStatus = z.infer<typeof ObservabilityStatusSchema>;
