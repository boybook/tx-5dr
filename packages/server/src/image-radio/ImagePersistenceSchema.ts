import { z } from 'zod';
import {
  ImageComposerTransformSchema, ImageFaxCalibrationSchema, ImageTemplateLayerSchema,
  SstvTxEnvelopeSnapshotSchema,
} from '@tx5dr/contracts';

// Disk v1 is explicit: API additions must not silently become required on disk.
// Nested value schemas are shared; historical adapters run before their validation.
const family = z.enum(['sstv', 'fax']);
const id = z.string().min(1);
export const PersistedArtifactSchema = z.object({
  id: id.regex(/^[a-zA-Z0-9_-]+$/), family, direction: z.enum(['rx', 'tx']),
  operatorId: z.string().optional(), codecMode: z.string(), pixelFormat: z.enum(['rgb8', 'gray8']),
  width: z.number().int().positive(), height: z.number().int().positive(),
  frequency: z.number().positive().nullable(), radioMode: z.string().optional(), complete: z.boolean(),
  saveReason: z.enum(['manual', 'protocolEnd']).optional(), captureStartedAt: z.number().optional(),
  captureEndedAt: z.number().optional(), truncated: z.boolean().default(false), pinned: z.boolean().default(false),
  qsoId: z.string().optional(), contentHash: z.string(), createdAt: z.number(), imageUrl: z.string(),
  faxCalibration: ImageFaxCalibrationSchema.optional(),
});
const historyBase = z.object({
  id, artifactId: id, family, operatorId: z.string().optional(), occurredAt: z.number(), qsoId: z.string().optional(),
});
export const PersistedHistorySchema = z.discriminatedUnion('direction', [
  historyBase.extend({ direction: z.literal('rx'), saveReason: z.enum(['manual', 'protocolEnd']), complete: z.boolean(), truncated: z.boolean().default(false) }),
  historyBase.extend({
    direction: z.literal('tx'), operatorId: id, sessionId: id, startedAt: z.number(), endedAt: z.number().optional(),
    outcome: z.enum(['transmitting', 'completed', 'interrupted']), errorCode: z.string().optional(),
    envelope: SstvTxEnvelopeSnapshotSchema.optional(), sampleRate: z.number().int().positive().optional(),
    estimatedTotalSamples: z.number().int().nonnegative().optional(),
  }),
]);
const imageSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artifact'), artifactId: id }),
  z.object({ type: z.literal('asset'), assetId: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export const PersistedTemplateSchema = z.object({
  id, operatorId: z.string().optional(), name: z.string().min(1).max(80), builtIn: z.boolean().default(false),
  backgroundArtifactId: z.string().optional(), backgroundSource: imageSource.optional(),
  backgroundTransform: ImageComposerTransformSchema.optional(), layers: z.array(ImageTemplateLayerSchema).max(16),
  createdAt: z.number(), updatedAt: z.number(),
});
export const PersistedBackgroundSchema = z.object({
  operatorId: id, width: z.number().int().positive(), height: z.number().int().positive(),
  updatedAt: z.number(), imageUrl: z.string(), assetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  transform: ImageComposerTransformSchema.optional(),
});
export const PersistedPreferenceSchema = z.object({
  operatorId: id, enhancedPreamble: z.boolean().default(true),
  stationIdMode: z.enum(['fsk', 'cw', 'none']).default('fsk'), updatedAt: z.number(),
});

export function migrateImageRecord(value: unknown, version: number, collection: string): unknown {
  if (version !== 0 || collection !== 'artifacts' || !value || typeof value !== 'object') return value;
  const artifact = value as Record<string, unknown>;
  const calibration = artifact.faxCalibration as Record<string, unknown> | undefined;
  if (!calibration || !Array.isArray(calibration.autoPoints)) return value;
  return { ...artifact, faxCalibration: { ...calibration, autoPoints: calibration.autoPoints.map(point =>
    point && typeof point === 'object' && point.source === 'deadSector' ? { ...point, source: 'imageContent' } : point) } };
}
