import { z } from 'zod';

export const CWDecoderBackendSchema = z.enum(['deepcw-onnx']);
export type CWDecoderBackend = z.infer<typeof CWDecoderBackendSchema>;

export const CWDecoderRuntimeBackendSchema = z.enum([
  'cpu',
  'cuda',
  'coreml',
  'directml',
  'wasm',
  'webgpu',
]);
export type CWDecoderRuntimeBackend = z.infer<typeof CWDecoderRuntimeBackendSchema>;

export const CWDecoderModelSizeSchema = z.enum(['tiny', 'small']);
export type CWDecoderModelSize = z.infer<typeof CWDecoderModelSizeSchema>;

export const CWDecoderModeSchema = z.enum(['streaming']);
export type CWDecoderMode = z.infer<typeof CWDecoderModeSchema>;

export const CWDecoderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  backend: CWDecoderBackendSchema.default('deepcw-onnx'),
  runtimeBackend: CWDecoderRuntimeBackendSchema.default('cpu'),
  modelSize: CWDecoderModelSizeSchema.default('tiny'),
  language: z.string().min(1).default('en'),
  mode: CWDecoderModeSchema.default('streaming'),
  targetFreqHz: z.number().int().positive().default(800),
  filterWidthHz: z.number().int().positive().default(800),
  windowSeconds: z.number().positive().default(12),
  decodeIntervalMs: z.number().int().positive().default(1000),
  muteWhileTransmitting: z.boolean().default(true),
  workerCount: z.number().int().positive().max(4).default(1),
  minCommitChars: z.number().int().positive().default(1),
  commitStability: z.number().int().positive().default(2),
  maxPendingAgeMs: z.number().int().positive().default(4000),
});
export type CWDecoderConfig = z.infer<typeof CWDecoderConfigSchema>;

export const CWDecoderTuningUpdateSchema = z.object({
  targetFreqHz: z.number().int().min(100).max(1500).optional(),
  filterWidthHz: z.number().int().min(100).max(800).optional(),
}).refine(value => value.targetFreqHz !== undefined || value.filterWidthHz !== undefined, {
  message: 'At least one CW decoder tuning field is required',
});
export type CWDecoderTuningUpdate = z.infer<typeof CWDecoderTuningUpdateSchema>;

export const CWDecoderBackendDescriptorSchema = z.object({
  id: CWDecoderBackendSchema,
  name: z.string(),
  available: z.boolean(),
  runtimeBackends: z.array(CWDecoderRuntimeBackendSchema).default(['cpu']),
  modelSizes: z.array(CWDecoderModelSizeSchema).default(['tiny']),
  languages: z.array(z.string()).default(['en']),
  modes: z.array(CWDecoderModeSchema).default(['streaming']),
  version: z.string().optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  runtime: z.string().optional(),
  attributionName: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  license: z.string().optional(),
  error: z.string().nullable().optional(),
  reason: z.string().optional(),
});
export type CWDecoderBackendDescriptor = z.infer<typeof CWDecoderBackendDescriptorSchema>;

export const CWDecoderStatusStateSchema = z.enum([
  'disabled',
  'starting',
  'listening',
  'decoding',
  'muted',
  'error',
]);
export type CWDecoderStatusState = z.infer<typeof CWDecoderStatusStateSchema>;

export const CWDecoderStatusSchema = z.object({
  enabled: z.boolean(),
  state: CWDecoderStatusStateSchema,
  config: CWDecoderConfigSchema,
  backend: CWDecoderBackendDescriptorSchema.optional(),
  muted: z.boolean().default(false),
  active: z.boolean().default(false),
  lastDecodeAt: z.number().optional(),
  lastError: z.string().nullable().optional(),
  running: z.boolean().optional(),
  backendId: CWDecoderBackendSchema.optional(),
  pendingText: z.string().optional(),
  committedText: z.string().optional(),
  queuedSamples: z.number().int().nonnegative().optional(),
  updatedAt: z.number(),
});
export type CWDecoderStatus = z.infer<typeof CWDecoderStatusSchema>;

export const CWDecoderWordSpaceSpanSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
});
export type CWDecoderWordSpaceSpan = z.infer<typeof CWDecoderWordSpaceSpanSchema>;

export const CWDecoderCharacterSpanSchema = z.object({
  char: z.string(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
});
export type CWDecoderCharacterSpan = z.infer<typeof CWDecoderCharacterSpanSchema>;

export const CWDecoderTranscriptSegmentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().nonnegative(),
  text: z.string(),
  plainText: z.string().optional(),
  finalized: z.literal(true).default(true),
  prependSpace: z.boolean().default(true),
  confidence: z.number().min(0).max(1).optional(),
  targetFreqHz: z.number().positive().optional(),
  filterWidthHz: z.number().positive().optional(),
  characterSpans: z.array(CWDecoderCharacterSpanSchema).optional(),
  wordSpaceSpans: z.array(CWDecoderWordSpaceSpanSchema).optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().nullable().optional(),
  updatedAt: z.number(),
  wpm: z.number().positive().optional(),
});
export type CWDecoderTranscriptSegment = z.infer<typeof CWDecoderTranscriptSegmentSchema>;

export const CWDecoderPendingSegmentSchema = z.object({
  sessionId: z.string(),
  version: z.number().int().nonnegative(),
  text: z.string(),
  plainText: z.string().optional(),
  finalized: z.literal(false).default(false),
  confidence: z.number().min(0).max(1).optional(),
  targetFreqHz: z.number().positive().optional(),
  filterWidthHz: z.number().positive().optional(),
  characterSpans: z.array(CWDecoderCharacterSpanSchema).optional(),
  wordSpaceSpans: z.array(CWDecoderWordSpaceSpanSchema).optional(),
  updatedAt: z.number(),
});
export type CWDecoderPendingSegment = z.infer<typeof CWDecoderPendingSegmentSchema>;

export const CWDecoderStatusEventSchema = z.object({
  kind: z.literal('status'),
  status: CWDecoderStatusSchema,
});

export const CWDecoderTranscriptEventSchema = z.object({
  kind: z.literal('transcript'),
  segment: CWDecoderTranscriptSegmentSchema,
});

export const CWDecoderTranscriptResetEventSchema = z.object({
  kind: z.literal('transcript_reset'),
  sessionId: z.string(),
  timestamp: z.number(),
});

export const CWDecoderTranscriptPendingEventSchema = z.object({
  kind: z.literal('transcript_pending'),
  pending: CWDecoderPendingSegmentSchema.nullable(),
  timestamp: z.number(),
});

export const CWDecoderTranscriptCommitEventSchema = z.object({
  kind: z.literal('transcript_commit'),
  segment: CWDecoderTranscriptSegmentSchema,
  timestamp: z.number(),
});

export const CWDecoderPendingEventSchema = z.object({
  kind: z.literal('pending'),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  timestamp: z.number(),
});

export const CWDecoderCommitEventSchema = z.object({
  kind: z.literal('commit'),
  segment: CWDecoderTranscriptSegmentSchema,
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  timestamp: z.number().optional(),
});

export const CWDecoderPartialEventSchema = z.object({
  kind: z.literal('partial'),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  timestamp: z.number(),
});

export const CWDecoderErrorEventSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  code: z.string().optional(),
  recoverable: z.boolean().optional(),
  timestamp: z.number(),
});

export const CWDecoderModelLoadEventSchema = z.object({
  kind: z.literal('model_load'),
  backend: CWDecoderBackendSchema,
  modelSize: CWDecoderModelSizeSchema.optional(),
  language: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
  timestamp: z.number(),
});

export const CWDecoderAudioBufferEventSchema = z.object({
  kind: z.literal('audio_buffer'),
  queuedSamples: z.number().int().nonnegative(),
  sampleRate: z.number().int().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  timestamp: z.number(),
});

export const CWDecoderEventSchema = z.discriminatedUnion('kind', [
  CWDecoderStatusEventSchema,
  CWDecoderTranscriptEventSchema,
  CWDecoderTranscriptResetEventSchema,
  CWDecoderTranscriptPendingEventSchema,
  CWDecoderTranscriptCommitEventSchema,
  CWDecoderPendingEventSchema,
  CWDecoderCommitEventSchema,
  CWDecoderPartialEventSchema,
  CWDecoderErrorEventSchema,
  CWDecoderModelLoadEventSchema,
  CWDecoderAudioBufferEventSchema,
]);
export type CWDecoderEvent = z.infer<typeof CWDecoderEventSchema>;
