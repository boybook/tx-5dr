import { z } from 'zod';

export const SpectrumKindSchema = z.enum(['audio', 'radio-sdr', 'openwebrx-sdr']);
export type SpectrumKind = z.infer<typeof SpectrumKindSchema>;

export const SpectrumDisplayModeSchema = z.enum(['center', 'fixed', 'scroll-center', 'scroll-fixed', 'unknown']);
export type SpectrumDisplayMode = z.infer<typeof SpectrumDisplayModeSchema>;

export const SpectrumSessionSourceModeSchema = z.enum([
  'baseband',
  'center',
  'fixed',
  'scroll-center',
  'scroll-fixed',
  'full',
  'detail',
  'unknown',
]);
export type SpectrumSessionSourceMode = z.infer<typeof SpectrumSessionSourceModeSchema>;

export const SpectrumSessionFrequencyRangeModeSchema = z.enum([
  'baseband',
  'absolute-center',
  'absolute-fixed',
  'absolute-windowed',
]);
export type SpectrumSessionFrequencyRangeMode = z.infer<typeof SpectrumSessionFrequencyRangeModeSchema>;

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

export const SpectrumSessionControlIdSchema = z.enum([
  'zoom-step',
  'digital-window-toggle',
  'openwebrx-detail-toggle',
  'viewport-zoom',
]);
export type SpectrumSessionControlId = z.infer<typeof SpectrumSessionControlIdSchema>;

export const SpectrumSessionControlActionSchema = z.enum(['in', 'out', 'toggle']);
export type SpectrumSessionControlAction = z.infer<typeof SpectrumSessionControlActionSchema>;

export const SpectrumSessionControlKindSchema = z.enum(['server', 'local']);
export type SpectrumSessionControlKind = z.infer<typeof SpectrumSessionControlKindSchema>;

export const SpectrumSessionControlSchema = z.object({
  id: SpectrumSessionControlIdSchema,
  action: SpectrumSessionControlActionSchema,
  kind: SpectrumSessionControlKindSchema,
  visible: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  pending: z.boolean(),
});
export type SpectrumSessionControl = z.infer<typeof SpectrumSessionControlSchema>;

export const SpectrumSessionVoiceStateSchema = z.object({
  radioMode: z.string().nullable(),
  bandwidthLabel: z.string().nullable(),
  occupiedBandwidthHz: z.number().nullable(),
  offsetModel: z.enum(['upper', 'lower', 'symmetric']).nullable(),
});
export type SpectrumSessionVoiceState = z.infer<typeof SpectrumSessionVoiceStateSchema>;

export const SpectrumSessionPresetMarkerSchema = z.object({
  id: z.string(),
  frequency: z.number(),
  label: z.string(),
  description: z.string().nullable(),
  clickable: z.boolean(),
});
export type SpectrumSessionPresetMarker = z.infer<typeof SpectrumSessionPresetMarkerSchema>;

export const SpectrumSessionInteractionStateSchema = z.object({
  showTxMarkers: z.boolean(),
  showRxMarkers: z.boolean(),
  canDragTx: z.boolean(),
  canRightClickSetFrequency: z.boolean(),
  canDoubleClickSetFrequency: z.boolean(),
  canDragFrequency: z.boolean(),
  frequencyGestureTarget: z.enum(['operator-tx', 'radio-frequency']).nullable(),
  frequencyStepHz: z.number().int().positive().nullable(),
  presetMarkers: z.array(SpectrumSessionPresetMarkerSchema),
  canDragVoiceOverlay: z.boolean(),
  showVoiceOverlay: z.boolean(),
  canLocalViewportZoom: z.boolean(),
  canLocalViewportPan: z.boolean(),
  supportsManualRange: z.boolean(),
  supportsAutoRange: z.boolean(),
  defaultRangeMode: z.enum(['auto', 'manual']).nullable(),
});
export type SpectrumSessionInteractionState = z.infer<typeof SpectrumSessionInteractionStateSchema>;

export const SpectrumSessionStateSchema = z.object({
  kind: SpectrumKindSchema.nullable(),
  sourceMode: SpectrumSessionSourceModeSchema,
  frequencyRangeMode: SpectrumSessionFrequencyRangeModeSchema,
  displayRange: SpectrumFrequencyRangeSchema.nullable(),
  centerFrequency: z.number().nullable(),
  currentRadioFrequency: z.number().nullable(),
  standardFrequencyHz: z.number().nullable(),
  edgeLowHz: z.number().nullable(),
  edgeHighHz: z.number().nullable(),
  spanHz: z.number().nullable(),
  voice: SpectrumSessionVoiceStateSchema,
  interaction: SpectrumSessionInteractionStateSchema,
  controls: z.array(SpectrumSessionControlSchema),
});
export type SpectrumSessionState = z.infer<typeof SpectrumSessionStateSchema>;

export type SpectrumFrequencyRange = z.infer<typeof SpectrumFrequencyRangeSchema>;
export type SpectrumBinaryFormat = z.infer<typeof SpectrumBinaryFormatSchema>;
export type SpectrumBinaryData = z.infer<typeof SpectrumBinaryDataSchema>;
export type SpectrumFrameMeta = z.infer<typeof SpectrumFrameMetaSchema>;
export type SpectrumFrame = z.infer<typeof SpectrumFrameSchema>;
export type SpectrumSourceAvailability = z.infer<typeof SpectrumSourceAvailabilitySchema>;
export type SpectrumCapabilities = z.infer<typeof SpectrumCapabilitiesSchema>;
