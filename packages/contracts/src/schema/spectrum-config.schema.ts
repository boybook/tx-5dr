import { z } from 'zod';

export const SpectrumPresetIdSchema = z.enum(['responsive', 'balanced', 'block', 'fine']);
export const SpectrumPresetSchema = z.enum(['responsive', 'balanced', 'block', 'fine', 'custom']);
export type SpectrumPreset = z.infer<typeof SpectrumPresetSchema>;
export type SpectrumPresetId = z.infer<typeof SpectrumPresetIdSchema>;

export const SpectrumWindowFunctionSchema = z.enum([
  'hann',
  'hamming',
  'blackman',
  'blackmanHarris',
  'none',
]);
export type SpectrumWindowFunction = z.infer<typeof SpectrumWindowFunctionSchema>;

export const SpectrumFftSizeSchema = z.union([
  z.literal(1024),
  z.literal(2048),
  z.literal(4096),
  z.literal(8192),
  z.literal(16384),
]);

export const SpectrumTargetSampleRateSchema = z.union([
  z.literal(3000),
  z.literal(4000),
  z.literal(6000),
  z.literal(8000),
  z.literal(12000),
]);

export const SpectrumCustomSettingsSchema = z.object({
  analysisIntervalMs: z.number().int().min(50).max(1000),
  fftSize: SpectrumFftSizeSchema,
  targetSampleRate: SpectrumTargetSampleRateSchema,
  windowFunction: SpectrumWindowFunctionSchema,
  haloReduce: z.boolean(),
});
export type SpectrumCustomSettings = z.infer<typeof SpectrumCustomSettingsSchema>;

export const SpectrumRenderFrequencyRangeSchema = z.object({
  min: z.number().finite(),
  max: z.number().finite(),
}).refine((range) => range.max > range.min, {
  message: 'Spectrum frequency range maximum must be greater than minimum',
  path: ['max'],
});

export const SpectrumRenderConfigSchema = z.object({
  preset: SpectrumPresetSchema,
  revision: z.number().int().nonnegative(),
  analysisIntervalMs: z.number().int().positive(),
  frameRateHz: z.number().positive(),
  fftSize: z.number().int().positive(),
  targetSampleRate: z.number().int().positive(),
  fftWindowDurationMs: z.number().positive(),
  frequencyResolutionHz: z.number().positive(),
  frequencyRange: SpectrumRenderFrequencyRangeSchema,
  displayBinCount: z.number().int().positive(),
  windowFunction: SpectrumWindowFunctionSchema,
  haloReduce: z.boolean(),
  customSettings: SpectrumCustomSettingsSchema.optional(),
});
export type SpectrumRenderConfig = z.infer<typeof SpectrumRenderConfigSchema>;

export const TciIqSampleRateSchema = z.number().int().positive();
export type TciIqSampleRate = z.infer<typeof TciIqSampleRateSchema>;

export const TciSpectrumSettingsSchema = z.object({
  fftSize: z.union([
    z.literal(4096), z.literal(8192), z.literal(16384), z.literal(32768), z.literal(65536),
  ]),
  displayBinCount: z.number().int().min(1024).max(16384),
  analysisIntervalMs: z.number().int().min(20).max(1000),
});
export type TciSpectrumSettings = z.infer<typeof TciSpectrumSettingsSchema>;

export const TciSpectrumSettingsResponseSchema = z.object({
  success: z.boolean(),
  settings: TciSpectrumSettingsSchema,
});
export type TciSpectrumSettingsResponse = z.infer<typeof TciSpectrumSettingsResponseSchema>;

export const TciIqSpectrumSettingsResponseSchema = z.object({
  success: z.boolean(),
  configuredSampleRate: TciIqSampleRateSchema.nullable(),
  appliedSampleRate: TciIqSampleRateSchema.nullable(),
  supportedSampleRates: z.array(TciIqSampleRateSchema),
});
export type TciIqSpectrumSettingsResponse = z.infer<typeof TciIqSpectrumSettingsResponseSchema>;

export const SpectrumPresetDefinitionSchema = SpectrumRenderConfigSchema.omit({
  revision: true,
});
export type SpectrumPresetDefinition = z.infer<typeof SpectrumPresetDefinitionSchema>;

export const SPECTRUM_PRESET_DEFINITIONS: Record<SpectrumPresetId, SpectrumPresetDefinition> = {
  responsive: {
    preset: 'responsive',
    analysisIntervalMs: 100,
    frameRateHz: 10,
    fftSize: 2048,
    targetSampleRate: 6000,
    fftWindowDurationMs: (2048 / 6000) * 1000,
    frequencyResolutionHz: 6000 / 2048,
    frequencyRange: { min: 0, max: 3000 },
    displayBinCount: 1025,
    windowFunction: 'blackmanHarris',
    haloReduce: false,
  },
  balanced: {
    preset: 'balanced',
    analysisIntervalMs: 150,
    frameRateHz: 1000 / 150,
    fftSize: 8192,
    targetSampleRate: 6000,
    fftWindowDurationMs: (8192 / 6000) * 1000,
    frequencyResolutionHz: 6000 / 8192,
    frequencyRange: { min: 0, max: 3000 },
    displayBinCount: 4097,
    windowFunction: 'blackmanHarris',
    haloReduce: false,
  },
  block: {
    preset: 'block',
    analysisIntervalMs: 600,
    frameRateHz: 1000 / 600,
    fftSize: 8192,
    targetSampleRate: 6000,
    fftWindowDurationMs: (8192 / 6000) * 1000,
    frequencyResolutionHz: 6000 / 8192,
    frequencyRange: { min: 0, max: 3000 },
    displayBinCount: 4097,
    windowFunction: 'blackmanHarris',
    haloReduce: false,
  },
  fine: {
    preset: 'fine',
    analysisIntervalMs: 200,
    frameRateHz: 5,
    fftSize: 16384,
    targetSampleRate: 6000,
    fftWindowDurationMs: (16384 / 6000) * 1000,
    frequencyResolutionHz: 6000 / 16384,
    frequencyRange: { min: 0, max: 3000 },
    displayBinCount: 8193,
    windowFunction: 'blackmanHarris',
    haloReduce: false,
  },
};

export function getSpectrumPresetDefinition(preset: SpectrumPresetId): SpectrumPresetDefinition {
  return { ...SPECTRUM_PRESET_DEFINITIONS[preset] };
}

export const SpectrumSettingsUpdateRequestSchema = z.discriminatedUnion('preset', [
  z.object({ preset: SpectrumPresetIdSchema }),
  z.object({ preset: z.literal('custom'), settings: SpectrumCustomSettingsSchema }),
]);
export type SpectrumSettingsUpdateRequest = z.infer<typeof SpectrumSettingsUpdateRequestSchema>;

export const SpectrumSettingsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  currentSettings: SpectrumRenderConfigSchema,
  presets: z.array(SpectrumPresetDefinitionSchema),
});
export type SpectrumSettingsResponse = z.infer<typeof SpectrumSettingsResponseSchema>;
