import { z } from 'zod';

export const SpectrumKindSchema = z.enum(['audio', 'radio-sdr']);
export type SpectrumKind = z.infer<typeof SpectrumKindSchema>;

export const SpectrumZoomDirectionSchema = z.enum(['in', 'out']);
export type SpectrumZoomDirection = z.infer<typeof SpectrumZoomDirectionSchema>;

export const SpectrumFrequencyRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
});

export const SpectrumBinaryFormatSchema = z.object({
  type: z.literal('int16'),
  length: z.number().int().positive(),
  scale: z.number().optional(),
  offset: z.number().optional(),
});

export const SpectrumBinaryDataSchema = z.object({
  data: z.string(),
  format: SpectrumBinaryFormatSchema,
});

export const SpectrumFrameMetaSchema = z.object({
  sourceBinCount: z.number().int().positive(),
  displayBinCount: z.number().int().positive(),
  centerFrequency: z.number().optional(),
  spanHz: z.number().optional(),
  profileId: z.string().nullable().optional(),
  radioModel: z.string().optional(),
});

export const SpectrumFrameSchema = z.object({
  timestamp: z.number(),
  kind: SpectrumKindSchema,
  frequencyRange: SpectrumFrequencyRangeSchema,
  binaryData: SpectrumBinaryDataSchema,
  meta: SpectrumFrameMetaSchema,
});

export const SpectrumSourceAvailabilitySchema = z.object({
  kind: SpectrumKindSchema,
  supported: z.boolean(),
  available: z.boolean(),
  defaultSelected: z.boolean(),
  reason: z.string().optional(),
  sourceBinCount: z.number().int().positive().nullable().optional(),
  displayBinCount: z.number().int().positive(),
  supportsWaterfall: z.boolean(),
  frequencyRangeMode: z.enum(['absolute', 'baseband']),
});

export const SpectrumCapabilitiesSchema = z.object({
  profileId: z.string().nullable(),
  defaultKind: SpectrumKindSchema,
  sources: z.array(SpectrumSourceAvailabilitySchema),
});

export const SpectrumZoomLevelSchema = z.object({
  id: z.string(),
  label: z.string(),
  spanHz: z.number().positive(),
});

export const SpectrumZoomStateSchema = z.object({
  kind: SpectrumKindSchema,
  supported: z.boolean(),
  available: z.boolean(),
  levels: z.array(SpectrumZoomLevelSchema),
  currentLevelId: z.string().nullable(),
  currentSpanHz: z.number().positive().nullable(),
  canZoomIn: z.boolean(),
  canZoomOut: z.boolean(),
});

export type SpectrumFrequencyRange = z.infer<typeof SpectrumFrequencyRangeSchema>;
export type SpectrumBinaryFormat = z.infer<typeof SpectrumBinaryFormatSchema>;
export type SpectrumBinaryData = z.infer<typeof SpectrumBinaryDataSchema>;
export type SpectrumFrameMeta = z.infer<typeof SpectrumFrameMetaSchema>;
export type SpectrumFrame = z.infer<typeof SpectrumFrameSchema>;
export type SpectrumSourceAvailability = z.infer<typeof SpectrumSourceAvailabilitySchema>;
export type SpectrumCapabilities = z.infer<typeof SpectrumCapabilitiesSchema>;
export type SpectrumZoomLevel = z.infer<typeof SpectrumZoomLevelSchema>;
export type SpectrumZoomState = z.infer<typeof SpectrumZoomStateSchema>;
