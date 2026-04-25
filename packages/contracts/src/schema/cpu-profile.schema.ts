import { z } from 'zod';
import { PluginDistributionSchema } from './plugin.schema.js';

export const ServerCpuProfileStateSchema = z.enum([
  'idle',
  'armed',
  'running',
  'completed',
  'interrupted',
  'missing',
  'env-override',
]);

export type ServerCpuProfileState = z.infer<typeof ServerCpuProfileStateSchema>;

export const ServerCpuProfileSourceSchema = z.enum([
  'inactive',
  'guided-capture',
  'env-override',
]);

export type ServerCpuProfileSource = z.infer<typeof ServerCpuProfileSourceSchema>;

export const ServerCpuProfileStatusSchema = z.object({
  state: ServerCpuProfileStateSchema,
  source: ServerCpuProfileSourceSchema,
  distribution: PluginDistributionSchema,
  outputDir: z.string(),
  hostOutputDirHint: z.string().optional(),
  captureId: z.string().nullable(),
  requestedAt: z.number().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  profilePath: z.string().nullable(),
  hostProfilePathHint: z.string().optional(),
  recommendedStartAction: z.string(),
  recommendedFinishAction: z.string(),
});

export type ServerCpuProfileStatus = z.infer<typeof ServerCpuProfileStatusSchema>;

export const ServerCpuProfileHistoryEntrySchema = ServerCpuProfileStatusSchema.extend({
  state: z.enum(['completed', 'interrupted', 'missing']),
});

export type ServerCpuProfileHistoryEntry = z.infer<typeof ServerCpuProfileHistoryEntrySchema>;

