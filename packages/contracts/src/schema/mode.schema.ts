import { z } from 'zod';

/**
 * Mode descriptor for timing and scheduling.
 */
export const ModeDescriptorSchema = z.object({
  name: z.string(),
  slotMs: z.number().nonnegative(),
  toleranceMs: z.number().nonnegative().default(100),
  windowTiming: z.array(z.number()),
  transmitTiming: z.number().nonnegative(),
  encodeAdvance: z.number().nonnegative().default(400),
});

export type ModeDescriptor = z.infer<typeof ModeDescriptorSchema>;

/**
 * Built-in modes.
 */
export const MODES = {
  FT8: {
    name: 'FT8',
    slotMs: 15000,
    toleranceMs: 100,
    windowTiming: [-3200, -1500, -300],
    transmitTiming: 500,
    encodeAdvance: 0,
  } as ModeDescriptor,
  FT4: {
    name: 'FT4',
    slotMs: 7500,
    toleranceMs: 50,
    windowTiming: [-1500, 0],
    transmitTiming: 500,
    encodeAdvance: 300,
  } as ModeDescriptor,
  MSK144: {
    name: 'MSK144',
    slotMs: 15000,
    toleranceMs: 100,
    windowTiming: [0],
    transmitTiming: 500,
    encodeAdvance: 0,
  } as ModeDescriptor,
  VOICE: {
    name: 'VOICE',
    slotMs: 0,
    toleranceMs: 0,
    windowTiming: [],
    transmitTiming: 0,
    encodeAdvance: 0,
  } as ModeDescriptor,
  CW: {
    name: 'CW',
    slotMs: 0,
    toleranceMs: 0,
    windowTiming: [],
    transmitTiming: 0,
    encodeAdvance: 0,
  } as ModeDescriptor,
} as const;

/**
 * Decode window presets.
 */
export const DecodeWindowPreset = {
  MAXIMUM: 'maximum',
  BALANCED: 'balanced',
  LIGHTWEIGHT: 'lightweight',
  MINIMUM: 'minimum',
  CUSTOM: 'custom',
} as const;

/**
 * FT8 decode window presets (offset relative to slot end).
 */
export const FT8_WINDOW_PRESETS: Record<string, number[]> = {
  maximum: [-3200, -1500, -800, -300, -150],
  balanced: [-3200, -1500, -300],
  lightweight: [-3200, -300],
  minimum: [-300],
};

/**
 * FT4 decode window presets (offset relative to slot end).
 */
export const FT4_WINDOW_PRESETS: Record<string, number[]> = {
  maximum: [-2000, -1000, 0],
  balanced: [-1500, 0],
  lightweight: [0],
};

/**
 * Decode window settings schema.
 */
export const DecodeWindowSettingsSchema = z.object({
  ft8: z.object({
    preset: z.enum(['maximum', 'balanced', 'lightweight', 'minimum', 'custom']).default('balanced'),
    customWindowTiming: z.array(z.number().int().min(-5000).max(1000)).optional(),
  }).optional(),
  ft4: z.object({
    preset: z.enum(['maximum', 'balanced', 'lightweight', 'custom']).default('balanced'),
    customWindowTiming: z.array(z.number().int().min(-5000).max(1000)).optional(),
  }).optional(),
});

export type DecodeWindowSettings = z.infer<typeof DecodeWindowSettingsSchema>;

export const DEFAULT_DECODE_WINDOW_SETTINGS: DecodeWindowSettings = {
  ft8: {
    preset: 'balanced',
  },
  ft4: {
    preset: 'balanced',
  },
};

/**
 * Resolve effective window timing by mode and settings.
 * Returns null to indicate fallback to MODES defaults.
 */
export function resolveWindowTiming(
  modeName: string,
  settings?: DecodeWindowSettings,
): number[] | null {
  if (!settings) return null;

  const modeKey = modeName.toUpperCase();

  if (modeKey === 'FT8' && settings.ft8) {
    const { preset, customWindowTiming } = settings.ft8;
    if (preset === 'custom' && customWindowTiming && customWindowTiming.length > 0) {
      return [...customWindowTiming].sort((a, b) => a - b);
    }
    return FT8_WINDOW_PRESETS[preset] ?? null;
  }

  if (modeKey === 'FT4' && settings.ft4) {
    const { preset, customWindowTiming } = settings.ft4;
    if (preset === 'custom' && customWindowTiming && customWindowTiming.length > 0) {
      return [...customWindowTiming].sort((a, b) => a - b);
    }
    return FT4_WINDOW_PRESETS[preset] ?? null;
  }

  return null;
}
