import { z } from 'zod';

export const ImageFamilySchema = z.enum(['sstv', 'fax']);
export type ImageFamily = z.infer<typeof ImageFamilySchema>;

export const ImagePixelFormatSchema = z.enum(['rgb8', 'gray8']);
export type ImagePixelFormat = z.infer<typeof ImagePixelFormatSchema>;

export const ImageSstvReceiveProfileSchema = z.discriminatedUnion('strategy', [
  z.object({ family: z.literal('sstv'), strategy: z.literal('auto') }),
  z.object({ family: z.literal('sstv'), strategy: z.literal('manual'), mode: z.string().min(1) }),
]);
export type ImageSstvReceiveProfile = z.infer<typeof ImageSstvReceiveProfileSchema>;

export const ImageFaxReceiveProfileSchema = z.discriminatedUnion('strategy', [
  z.object({ family: z.literal('fax'), strategy: z.literal('auto') }),
  z.object({
    family: z.literal('fax'), strategy: z.literal('manual'),
    ioc: z.enum(['ioc288', 'ioc576']), lpm: z.number().int().positive(),
    modulation: z.enum(['fm', 'am']), centerHz: z.number().positive(),
    deviationHz: z.number().positive(),
  }),
]);
export type ImageFaxReceiveProfile = z.infer<typeof ImageFaxReceiveProfileSchema>;

export const ImageReceiveProfileSchema = z.union([
  ImageSstvReceiveProfileSchema,
  ImageFaxReceiveProfileSchema,
]);
export type ImageReceiveProfile = z.infer<typeof ImageReceiveProfileSchema>;

export const ImageSstvModeInfoSchema = z.object({
  mode: z.string(), name: z.string(), visCode: z.number().int().nonnegative(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  colorLayout: z.enum(['monochrome', 'rgb', 'yuv']),
  scanLayout: z.enum(['monochrome', 'martin', 'scottie', 'robot', 'pd', 'wraase', 'pasokon']),
  lineSeconds: z.number().positive(), rowsPerLine: z.number().int().positive(),
  status: z.enum(['canonical', 'compatibility']),
});
export type ImageSstvModeInfo = z.infer<typeof ImageSstvModeInfoSchema>;

export const ImageRadioCapabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  sstv: z.object({ rx: z.literal(true), tx: z.literal(true) }),
  fax: z.object({ rx: z.literal(true), tx: z.literal(false) }),
});
export type ImageRadioCapability = z.infer<typeof ImageRadioCapabilitySchema>;

export const ImageRadioServiceStateSchema = z.enum(['stopped', 'starting', 'ready', 'degraded', 'unavailable']);
export const ImageRxStateSchema = z.enum(['off', 'searching', 'acquiring', 'receiving', 'completed', 'aborted', 'error']);
export const SstvTxPhaseSchema = z.enum([
  'idle', 'preparing', 'waiting_for_lease', 'keying', 'on_air', 'draining',
  'completed', 'cancelled', 'error', 'ptt_unknown',
]);

export const ImageSessionSummarySchema = z.object({
  sessionId: z.string(),
  family: ImageFamilySchema,
  generation: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  codecMode: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  receivedLines: z.number().int().nonnegative().default(0),
  firstAvailableLine: z.number().int().nonnegative().default(0),
  startedAt: z.number(),
});
export type ImageSessionSummary = z.infer<typeof ImageSessionSummarySchema>;

export const SstvTxStatusSchema = z.object({
  phase: SstvTxPhaseSchema,
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
  operatorId: z.string().optional(),
  artifactId: z.string().optional(),
  historyId: z.string().optional(),
  mode: z.string().optional(),
  revision: z.number().int().nonnegative().default(0),
  samplesEmitted: z.number().int().nonnegative().default(0),
  estimatedTotalSamples: z.number().int().nonnegative().default(0),
  currentRow: z.number().int().nonnegative().optional(),
  startedAt: z.number().optional(),
  errorCode: z.string().optional(),
});
export type SstvTxStatus = z.infer<typeof SstvTxStatusSchema>;

export const ImageRadioStatusSchema = z.object({
  serviceState: ImageRadioServiceStateSchema,
  family: ImageFamilySchema.nullable(),
  receiveProfile: ImageReceiveProfileSchema.nullable(),
  rxState: ImageRxStateSchema,
  rxCaptureActive: z.boolean().default(false),
  capability: ImageRadioCapabilitySchema,
  currentSession: ImageSessionSummarySchema.nullable(),
  tx: SstvTxStatusSchema,
  nativeQueuedSamples: z.number().int().nonnegative().default(0),
  jsBacklogSamples: z.number().int().nonnegative().default(0),
  discontinuities: z.number().int().nonnegative().default(0),
  updatedAt: z.number(),
});
export type ImageRadioStatus = z.infer<typeof ImageRadioStatusSchema>;

export const ImageRowPatchSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  rowRevision: z.number().int().nonnegative(),
  completeness: z.enum(['provisional', 'final']).optional(),
  dataBase64: z.string(),
});

export const ImagePaperBoundaryKindSchema = z.enum([
  'initial', 'vis', 'syncTiming', 'aptPhasing', 'protocolEnd',
  'manualMode', 'discontinuity', 'reset', 'truncated', 'protocolObserved',
  'localTxStart', 'localTxEnd',
]);
export type ImagePaperBoundaryKind = z.infer<typeof ImagePaperBoundaryKindSchema>;
export const ImagePaperSourceSchema = z.enum(['rx', 'localTx']);
export type ImagePaperSource = z.infer<typeof ImagePaperSourceSchema>;

export const ImagePaperBoundarySchema = z.object({
  boundaryId: z.string(), lineIndex: z.number().int().nonnegative(),
  kind: ImagePaperBoundaryKindSchema, trusted: z.boolean(),
  codecMode: z.string(), width: z.number().int().positive(),
  pixelFormat: ImagePixelFormatSchema, timestamp: z.number(),
  detection: z.string().optional(), nominalHeight: z.number().int().positive().optional(),
  source: ImagePaperSourceSchema.optional(),
  txSessionId: z.string().optional(),
  txOutcome: z.enum(['completed', 'interrupted']).optional(),
});
export type ImagePaperBoundary = z.infer<typeof ImagePaperBoundarySchema>;

export const ImageFaxCalibrationPointSchema = z.object({
  revision: z.number().int().nonnegative(),
  referenceLine: z.number().int().nonnegative(),
  phasePixels: z.number().finite(),
  clockPpm: z.number().finite(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['nominal', 'phasing', 'deadSector', 'manual']),
  status: z.enum(['nominal', 'acquiring', 'locked', 'tracking', 'degraded']),
});
export type ImageFaxCalibrationPoint = z.infer<typeof ImageFaxCalibrationPointSchema>;

export const ImageFaxCalibrationSchema = z.object({
  boundaryId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  autoEnabled: z.boolean(),
  autoPoints: z.array(ImageFaxCalibrationPointSchema).max(256),
  manualPhasePixels: z.number().finite(),
  manualClockPpm: z.number().finite(),
  updatedAt: z.number(),
});
export type ImageFaxCalibration = z.infer<typeof ImageFaxCalibrationSchema>;

export const ImageRxEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paperStarted'), session: ImageSessionSummarySchema, pixelFormat: ImagePixelFormatSchema }),
  z.object({ type: z.literal('boundary'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), boundary: ImagePaperBoundarySchema }),
  z.object({ type: z.literal('faxCalibration'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), calibration: ImageFaxCalibrationSchema }),
  z.object({ type: z.literal('signalDetected'), family: ImageFamilySchema, confidence: z.number().min(0).max(1), candidates: z.array(z.string()), timestamp: z.number() }),
  z.object({ type: z.literal('imageStarted'), session: ImageSessionSummarySchema, pixelFormat: ImagePixelFormatSchema, detection: z.string().optional(), confidence: z.number().min(0).max(1).optional() }),
  z.object({ type: z.literal('rows'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), pixelFormat: ImagePixelFormatSchema, rows: z.array(ImageRowPatchSchema).min(1).max(8) }),
  z.object({ type: z.literal('imageCompleted'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), artifactId: z.string(), previewUrl: z.string(), partial: z.boolean() }),
  z.object({ type: z.literal('imageAborted'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), reason: z.string(), lastRow: z.number().int().nonnegative().optional(), temporary: z.boolean() }),
  z.object({ type: z.literal('snapshotRequired'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), snapshotUrl: z.string() }),
  z.object({ type: z.literal('captureSaved'), sessionId: z.string(), generation: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), artifactId: z.string(), previewUrl: z.string(), saveReason: z.enum(['manual', 'protocolEnd']), complete: z.boolean(), startLine: z.number().int().nonnegative(), endLine: z.number().int().positive() }),
]);
export type ImageRxEvent = z.infer<typeof ImageRxEventSchema>;

export const ImageArtifactSchema = z.object({
  id: z.string(),
  family: ImageFamilySchema,
  direction: z.enum(['rx', 'tx']),
  operatorId: z.string().optional(),
  codecMode: z.string(),
  pixelFormat: ImagePixelFormatSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frequency: z.number().positive(),
  radioMode: z.string().optional(),
  complete: z.boolean(),
  saveReason: z.enum(['manual', 'protocolEnd']).optional(),
  captureStartedAt: z.number().optional(),
  captureEndedAt: z.number().optional(),
  truncated: z.boolean().default(false),
  pinned: z.boolean().default(false),
  qsoId: z.string().optional(),
  contentHash: z.string(),
  createdAt: z.number(),
  imageUrl: z.string(),
  faxCalibration: ImageFaxCalibrationSchema.optional(),
});
export type ImageArtifact = z.infer<typeof ImageArtifactSchema>;

const ImageHistoryRecordBaseSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  family: ImageFamilySchema,
  operatorId: z.string().optional(),
  occurredAt: z.number(),
  qsoId: z.string().optional(),
});

export const ImageHistoryRecordSchema = z.discriminatedUnion('direction', [
  ImageHistoryRecordBaseSchema.extend({
    direction: z.literal('rx'),
    saveReason: z.enum(['manual', 'protocolEnd']),
    complete: z.boolean(),
    truncated: z.boolean().default(false),
  }),
  ImageHistoryRecordBaseSchema.extend({
    direction: z.literal('tx'),
    operatorId: z.string().min(1),
    sessionId: z.string().min(1),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    outcome: z.enum(['transmitting', 'completed', 'interrupted']),
    errorCode: z.string().optional(),
  }),
]);
export type ImageHistoryRecord = z.infer<typeof ImageHistoryRecordSchema>;

export const ImageHistoryEntrySchema = z.object({
  record: ImageHistoryRecordSchema,
  artifact: ImageArtifactSchema,
});
export type ImageHistoryEntry = z.infer<typeof ImageHistoryEntrySchema>;

export const ImageTemplateTextLayerSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(256),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  fontSize: z.number().positive().max(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  align: z.enum(['left', 'center', 'right']).default('center'),
});
export type ImageTemplateTextLayer = z.infer<typeof ImageTemplateTextLayerSchema>;

export const ImageTemplateSchema = z.object({
  id: z.string(),
  operatorId: z.string().optional(),
  name: z.string().min(1).max(80),
  builtIn: z.boolean().default(false),
  backgroundArtifactId: z.string().optional(),
  layers: z.array(ImageTemplateTextLayerSchema).max(16),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ImageTemplate = z.infer<typeof ImageTemplateSchema>;

export const ImageComposerBackgroundSchema = z.object({
  operatorId: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  updatedAt: z.number(),
  imageUrl: z.string(),
});
export type ImageComposerBackground = z.infer<typeof ImageComposerBackgroundSchema>;

export const ImageRxSubscriptionSchema = z.object({ enabled: z.boolean() });
export const SstvTxStartCommandSchema = z.object({
  requestId: z.string().min(1).max(128),
  operatorId: z.string().min(1),
  artifactId: z.string().min(1),
  mode: z.string().min(1),
  expectedFrequency: z.number().positive(),
  interruptActiveCapture: z.boolean().optional(),
});
export type SstvTxStartCommand = z.infer<typeof SstvTxStartCommandSchema>;
export const SstvTxCancelCommandSchema = z.object({
  requestId: z.string().min(1).max(128),
  operatorId: z.string().min(1),
  sessionId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});
export type SstvTxCancelCommand = z.infer<typeof SstvTxCancelCommandSchema>;
export const SstvTxCommandResultSchema = z.object({
  requestId: z.string(),
  accepted: z.boolean(),
  sessionId: z.string().optional(),
  errorCode: z.string().optional(),
});
export type SstvTxCommandResult = z.infer<typeof SstvTxCommandResultSchema>;

export const ImagePaperSaveCommandSchema = z.object({
  requestId: z.string().min(1).max(128),
  operatorId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});
export type ImagePaperSaveCommand = z.infer<typeof ImagePaperSaveCommandSchema>;

const FaxCalibrationCommandBaseSchema = z.object({
  requestId: z.string().min(1).max(128),
  operatorId: z.string().min(1),
  sessionId: z.string().min(1),
  boundaryId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});
export const FaxCalibrationSetCommandSchema = FaxCalibrationCommandBaseSchema.extend({
  autoEnabled: z.boolean(),
  phasePixels: z.number().finite(),
  clockPpm: z.number().finite().min(-5000).max(5000),
});
export type FaxCalibrationSetCommand = z.infer<typeof FaxCalibrationSetCommandSchema>;
export const FaxCalibrationResetCommandSchema = FaxCalibrationCommandBaseSchema;
export type FaxCalibrationResetCommand = z.infer<typeof FaxCalibrationResetCommandSchema>;
export const FaxCalibrationCommandResultSchema = z.object({
  requestId: z.string(), accepted: z.boolean(),
  calibration: ImageFaxCalibrationSchema.optional(), errorCode: z.string().optional(),
});
export type FaxCalibrationCommandResult = z.infer<typeof FaxCalibrationCommandResultSchema>;
